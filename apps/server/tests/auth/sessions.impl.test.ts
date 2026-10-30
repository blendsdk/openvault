import { createHash } from "node:crypto";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionService } from "../../src/auth/sessions.js";
import { loadConfig, type OpenVaultConfig } from "../../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "../helpers/config-fixture.js";

const START = 1_700_000_000_000;
const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

/** Cache that can hold one write open long enough to interleave a revoke. */
class DelayedCache extends MemoryCacheProvider {
  public delayNextSet = false;

  public override async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (this.delayNextSet) {
      this.delayNextSet = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await super.set(key, value, ttlSeconds);
  }
}

let fixture: ConfigFixture;
let config: OpenVaultConfig;
const opened: SessionService[] = [];

function harness(): {
  readonly cache: MemoryCacheProvider;
  readonly sessions: SessionService;
  readonly ttlMs: number;
  advance(milliseconds: number): void;
} {
  const cache = new MemoryCacheProvider({ rootKey: "openvault-session-impl" });
  let now = START;
  const sessions = new SessionService({
    config,
    cache,
    now: () => now,
    sweepIntervalMs: 0,
  });
  opened.push(sessions);
  return {
    cache,
    sessions,
    ttlMs: config.sessionTtlHours * 3_600_000,
    advance(milliseconds: number): void {
      now += milliseconds;
    },
  };
}

function cacheKey(secretId: string): string {
  return `session:${createHash("sha256").update(secretId, "utf8").digest("hex")}`;
}

beforeAll(() => {
  fixture = createConfigFixture();
  config = loadConfig(fixture.env);
});

afterEach(async () => {
  for (const service of opened.splice(0)) {
    await service.destroy();
  }
});

afterAll(() => {
  fixture.cleanup();
});

describe("SessionService implementation", () => {
  it("should revoke every session for one principal and leave another principal alone", async () => {
    const { sessions } = harness();
    const first = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
    const second = await sessions.create({ principalId: PRINCIPAL, authMethod: "oidc" });
    const foreign = await sessions.create({ principalId: OTHER, authMethod: "local" });

    await expect(sessions.revokeAllForPrincipal(PRINCIPAL)).resolves.toBe(2);
    await expect(sessions.get(first.secretId)).resolves.toBeUndefined();
    await expect(sessions.get(second.secretId)).resolves.toBeUndefined();
    await expect(sessions.get(foreign.secretId)).resolves.toEqual(foreign.record);
    await expect(sessions.revokeAllForPrincipal(PRINCIPAL)).resolves.toBe(0);
  });

  it("should return undefined for a malformed rotation and leave the cache untouched", async () => {
    const { sessions, cache } = harness();

    await expect(sessions.rotate("not-a-secret")).resolves.toBeUndefined();
    await expect(sessions.rotate("A".repeat(43))).resolves.toBeUndefined();
    await expect(cache.get("session:missing")).resolves.toBeUndefined();
  });

  it("should drop a session from the list when its cache value disappeared", async () => {
    const { sessions, cache } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await cache.delete(cacheKey(created.secretId));

    await expect(sessions.list(PRINCIPAL)).resolves.toEqual([]);
    await expect(sessions.revoke(created.record.publicId, PRINCIPAL)).resolves.toBe(false);
  });

  it("should remove an expired session during the list scan", async () => {
    const { sessions, advance, ttlMs, cache } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    advance(ttlMs + 1);

    await expect(sessions.list(PRINCIPAL)).resolves.toEqual([]);
    await expect(cache.get(cacheKey(created.secretId))).resolves.toBeUndefined();
  });

  it("should be idempotent when destroyed twice", async () => {
    const { sessions } = harness();
    await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.destroy()).resolves.toBeUndefined();
    await expect(sessions.destroy()).resolves.toBeUndefined();
  });

  it("should return the same rotation to a caller that arrives after the first completes", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    const first = await sessions.rotate(created.secretId);
    const second = await sessions.rotate(created.secretId);

    expect(first).toBeDefined();
    expect(second).toEqual(first);
  });

  it("should expire the rotation receipt", async () => {
    const { sessions, advance } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.rotate(created.secretId)).resolves.toBeDefined();
    advance(10_001);
    await expect(sessions.rotate(created.secretId)).resolves.toBeUndefined();
  });

  it("should report a live rotation receipt and clear it on revoke", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.rotate(created.secretId)).resolves.toBeDefined();
    expect(sessions.hasRecentRotation(created.secretId)).toBe(true);

    await sessions.revoke(created.record.publicId, PRINCIPAL);
    expect(sessions.hasRecentRotation(created.secretId)).toBe(false);
  });

  it("should clear a rotation receipt on demand", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.rotate(created.secretId)).resolves.toBeDefined();
    expect(sessions.hasRecentRotation(created.secretId)).toBe(true);

    sessions.clearRotationReceipt(created.secretId);
    expect(sessions.hasRecentRotation(created.secretId)).toBe(false);
    await expect(sessions.rotate(created.secretId)).resolves.toBeUndefined();
  });

  it("should rotate the current secret without a receipt and invalidate a concurrent receipt", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
    const concurrent = await sessions.rotate(created.secretId);

    const forced = await sessions.rotateCurrent(created.record.publicId, PRINCIPAL);

    expect(forced).toBeDefined();
    expect(concurrent).toBeDefined();
    if (forced === undefined || concurrent === undefined) {
      throw new Error("expected both rotations to produce a session");
    }
    expect(forced.secretId).not.toBe(concurrent.secretId);
    await expect(sessions.get(concurrent.secretId)).resolves.toBeUndefined();
    await expect(sessions.get(forced.secretId)).resolves.toEqual(forced.record);
    expect(sessions.hasRecentRotation(created.secretId)).toBe(false);
    await expect(sessions.rotate(created.secretId)).resolves.toBeUndefined();
  });

  it("should refuse a forced rotation from another principal", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.rotateCurrent(created.record.publicId, OTHER)).resolves.toBeUndefined();
    await expect(sessions.get(created.secretId)).resolves.toEqual(created.record);
  });

  it("should not return a rotation receipt after the session is revoked", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    await expect(sessions.rotate(created.secretId)).resolves.toBeDefined();
    await expect(sessions.revoke(created.record.publicId, PRINCIPAL)).resolves.toBe(true);

    await expect(sessions.rotate(created.secretId)).resolves.toBeUndefined();
  });

  it("should not return a superseded rotation receipt", async () => {
    const { sessions } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
    const first = await sessions.rotate(created.secretId);
    const second = await sessions.rotate(first?.secretId ?? "");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await expect(sessions.rotate(created.secretId)).resolves.toBeUndefined();
    await expect(sessions.rotate(first?.secretId ?? "")).resolves.toEqual(second);
  });

  it("should report the remaining lifetime from the injected clock", async () => {
    const { sessions, advance, ttlMs } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    advance(1_000);

    expect(sessions.remainingSeconds(created.record)).toBe(Math.ceil((ttlMs - 1_000) / 1_000));
  });

  it("should report ownership and expiry through has", async () => {
    const { sessions, advance, ttlMs } = harness();
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    expect(sessions.has(created.record.publicId, PRINCIPAL)).toBe(true);
    expect(sessions.has(created.record.publicId, OTHER)).toBe(false);
    advance(ttlMs + 1);
    expect(sessions.has(created.record.publicId, PRINCIPAL)).toBe(false);
  });

  it("should not resurrect a session when revoke races a rotation", async () => {
    const cache = new DelayedCache({ rootKey: "openvault-session-race", cleanupIntervalMs: 0 });
    let now = START;
    const sessions = new SessionService({
      config,
      cache,
      now: () => now,
      sweepIntervalMs: 0,
    });
    opened.push(sessions);
    const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    cache.delayNextSet = true;
    const rotation = sessions.rotate(created.secretId);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const revoked = await sessions.revoke(created.record.publicId, PRINCIPAL);
    const rotated = await rotation;

    expect(revoked).toBe(true);
    await expect(sessions.get(created.secretId)).resolves.toBeUndefined();
    if (rotated !== undefined) {
      await expect(sessions.get(rotated.secretId)).resolves.toBeUndefined();
    }
    now += 1;
    await expect(sessions.list(PRINCIPAL)).resolves.toEqual([]);
  });
});

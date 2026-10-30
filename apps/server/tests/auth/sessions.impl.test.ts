import { createHash } from "node:crypto";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionService } from "../../src/auth/sessions.js";
import { loadConfig, type OpenVaultConfig } from "../../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "../helpers/config-fixture.js";

const START = 1_700_000_000_000;
const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

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
});

import { createHash } from "node:crypto";
import { isUlid } from "@openvault/core";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type SessionRecord, SessionService } from "../../src/auth/sessions.js";
import { loadConfig, type OpenVaultConfig } from "../../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "../helpers/config-fixture.js";

/**
 * Memory cache that records every key and value it handles.
 *
 * The session service keeps the secret behind a cache key, so the recorder is
 * how the specification test proves that the raw secret never becomes a key and
 * that expiry really removes the stored value.
 */
class RecordingCache extends MemoryCacheProvider {
  public readonly setKeys: string[] = [];
  public readonly setValues = new Map<string, string>();
  public readonly getKeys: string[] = [];
  public readonly deleteKeys: string[] = [];

  public constructor() {
    super({ rootKey: "openvault-session-spec", cleanupIntervalMs: 60_000 });
  }

  public reset(): void {
    this.setKeys.length = 0;
    this.setValues.clear();
    this.getKeys.length = 0;
    this.deleteKeys.length = 0;
  }

  public override async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.setKeys.push(key);
    this.setValues.set(key, JSON.stringify(value));
    await super.set(key, value, ttlSeconds);
  }

  public override async get<T>(key: string): Promise<T | undefined> {
    this.getKeys.push(key);
    return super.get<T>(key);
  }

  public override async delete(key: string): Promise<boolean> {
    this.deleteKeys.push(key);
    return super.delete(key);
  }
}

const START = 1_700_000_000_000;
const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

/** The cache key the session store must derive from a secret. */
function cacheKeyFor(secretId: string): string {
  return `session:${createHash("sha256").update(secretId, "utf8").digest("hex")}`;
}

interface Harness {
  readonly cache: RecordingCache;
  readonly sessions: SessionService;
  readonly ttlMs: number;
  advance(milliseconds: number): void;
}

let fixture: ConfigFixture;
let config: OpenVaultConfig;
const openedServices: SessionService[] = [];

/** Builds one isolated session service with a controllable clock. */
function createHarness(): Harness {
  const cache = new RecordingCache();
  let now = START;
  const sessions = new SessionService({
    config,
    cache,
    now: () => now,
    sweepIntervalMs: 60_000,
  });
  openedServices.push(sessions);
  return {
    cache,
    sessions,
    ttlMs: config.sessionTtlHours * 3_600_000,
    advance(milliseconds: number): void {
      now += milliseconds;
    },
  };
}

/** Narrows a rotation result without an unchecked assertion. */
function requireRotation(
  result: Awaited<ReturnType<SessionService["rotate"]>>,
): NonNullable<Awaited<ReturnType<SessionService["rotate"]>>> {
  if (result === undefined) {
    throw new Error("expected an active session to rotate");
  }
  return result;
}

beforeAll(() => {
  fixture = createConfigFixture();
  config = loadConfig(fixture.env);
});

afterEach(async () => {
  for (const service of openedServices.splice(0)) {
    await service.destroy();
  }
});

afterAll(() => {
  fixture.cleanup();
});

describe("session creation", () => {
  it("should return a 32-byte secret and a public record when a session is created", async () => {
    const harness = createHarness();

    const { secretId, record } = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });

    expect(secretId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secretId, "base64url")).toHaveLength(32);
    expect(record.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(record.publicId)).toBe(true);
    expect(record.publicId).not.toBe(secretId);
    expect(record.principalId).toBe(PRINCIPAL);
    expect(record.authMethod).toBe("local");
    expect(record.createdAt).toBe(START);
    expect(record.expiresAt).toBe(START + harness.ttlMs);
    expect(typeof record.csrfToken).toBe("string");
    expect(record.csrfToken.length).toBeGreaterThanOrEqual(32);
  });

  it("should generate distinct secrets, public identifiers, and CSRF tokens per session", async () => {
    const harness = createHarness();

    const first = await harness.sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
    const second = await harness.sessions.create({ principalId: PRINCIPAL, authMethod: "local" });

    expect(first.secretId).not.toBe(second.secretId);
    expect(first.record.publicId).not.toBe(second.record.publicId);
    expect(first.record.csrfToken).not.toBe(second.record.csrfToken);
  });
});

describe("session lookup", () => {
  it("should resolve a record through the hashed secret key and never store the raw secret", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "oidc",
    });
    const key = cacheKeyFor(created.secretId);
    expect(harness.cache.setKeys).toContain(key);
    for (const writtenKey of harness.cache.setKeys) {
      expect(writtenKey).not.toContain(created.secretId);
    }
    const stored = harness.cache.setValues.get(key);
    expect(stored).toBeDefined();
    if (stored !== undefined) {
      expect(stored).not.toContain(created.secretId);
    }
    harness.cache.reset();

    const found = await harness.sessions.get(created.secretId);

    expect(found).toEqual(created.record);
    expect(harness.cache.getKeys).toContain(key);
    for (const lookupKey of harness.cache.getKeys) {
      expect(lookupKey).not.toContain(created.secretId);
    }
  });

  it("should return undefined for a malformed secret and never look it up under a non-hash key", async () => {
    const harness = createHarness();
    await harness.sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
    harness.cache.reset();

    const malformedSecrets = [
      "",
      "not-a-session-secret",
      Buffer.alloc(31, 1).toString("base64url"),
      Buffer.alloc(33, 1).toString("base64url"),
      `${"A".repeat(43)}=`,
      "!".repeat(43),
    ];

    for (const malformed of malformedSecrets) {
      await expect(harness.sessions.get(malformed)).resolves.toBeUndefined();
    }
    for (const key of harness.cache.getKeys) {
      expect(key).toMatch(/^session:[0-9a-f]{64}$/);
    }
  });

  it("should return undefined and delete the entry when the absolute expiry has passed", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });
    const key = cacheKeyFor(created.secretId);

    harness.advance(harness.ttlMs + 1);
    harness.cache.reset();

    await expect(harness.sessions.get(created.secretId)).resolves.toBeUndefined();
    expect(harness.cache.deleteKeys).toContain(key);
    await expect(harness.cache.get(key)).resolves.toBeUndefined();
  });
});

describe("session rotation", () => {
  it("should issue a new secret and CSRF token while keeping the public identity and expiry", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });

    const rotated = requireRotation(await harness.sessions.rotate(created.secretId));

    expect(rotated.secretId).not.toBe(created.secretId);
    expect(rotated.record.publicId).toBe(created.record.publicId);
    expect(rotated.record.principalId).toBe(created.record.principalId);
    expect(rotated.record.createdAt).toBe(created.record.createdAt);
    expect(rotated.record.expiresAt).toBe(created.record.expiresAt);
    expect(rotated.record.authMethod).toBe(created.record.authMethod);
    expect(rotated.record.csrfToken).not.toBe(created.record.csrfToken);
    await expect(harness.sessions.get(created.secretId)).resolves.toBeUndefined();
    await expect(harness.sessions.get(rotated.secretId)).resolves.toEqual(rotated.record);
    await expect(harness.cache.get(cacheKeyFor(created.secretId))).resolves.toBeUndefined();
  });

  it("should share one rotation between concurrent callers and create exactly one new entry", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });
    harness.cache.reset();

    const [first, second] = await Promise.all([
      harness.sessions.rotate(created.secretId),
      harness.sessions.rotate(created.secretId),
    ]);
    const rotatedFirst = requireRotation(first);
    const rotatedSecond = requireRotation(second);

    expect(rotatedFirst.secretId).toBe(rotatedSecond.secretId);
    expect(rotatedFirst.record).toEqual(rotatedSecond.record);
    const writtenSessionKeys = harness.cache.setKeys.filter((key) => key.startsWith("session:"));
    expect(writtenSessionKeys).toHaveLength(1);
    await expect(harness.sessions.get(created.secretId)).resolves.toBeUndefined();
    await expect(harness.sessions.get(rotatedFirst.secretId)).resolves.toEqual(rotatedFirst.record);
  });
});

describe("session listing", () => {
  it("should return only live sessions for the principal sorted by creation time", async () => {
    const harness = createHarness();
    const expired = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });
    harness.advance(harness.ttlMs + 1);

    const firstLive = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "oidc",
    });
    harness.advance(1_000);
    const secondLive = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });
    const foreign = await harness.sessions.create({
      principalId: OTHER_PRINCIPAL,
      authMethod: "local",
    });

    const listed = await harness.sessions.list(PRINCIPAL);

    expect(listed.map((entry: SessionRecord) => entry.publicId)).toEqual([
      firstLive.record.publicId,
      secondLive.record.publicId,
    ]);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(expired.secretId);
    expect(serialized).not.toContain(firstLive.secretId);
    expect(serialized).not.toContain(secondLive.secretId);
    expect(serialized).not.toContain(foreign.secretId);
    for (const entry of listed) {
      expect(entry.principalId).toBe(PRINCIPAL);
      expect(entry).not.toHaveProperty("secretId");
    }
  });
});

describe("session revocation", () => {
  it("should revoke an owned session and remove it from every lookup", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });

    await expect(harness.sessions.revoke(created.record.publicId, PRINCIPAL)).resolves.toBe(true);
    await expect(harness.sessions.get(created.secretId)).resolves.toBeUndefined();
    await expect(harness.sessions.rotate(created.secretId)).resolves.toBeUndefined();
    const listed = await harness.sessions.list(PRINCIPAL);
    expect(listed.map((entry: SessionRecord) => entry.publicId)).not.toContain(
      created.record.publicId,
    );
    await expect(harness.sessions.revoke(created.record.publicId, PRINCIPAL)).resolves.toBe(false);
  });

  it("should refuse a revoke from another principal and keep the session alive", async () => {
    const harness = createHarness();
    const created = await harness.sessions.create({
      principalId: PRINCIPAL,
      authMethod: "local",
    });

    await expect(harness.sessions.revoke(created.record.publicId, OTHER_PRINCIPAL)).resolves.toBe(
      false,
    );
    await expect(harness.sessions.get(created.secretId)).resolves.toEqual(created.record);
    const listed = await harness.sessions.list(PRINCIPAL);
    expect(listed.map((entry: SessionRecord) => entry.publicId)).toContain(created.record.publicId);
  });
});

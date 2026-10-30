import { createHash } from "node:crypto";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "../../src/auth/oidc/return-to.js";
import { OidcStateStore } from "../../src/auth/oidc/state.js";

const BASE = new URL("https://vault.example.com");
const STATE = {
  codeVerifier: "verifier",
  nonce: "nonce",
  returnTo: "/projects",
};

class RecordingCache extends MemoryCacheProvider {
  public readonly keys: string[] = [];

  public constructor() {
    super({ rootKey: "openvault-oidc-impl", cleanupIntervalMs: 0 });
  }

  public override async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.keys.push(key);
    await super.set(key, value, ttlSeconds);
  }
}

describe("sanitizeReturnTo", () => {
  it("should keep a same-origin path and query", () => {
    expect(sanitizeReturnTo("/projects?tab=secrets", BASE)).toBe("/projects?tab=secrets");
  });

  it("should reject protocol-relative, absolute, backslash, and control values", () => {
    for (const value of [
      "//evil.example",
      "https://evil.example",
      "/\\evil",
      "/ok\r\nSet-Cookie: x",
      "/ok\u0000",
    ]) {
      expect(sanitizeReturnTo(value, BASE)).toBe("/");
    }
  });

  it("should reject non-strings, empty values, and values over 2048 characters", () => {
    for (const value of [undefined, null, 42, "", `/${"a".repeat(2048)}`]) {
      expect(sanitizeReturnTo(value, BASE)).toBe("/");
    }
  });
});

describe("OidcStateStore", () => {
  let cache: RecordingCache | undefined;
  let store: OidcStateStore | undefined;

  afterEach(async () => {
    store?.destroy();
    await cache?.shutdown();
    cache = undefined;
    store = undefined;
  });

  it("should store under a hashed key and consume the state once", async () => {
    cache = new RecordingCache();
    store = new OidcStateStore({ cache });
    const expectedKey = `oidc:state:${createHash("sha256").update("state-1").digest("hex")}`;

    await store.put("state-1", STATE);

    expect(cache.keys).toContain(expectedKey);
    await expect(store.take("state-1")).resolves.toEqual(STATE);
    await expect(store.take("state-1")).resolves.toBeUndefined();
  });

  it("should reject a concurrent second take", async () => {
    cache = new RecordingCache();
    store = new OidcStateStore({ cache });
    await store.put("state-2", STATE);

    const [first, second] = await Promise.all([store.take("state-2"), store.take("state-2")]);

    expect([first, second].filter((value) => value !== undefined)).toHaveLength(1);
  });
});

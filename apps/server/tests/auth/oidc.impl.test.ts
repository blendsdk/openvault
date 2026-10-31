import { createHash } from "node:crypto";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterEach, describe, expect, it } from "vitest";
import { OidcClient } from "../../src/auth/oidc/client.js";
import { OidcUnavailableError } from "../../src/auth/oidc/errors.js";
import { sanitizeReturnTo } from "../../src/auth/oidc/return-to.js";
import { OidcStateStore } from "../../src/auth/oidc/state.js";

const BASE = new URL("https://vault.example.com");
const STATE = {
  codeVerifier: "verifier",
  nonce: "nonce",
  returnTo: "/projects",
  bindingHash: "binding-hash",
};

const OIDC_CONFIG = {
  issuer: new URL("https://issuer.example/"),
  clientId: "client",
  clientSecret: "secret",
  redirectUrl: new URL("https://vault.example.com/v1/auth/callback"),
  allowedDomains: [],
};

const DISCOVERY = {
  issuer: "https://issuer.example/",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  userinfo_endpoint: "https://issuer.example/userinfo",
  jwks_uri: "https://issuer.example/jwks",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
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
      "/.//evil.example",
      "/..//evil.example",
      "/%2e%2e//evil.example",
      "/a/../..//evil.example",
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

describe("OidcClient discovery", () => {
  it("should cache discovery for one hour", async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      if (String(input).includes(".well-known/openid-configuration")) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OidcClient({ config: OIDC_CONFIG, fetch, now: () => now });

    await client.buildAuthorizationUrl({});
    await client.buildAuthorizationUrl({});
    expect(calls).toBe(1);

    now += 3_600_001;
    await client.buildAuthorizationUrl({});
    expect(calls).toBe(2);
  });

  it("should map a stalled discovery to an unavailable error", async () => {
    const fetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const client = new OidcClient({ config: OIDC_CONFIG, fetch });

    await expect(client.buildAuthorizationUrl({})).rejects.toBeInstanceOf(OidcUnavailableError);
  }, 10_000);
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

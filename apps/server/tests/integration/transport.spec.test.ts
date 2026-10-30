import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import type { OpenVaultConfig } from "../../src/config/index.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { CidrMatcher, createTrustProxy, normalizePeerAddress } from "../../src/transport/proxy.js";
import { isAllowedPath, normalizeRequestPath } from "../../src/transport/scope.js";
import {
  type SecureWebApplication,
  TRANSPORT_SETTINGS,
  type TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial, TlsMaterialError } from "../../src/transport/tls.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    statusCode: z.number(),
    requestId: z.string().optional(),
    path: z.string().optional(),
  }),
});

const healthBody = z.object({ health: z.boolean(), timestamp: z.number() });

function externalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        String(entry.family) === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

const trustedHost = externalIpv4();

function trustedProxyCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

function trustedHostOption(): { host: string } {
  return { host: trustedHost ?? "127.0.0.1" };
}

interface RunningApp {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
}

function databaseFor(config: OpenVaultConfig): PostgreSQLDatabase {
  return new PostgreSQLDatabase({
    ...config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
}

async function startApp(environment: ServerEnvironment): Promise<RunningApp> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = databaseFor(environment.config);
  const app = await createTestApplication(environment.config, {
    database,
    tls,
    keyring,
  });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return { app, handle, environment };
}

function envelope(response: TestResponse) {
  return errorEnvelope.parse(response.json);
}

let running: RunningApp;

beforeAll(async () => {
  running = await startApp(createServerEnvironment({ OPENVAULT_PROXY_CIDRS: trustedProxyCidrs() }));
}, 30_000);

afterAll(async () => {
  await running.handle.stop();
  running.environment.cleanup();
});

describe("ST-15 HTTPS admin listener", () => {
  it("serves health over TLS and rejects a plaintext request", async () => {
    const response = await testRequest({
      port: running.handle.adminPort,
      path: "/health",
      ca: running.environment.tls.caPem,
      servername: "localhost",
    });

    expect(response.status).toBe(200);
    expect(healthBody.parse(response.json).health).toBe(true);
    await expectNoPlaintext(running.handle.adminPort);
  });
});

describe("ST-16 direct admin rejection", () => {
  it.skipIf(trustedHost === undefined)(
    "returns a 403 envelope for a peer outside the proxy CIDRs",
    async () => {
      const restricted = createServerEnvironment({ OPENVAULT_PROXY_CIDRS: "192.0.2.0/24" });
      const app = await startApp(restricted);
      try {
        const response = await testRequest({
          ...trustedHostOption(),
          port: app.handle.adminPort,
          path: "/v1/missing",
          ca: restricted.tls.caPem,
          servername: "localhost",
        });

        expect(response.status).toBe(403);
        expect(envelope(response).error.code).toBe("FORBIDDEN");
        expect(envelope(response).error.requestId).toBeTruthy();
      } finally {
        await app.handle.stop();
        restricted.cleanup();
      }
    },
    30_000,
  );
});

describe("ST-17 loopback health access", () => {
  it("allows health and readiness but not general admin routes", async () => {
    const tls = running.environment.tls;
    const health = await testRequest({
      port: running.handle.adminPort,
      path: "/health",
      ca: tls.caPem,
      servername: "localhost",
    });
    const ready = await testRequest({
      port: running.handle.adminPort,
      path: "/ready",
      ca: tls.caPem,
      servername: "localhost",
    });
    const missing = await testRequest({
      port: running.handle.adminPort,
      path: "/v1/missing",
      ca: tls.caPem,
      servername: "localhost",
    });

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(missing.status).toBe(403);
    expect(envelope(missing).error.code).toBe("FORBIDDEN");
  });
});

describe("ST-18 agent mTLS listener", () => {
  it("rejects missing and untrusted client certificates and accepts the trusted one", async () => {
    const tls = running.environment.tls;
    const base = {
      port: running.handle.agentPort,
      path: "/health",
      ca: tls.caPem,
      servername: "localhost",
    };

    await expect(testRequest(base)).rejects.toThrow();
    await expect(
      testRequest({
        ...base,
        cert: tls.wrongClientCertPem,
        key: tls.wrongClientKeyPem,
      }),
    ).rejects.toThrow();

    const accepted = await testRequest({
      ...base,
      cert: tls.clientCertPem,
      key: tls.clientKeyPem,
    });
    expect(accepted.status).toBe(200);
    expect(healthBody.parse(accepted.json).health).toBe(true);
  });
});

describe("ST-19 listener scope", () => {
  it.skipIf(trustedHost === undefined)(
    "denies agent and non-/v1 paths on the admin listener",
    async () => {
      const tls = running.environment.tls;
      const paths = [
        "/v1/AGENT/ping",
        "/v1/%61gent/ping",
        "//v1//agent/ping",
        "/v1/agent/",
        "https://example.com/v1/agent/ping",
        "/v2/secrets/x",
        "/api/v1/secrets/x",
      ];

      for (const path of paths) {
        const response = await testRequest({
          ...trustedHostOption(),
          port: running.handle.adminPort,
          path,
          ca: tls.caPem,
          servername: "localhost",
        });
        expect(response.status, path).toBe(404);
        expect(envelope(response).error.code, path).toBe("NOT_FOUND");
      }
    },
  );

  it("denies admin routes on the agent listener but allows agent health", async () => {
    const tls = running.environment.tls;
    const denied = await testRequest({
      port: running.handle.agentPort,
      path: "/v1/ready",
      ca: tls.caPem,
      cert: tls.clientCertPem,
      key: tls.clientKeyPem,
      servername: "localhost",
    });
    const health = await testRequest({
      port: running.handle.agentPort,
      path: "/health",
      ca: tls.caPem,
      cert: tls.clientCertPem,
      key: tls.clientKeyPem,
      servername: "localhost",
    });

    expect(denied.status).toBe(404);
    expect(envelope(denied).error.code).toBe("NOT_FOUND");
    expect(health.status).toBe(200);
  });
});

describe("ST-20 proxy matcher", () => {
  it("matches IPv4, IPv4-mapped, and IPv6 peers and rejects mixed families", () => {
    const matcher = new CidrMatcher([
      { address: "10.0.0.0", prefix: 8, family: "ipv4" },
      { address: "2001:db8::", prefix: 32, family: "ipv6" },
    ]);

    expect(matcher.contains("10.1.2.3")).toBe(true);
    expect(matcher.contains("::ffff:10.1.2.3")).toBe(true);
    expect(matcher.contains("11.1.2.3")).toBe(false);
    expect(matcher.contains("2001:db8::1")).toBe(true);
    expect(matcher.contains("2001:db9::1")).toBe(false);
    expect(matcher.contains("not-an-ip")).toBe(false);
    expect(matcher.contains(undefined)).toBe(false);
    expect(normalizePeerAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePeerAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizePeerAddress("bad")).toBeUndefined();

    const trust = createTrustProxy(
      new CidrMatcher([{ address: "10.0.0.0", prefix: 8, family: "ipv4" }]),
    );
    expect(trust("10.1.2.3")).toBe(true);
    expect(trust("11.1.2.3")).toBe(false);
  });

  it("normalises path variants and rejects malformed encodings", () => {
    expect(normalizeRequestPath("/v1/AGENT/ping")).toBe("/v1/agent/ping");
    expect(normalizeRequestPath("/v1/%61gent/ping")).toBe("/v1/agent/ping");
    expect(normalizeRequestPath("//v1//agent/ping")).toBe("/v1/agent/ping");
    expect(normalizeRequestPath("/v1/agent/")).toBe("/v1/agent");
    expect(normalizeRequestPath("https://host/v1/agent/ping?x=1")).toBe("/v1/agent/ping");
    expect(() => normalizeRequestPath("/v1/%ZZ")).toThrow();
    expect(isAllowedPath("admin", "/health")).toBe(true);
    expect(isAllowedPath("admin", "/v1/agent")).toBe(false);
    expect(isAllowedPath("admin", "/v2/secrets")).toBe(false);
    expect(isAllowedPath("agent", "/v1/agent/ping")).toBe(true);
    expect(isAllowedPath("agent", "/v1/ready")).toBe(false);
    expect(() => normalizeRequestPath("/v1/x/../agent/ping")).toThrow();
  });
});

describe("ST-21 security headers", () => {
  it.skipIf(trustedHost === undefined)(
    "sets CSP, baseline headers, no-store, and no CORS wildcard",
    async () => {
      const tls = running.environment.tls;
      const response = await testRequest({
        ...trustedHostOption(),
        port: running.handle.adminPort,
        path: "/v1/missing",
        headers: { origin: "https://evil.example.com" },
        ca: tls.caPem,
        servername: "localhost",
      });

      expect(response.status).toBe(404);
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBeTruthy();
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );
});

describe("ST-22 body limits", () => {
  it.skipIf(trustedHost === undefined)(
    "enforces the fixed 64 KiB and 128 KiB guardrails",
    async () => {
      const tls = running.environment.tls;
      const oversizedSecret = await postJson(
        running.handle.adminPort,
        "/v1/secrets/x",
        jsonObjectOfBytes(65_537),
        tls.caPem,
        trustedHost,
      );
      const maxSecret = await postJson(
        running.handle.adminPort,
        "/v1/secrets/x",
        jsonObjectOfBytes(65_536),
        tls.caPem,
        trustedHost,
      );
      const oversizedCertificate = await postJson(
        running.handle.adminPort,
        "/v1/certificates/x",
        jsonObjectOfBytes(131_073),
        tls.caPem,
        trustedHost,
      );

      expect(oversizedSecret.status).toBe(413);
      expect(envelope(oversizedSecret).error.code).toBe("payload_too_large");
      expect(maxSecret.status).toBe(404);
      expect(oversizedCertificate.status).toBe(413);
    },
  );
});

describe("ST-23 form rejection", () => {
  it.skipIf(trustedHost === undefined)("rejects URL-encoded bodies under /v1", async () => {
    const tls = running.environment.tls;
    const response = await testRequest({
      ...trustedHostOption(),
      port: running.handle.adminPort,
      path: "/v1/secrets/x",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
      ca: tls.caPem,
      servername: "localhost",
    });

    expect(response.status).toBe(415);
    expect(envelope(response).error.code).toBe("unsupported_media_type");

    const text = await testRequest({
      ...trustedHostOption(),
      port: running.handle.adminPort,
      path: "/v1/secrets/x",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a".repeat(100 * 1_024),
      ca: tls.caPem,
      servername: "localhost",
    });
    expect(text.status).toBe(415);
  });
});

describe("ST-24 error envelopes", () => {
  it.skipIf(trustedHost === undefined)(
    "uses the WebAFX envelope for malformed and unknown requests",
    async () => {
      const tls = running.environment.tls;
      const malformed = await postJson(
        running.handle.adminPort,
        "/v1/secrets/x",
        "{not json",
        tls.caPem,
        trustedHost,
      );
      const unknown = await testRequest({
        ...trustedHostOption(),
        port: running.handle.adminPort,
        path: "/v1/unknown",
        ca: tls.caPem,
        servername: "localhost",
      });

      expect(malformed.status).toBe(400);
      expect(envelope(malformed).error.code).toBe("invalid_json");
      expect(unknown.status).toBe(404);
      expect(envelope(unknown).error.code).toBe("NOT_FOUND");
      expect(envelope(unknown).error.requestId).toBeTruthy();
    },
  );
});

describe("ST-25 transport settings", () => {
  it("uses the documented timeouts and connection caps", () => {
    expect(TRANSPORT_SETTINGS.admin).toEqual({
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 15_000,
      maxConnections: 1_024,
    });
    expect(TRANSPORT_SETTINGS.agent.maxConnections).toBe(512);
    expect(running.handle.adminServer.headersTimeout).toBe(10_000);
    expect(running.handle.adminServer.requestTimeout).toBe(30_000);
    expect(running.handle.adminServer.keepAliveTimeout).toBe(15_000);
    expect(running.handle.adminServer.maxConnections).toBe(1_024);
    expect(running.handle.agentServer.maxConnections).toBe(512);
  });
});

describe("ST-26 no plaintext listener", () => {
  it("rejects plaintext on both bound ports", async () => {
    await expectNoPlaintext(running.handle.adminPort);
    await expectNoPlaintext(running.handle.agentPort);
  });
});

describe("ST-39 TLS material validation", () => {
  it("accepts matching material", () => {
    const material = TlsMaterial.load(running.environment.config);

    expect(material.certPem).toContain("BEGIN CERTIFICATE");
    expect(() => material.checkReady()).not.toThrow();
  });

  it("rejects a mismatched key, a non-CA anchor, and malformed PEM", () => {
    const environment = createServerEnvironment();
    const mismatch = createServerEnvironment({
      OPENVAULT_TLS_KEY: environment.tls.mismatchedKeyPath,
    });
    const nonCa = createServerEnvironment({
      OPENVAULT_INTERNAL_CA: environment.tls.leafOnlyCertPath,
    });
    const malformedPath = join(environment.tls.directory, "malformed.pem");
    writeFileSync(malformedPath, "not a certificate\n", { mode: 0o600 });
    const malformed = createServerEnvironment({ OPENVAULT_TLS_CERT: malformedPath });

    try {
      expect(() => TlsMaterial.load(mismatch.config)).toThrow(TlsMaterialError);
      expect(() => TlsMaterial.load(nonCa.config)).toThrow(TlsMaterialError);
      expect(() => TlsMaterial.load(malformed.config)).toThrow(TlsMaterialError);
    } finally {
      for (const item of [environment, mismatch, nonCa, malformed]) {
        item.cleanup();
      }
    }
  });

  it("rejects material outside its validity window", () => {
    const environment = createServerEnvironment();
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
      expect(() => TlsMaterial.load(environment.config)).toThrow(TlsMaterialError);
    } finally {
      vi.useRealTimers();
      environment.cleanup();
    }
  });
});

async function expectNoPlaintext(port: number): Promise<void> {
  let response: TestResponse | undefined;
  try {
    response = await testRequest({ port, path: "/health", plaintext: true });
  } catch {
    return;
  }
  expect(response.status).not.toBe(200);
}

function jsonObjectOfBytes(bytes: number): string {
  return `{"a":"${"a".repeat(Math.max(0, bytes - 8))}"}`;
}

async function postJson(
  port: number,
  path: string,
  body: string,
  ca: string,
  host: string | undefined,
): Promise<TestResponse> {
  return testRequest({
    ...(host === undefined ? {} : { host }),
    port,
    path,
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ca,
    servername: "localhost",
  });
}

describe("transport factory contract", () => {
  it("does not expose a production plaintext starter", async () => {
    await expect(running.app.start()).rejects.toThrow(/startTransport/i);
  });
});

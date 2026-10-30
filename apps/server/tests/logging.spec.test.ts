import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../src/app.js";
import {
  createLoggerProvider,
  sanitizeLogArgs,
  sanitizeLogMessage,
} from "../src/observability/logger.js";
import { KeyringProvider } from "../src/security/keyring.js";
import { TlsMaterial } from "../src/transport/tls.js";
import { testRequest } from "./integration/helpers/https.js";
import { MemoryDestination } from "./integration/helpers/memory-destination.js";
import { createServerEnvironment } from "./integration/helpers/server-environment.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    statusCode: z.number(),
    requestId: z.string().optional(),
  }),
});

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

function trustedCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

describe("log redaction", () => {
  it("masks the documented top-level, one-level, and request-body paths", async () => {
    const environment = createServerEnvironment();
    const destination = new MemoryDestination();
    const provider = createLoggerProvider(environment.config, destination);
    try {
      await provider.info("redaction probe", {
        token: "secret-token",
        value: "secret-value",
        password: "secret-password",
        privateKey: "secret-private-key",
        authorization: "Bearer secret-authorization",
        cookie: "session=secret-cookie",
        "set-cookie": "session=secret-set-cookie",
        req: { body: { token: "secret-body-token" } },
        nested: { token: "secret-nested-token" },
      });
      await provider.shutdown();

      const output = destination.lines().join("\n");
      for (const secret of [
        "secret-token",
        "secret-value",
        "secret-password",
        "secret-private-key",
        "secret-authorization",
        "secret-cookie",
        "secret-set-cookie",
        "secret-body-token",
        "secret-nested-token",
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("[Redacted]");
    } finally {
      environment.cleanup();
    }
  });
});

describe("request correlation", () => {
  let app: Awaited<ReturnType<typeof createTestApplication>>;
  let environment: ReturnType<typeof createServerEnvironment>;
  let handle: Awaited<ReturnType<typeof app.startTransport>>;
  let destination: MemoryDestination;

  beforeAll(async () => {
    environment = createServerEnvironment({ OPENVAULT_PROXY_CIDRS: trustedCidrs() });
    destination = new MemoryDestination();
    const keyring = await KeyringProvider.load(environment.keyringPath);
    const tls = TlsMaterial.load(environment.config);
    const database = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    app = await createTestApplication(environment.config, {
      database,
      tls,
      keyring,
      readinessProbes: [],
      loggerDestination: destination,
    });
    handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  }, 30_000);

  afterAll(async () => {
    await handle.stop();
    environment.cleanup();
  });

  it("correlates a 403 rejection and logs it once", async () => {
    const tls = environment.tls;
    const response = await testRequest({
      port: handle.adminPort,
      path: "/v1/missing",
      ca: tls.caPem,
      servername: "localhost",
    });
    const parsed = errorEnvelope.parse(response.json);
    const header = response.headers["x-request-id"];

    expect(response.status).toBe(403);
    expect(typeof header).toBe("string");
    expect(parsed.error.requestId).toBe(header);
    const rejected = destination.entries().filter((entry) => entry.msg === "request rejected");
    expect(rejected.filter((entry) => entry.requestId === parsed.error.requestId)).toHaveLength(1);
  });

  it.skipIf(trustedHost === undefined)(
    "correlates 413 and 415 rejections and logs each once",
    async () => {
      const tls = environment.tls;
      const responses = [
        await testRequest({
          host: trustedHost ?? "127.0.0.1",
          port: handle.adminPort,
          path: "/v1/secrets/x",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"a":"${"a".repeat(65_529)}"}`,
          ca: tls.caPem,
          servername: "localhost",
        }),
        await testRequest({
          host: trustedHost ?? "127.0.0.1",
          port: handle.adminPort,
          path: "/v1/secrets/x",
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "a=b",
          ca: tls.caPem,
          servername: "localhost",
        }),
      ];

      expect(responses.map((response) => response.status)).toEqual([413, 415]);
      const requestIds: string[] = [];
      for (const response of responses) {
        const parsed = errorEnvelope.parse(response.json);
        const header = response.headers["x-request-id"];
        expect(typeof header).toBe("string");
        expect(parsed.error.requestId).toBe(header);
        requestIds.push(parsed.error.requestId ?? "");
      }

      const rejected = destination.entries().filter((entry) => entry.msg === "request rejected");
      for (const requestId of requestIds) {
        expect(rejected.filter((entry) => entry.requestId === requestId)).toHaveLength(1);
      }
    },
  );
});

describe("log sanitization", () => {
  it("should strip the query string from a request-log message and keep the path", () => {
    const message = sanitizeLogMessage("GET /v1/auth/callback?code=abc&state=xyz 200 4ms");

    expect(message).not.toContain("abc");
    expect(message).not.toContain("xyz");
    expect(message).toBe("GET /v1/auth/callback 200 4ms");
  });

  it("should leave messages without the request-log shape unchanged", () => {
    for (const message of [
      "authentication failed",
      "GET /ready 200 6ms",
      "/v1/auth/callback?code=abc",
    ]) {
      expect(sanitizeLogMessage(message)).toBe(message);
    }
  });

  it("should strip the query string from an object argument with a string url", () => {
    const args = [{ url: "/v1/auth/callback?code=abc&state=xyz" }];
    const sanitized = sanitizeLogArgs(args);

    expect(sanitized).toEqual([{ url: "/v1/auth/callback" }]);
    expect(args).toEqual([{ url: "/v1/auth/callback?code=abc&state=xyz" }]);
  });

  it("should sanitize string arguments and keep non-string arguments", () => {
    const sanitized = sanitizeLogArgs([
      "GET /v1/auth/callback?code=abc&state=xyz 200 4ms",
      42,
      null,
      true,
    ]);

    expect(sanitized[0]).toBe("GET /v1/auth/callback 200 4ms");
    expect(sanitized.slice(1)).toEqual([42, null, true]);
  });

  it("should not recurse into nested objects", () => {
    const args = [{ inner: { url: "/v1/auth/callback?code=abc" } }];
    const sanitized = sanitizeLogArgs(args);

    expect(sanitized).toEqual([{ inner: { url: "/v1/auth/callback?code=abc" } }]);
  });
});

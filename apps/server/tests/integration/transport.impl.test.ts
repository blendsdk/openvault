import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { BaseController, type RouteDefinition } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApplication, createTestApplication } from "../../src/app.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), statusCode: z.number() }),
});

const echoEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    ip: z.string().nullable(),
    forwardedFor: z.string().nullable(),
    realIp: z.string().nullable(),
    body: z.unknown(),
  }),
});

/** Test-only controller that exposes what the request boundary left behind. */
class EchoController extends BaseController {
  public routes(): RouteDefinition[] {
    const handle = async (req: Request, res: Response): Promise<void> => {
      this.ok(res, {
        ip: req.ip ?? null,
        forwardedFor: req.headers["x-forwarded-for"] ?? null,
        realIp: req.headers["x-real-ip"] ?? null,
        body: req.body ?? null,
      });
    };
    return [this.route().get("/test").handle(handle), this.route().post("/test").handle(handle)];
  }
}

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

interface RunningApp {
  readonly app: Awaited<ReturnType<typeof createTestApplication>>;
  readonly adminPort: number;
  readonly agentPort: number;
  readonly stop: () => Promise<void>;
  readonly environment: ServerEnvironment;
}

async function start(environment: ServerEnvironment): Promise<RunningApp> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, {
    database,
    tls,
    keyring,
  });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return {
    app,
    adminPort: handle.adminPort,
    agentPort: handle.agentPort,
    stop: handle.stop,
    environment,
  };
}

function trustedCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

let running: RunningApp;

beforeAll(async () => {
  running = await start(createServerEnvironment({ OPENVAULT_PROXY_CIDRS: trustedCidrs() }));
}, 30_000);

afterAll(async () => {
  await running.stop();
  running.environment.cleanup();
});

function bodyOfBytes(bytes: number): string {
  return `{"a":"${"a".repeat(Math.max(0, bytes - 8))}"}`;
}

describe("body parser order", () => {
  it("parses a chunked body once and still applies the secret limit", async () => {
    const tls = running.environment.tls;
    const oversized = await testRequest({
      ...(trustedHost === undefined ? {} : { host: trustedHost }),
      port: running.adminPort,
      path: "/v1/secrets/x",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyOfBytes(65_537),
      chunked: true,
      ca: tls.caPem,
      servername: "localhost",
    });
    const accepted = await testRequest({
      ...(trustedHost === undefined ? {} : { host: trustedHost }),
      port: running.adminPort,
      path: "/v1/secrets/x",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyOfBytes(65_536),
      chunked: true,
      ca: tls.caPem,
      servername: "localhost",
    });

    expect(oversized.status).toBe(413);
    expect(errorEnvelope.parse(oversized.json).error.code).toBe("payload_too_large");
    expect(accepted.status).toBe(404);
  });

  it("rejects an encoded slash that would otherwise change the scope", async () => {
    const tls = running.environment.tls;
    const response = await testRequest({
      ...(trustedHost === undefined ? {} : { host: trustedHost }),
      port: running.adminPort,
      path: "/%2Fv1%2Fagent%2Fping",
      ca: tls.caPem,
      servername: "localhost",
    });

    expect(response.status).toBe(404);
    expect(errorEnvelope.parse(response.json).error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed percent encoding at the live listener", async () => {
    const tls = running.environment.tls;
    const response = await testRequest({
      ...(trustedHost === undefined ? {} : { host: trustedHost }),
      port: running.adminPort,
      path: "/v1/%ZZ",
      ca: tls.caPem,
      servername: "localhost",
    });

    expect(response.status).toBe(400);
    expect(errorEnvelope.parse(response.json).error.code).toBe("BAD_REQUEST");
  });
});

describe("forwarded headers", () => {
  it.skipIf(trustedHost === undefined)(
    "strips agent forwarded headers and honours them on a trusted admin peer",
    async () => {
      const environment = createServerEnvironment({
        OPENVAULT_PROXY_CIDRS: trustedCidrs(),
      });
      const keyring = await KeyringProvider.load(environment.keyringPath);
      const tls = TlsMaterial.load(environment.config);
      const database = new PostgreSQLDatabase({
        ...environment.config.database,
        poolConfig: { connectionTimeoutMillis: 2_000 },
        enableGracefulShutdown: false,
      });
      const app = createApplication(environment.config, { database, tls, keyring });
      app.registerController("/v1", EchoController);
      app.registerController("/v1/agent", EchoController);
      await app.prepare();
      const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });

      try {
        const admin = await testRequest({
          host: trustedHost ?? "127.0.0.1",
          port: handle.adminPort,
          path: "/v1/test",
          headers: {
            "x-forwarded-for": "203.0.113.9",
            "x-real-ip": "203.0.113.10",
          },
          ca: tls.caPem,
          servername: "localhost",
        });
        const adminData = echoEnvelope.parse(admin.json).data;
        expect(adminData.ip).toBe("203.0.113.9");

        const posted = await testRequest({
          host: trustedHost ?? "127.0.0.1",
          port: handle.adminPort,
          path: "/v1/test",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "plain" }),
          ca: tls.caPem,
          servername: "localhost",
        });
        expect(echoEnvelope.parse(posted.json).data.body).toEqual({ value: "plain" });

        const agent = await testRequest({
          host: trustedHost ?? "127.0.0.1",
          port: handle.agentPort,
          path: "/v1/agent/test",
          headers: {
            "x-forwarded-for": "203.0.113.9",
            "x-real-ip": "203.0.113.10",
          },
          cert: environment.tls.clientCertPem,
          key: environment.tls.clientKeyPem,
          ca: tls.caPem,
          servername: "localhost",
        });
        const agentData = echoEnvelope.parse(agent.json).data;
        expect(agentData.forwardedFor).toBeNull();
        expect(agentData.realIp).toBeNull();
        expect(agentData.ip).not.toBe("203.0.113.9");
      } finally {
        await handle.stop();
        environment.cleanup();
      }
    },
  );
});

describe("transport lifecycle", () => {
  it("closes and destroys dependencies when the second listener fails to bind", async () => {
    const environment = createServerEnvironment({
      OPENVAULT_PROXY_CIDRS: trustedCidrs(),
    });
    const keyring = await KeyringProvider.load(environment.keyringPath);
    const tls = TlsMaterial.load(environment.config);
    const database = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    const app = await createTestApplication(environment.config, {
      database,
      tls,
      keyring,
    });
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "0.0.0.0", resolve));
    const address = reserved.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a reserved TCP address");
    }

    try {
      await expect(app.startTransport({ adminPort: 0, agentPort: address.port })).rejects.toThrow();
      expect(keyring.status().loaded).toBe(false);
    } finally {
      await new Promise<void>((resolve) => reserved.close(() => resolve()));
      await app.stop();
      environment.cleanup();
    }
  }, 30_000);

  it("allows a second stop without throwing", async () => {
    const environment = createServerEnvironment({ OPENVAULT_PROXY_CIDRS: trustedCidrs() });
    const started = await start(environment);
    try {
      await started.stop();
      await expect(started.stop()).resolves.toBeUndefined();
    } finally {
      environment.cleanup();
    }
  }, 30_000);
});

import { PostgreSQLDatabase } from "blendsdk/postgresql";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import {
  ReadinessError,
  type ReadinessProbe,
  type ReadinessProbeName,
} from "../../src/readiness/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { MemoryDestination } from "./helpers/memory-destination.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), statusCode: z.number() }),
});

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
});

interface TestApp {
  readonly app: Awaited<ReturnType<typeof createTestApplication>>;
  readonly environment: ReturnType<typeof createServerEnvironment>;
  stop(): Promise<void>;
}

async function createApp(
  probes?: readonly ReadinessProbe[],
  destination?: MemoryDestination,
): Promise<TestApp> {
  const environment = createServerEnvironment({ OPENVAULT_DB_URL: testDb.url });
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
    ...(probes === undefined ? {} : { readinessProbes: probes }),
    ...(destination === undefined ? {} : { loggerDestination: destination }),
  });
  return {
    app,
    environment,
    async stop(): Promise<void> {
      await app.stop();
      environment.cleanup();
    },
  };
}

function failingProbe(name: ReadinessProbeName): ReadinessProbe {
  return {
    name,
    async check(): Promise<void> {
      throw new ReadinessError(name);
    },
  };
}

describe("readiness endpoints", () => {
  it("keeps liveness independent from failing dependency probes", async () => {
    const running = await createApp([failingProbe("postgresql")]);
    try {
      const response = await request(running.app.express).get("/health");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ health: true });
    } finally {
      await running.stop();
    }
  });

  it("returns ready with a migrated database, keyring, TLS, and audit table", async () => {
    const running = await createApp();
    try {
      const response = await request(running.app.express).get("/ready");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, data: { status: "ready" } });
    } finally {
      await running.stop();
    }
  }, 30_000);

  it.each(["postgresql", "keyring", "tls", "audit"] as const)(
    "maps a %s failure to 503 not_ready and logs the fixed probe name",
    async (name) => {
      const destination = new MemoryDestination();
      const running = await createApp([failingProbe(name)], destination);
      try {
        const response = await request(running.app.express).get("/ready");
        const parsed = errorEnvelope.parse(response.body);

        expect(response.status).toBe(503);
        expect(parsed.error.code).toBe("not_ready");
        const entries = destination
          .entries()
          .filter((entry) => entry.msg === "readiness probe failed");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.probe).toBe(name);
      } finally {
        await running.stop();
      }
    },
  );

  it("bounds a hanging probe at the readiness timeout", async () => {
    const running = await createApp([
      {
        name: "postgresql",
        check: () => new Promise<void>(() => undefined),
      },
    ]);
    try {
      const started = Date.now();
      const response = await request(running.app.express).get("/ready");
      const elapsed = Date.now() - started;

      expect(response.status).toBe(503);
      expect(errorEnvelope.parse(response.body).error.code).toBe("not_ready");
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await running.stop();
    }
  }, 30_000);
});

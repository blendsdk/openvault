import { PostgreSQLDatabase } from "blendsdk/postgresql";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApplication } from "../src/app.js";
import { ReadinessError, ReadinessService } from "../src/readiness/service.js";
import { KeyringProvider } from "../src/security/keyring.js";
import { TlsMaterial } from "../src/transport/tls.js";
import { MemoryDestination } from "./integration/helpers/memory-destination.js";
import { createServerEnvironment } from "./integration/helpers/server-environment.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

describe("readiness service internals", () => {
  it("clears the timeout timer after a successful check", async () => {
    vi.useFakeTimers();
    const service = new ReadinessService([{ name: "postgresql", check: async () => undefined }]);

    await service.check();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer after a timeout rejection", async () => {
    vi.useFakeTimers();
    const service = new ReadinessService([
      { name: "postgresql", check: () => new Promise<void>(() => undefined) },
    ]);
    const outcome = service.check().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toBeInstanceOf(ReadinessError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps fixed probe names", async () => {
    const service = new ReadinessService([
      {
        name: "audit",
        check: async () => {
          throw new ReadinessError("audit");
        },
      },
    ]);

    await expect(service.check()).rejects.toMatchObject({ probe: "audit" });
  });
});

describe("application disposal", () => {
  it("flushes the logger destination and tolerates a second shutdown", async () => {
    const environment = createServerEnvironment();
    const destination = new MemoryDestination();
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
      readinessProbes: [],
      loggerDestination: destination,
    });
    cleanup = async () => {
      environment.cleanup();
    };

    const response = await request(app.express).get("/ready");
    expect(response.status).toBe(200);

    await app.stop();
    await expect(app.stop()).resolves.toBeUndefined();

    expect(destination.entries().some((entry) => entry.url === "/ready")).toBe(true);
  });
});

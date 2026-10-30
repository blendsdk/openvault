import { PostgreSQLDatabase } from "blendsdk/postgresql";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApplication } from "../src/app.js";
import { ReadinessError } from "../src/readiness/service.js";
import { KeyringProvider } from "../src/security/keyring.js";
import { TlsMaterial } from "../src/transport/tls.js";
import { createServerEnvironment } from "./integration/helpers/server-environment.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function startWithProbe(check: () => Promise<void>) {
  const environment = createServerEnvironment();
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
    readinessProbes: [{ name: "postgresql", check }],
  });
  cleanup = async () => {
    await app.stop();
    environment.cleanup();
  };
  return app;
}

describe("root readiness harness", () => {
  it("returns the success envelope with injected probes", async () => {
    const app = await startWithProbe(async () => undefined);

    const response = await request(app.express).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: "ready" } });
  });

  it("maps ReadinessError to 503 not_ready", async () => {
    const app = await startWithProbe(async () => {
      throw new ReadinessError("postgresql");
    });

    const response = await request(app.express).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "not_ready", statusCode: 503 },
    });
  });
});

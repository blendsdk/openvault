import { PostgreSQLDatabase } from "blendsdk/postgresql";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApplication } from "../src/app.js";
import { KeyringProvider } from "../src/security/keyring.js";
import { TlsMaterial } from "../src/transport/tls.js";
import { createServerEnvironment } from "./integration/helpers/server-environment.js";

describe("in-process test application", () => {
  it("serves the WebAFX assembly without binding a plaintext listener", async () => {
    const environment = createServerEnvironment();
    try {
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
      });

      try {
        const health = await request(app.express).get("/health");
        expect(health.status).toBe(200);
        await expect(app.start()).rejects.toThrow(/startTransport/i);
      } finally {
        await app.stop();
      }
    } finally {
      environment.cleanup();
    }
  }, 30_000);
});

import { readFileSync } from "node:fs";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApplication, createTestApplication } from "../src/app.js";
import { KeyringProvider } from "../src/security/keyring.js";
import { TlsMaterial } from "../src/transport/tls.js";
import { createServerEnvironment } from "./integration/helpers/server-environment.js";

describe("agent startup boundaries", () => {
  it("should fail closed when production has no agent authenticator", async () => {
    const environment = createServerEnvironment();
    let database: PostgreSQLDatabase | undefined;
    try {
      const keyring = await KeyringProvider.load(environment.keyringPath);
      const tls = TlsMaterial.load(environment.config);
      database = new PostgreSQLDatabase({
        ...environment.config.database,
        poolConfig: { connectionTimeoutMillis: 2_000 },
        enableGracefulShutdown: false,
      });
      const app = createApplication(environment.config, { database, tls, keyring });
      await app.prepare();
      await expect(app.startTransport({ adminPort: 0, agentPort: 0 })).rejects.toThrow(
        /authenticator/i,
      );
    } finally {
      await database?.disconnect().catch(() => undefined);
      environment.cleanup();
    }
  }, 30_000);

  it("should not reference test-only agent overrides from production startup", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain("agentOverrides");
    expect(source).not.toContain("createTestApplication");
  });
});

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

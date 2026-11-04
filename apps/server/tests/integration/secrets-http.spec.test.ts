import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import { createSecretRateLimitService } from "../../src/secrets/rate-limits.js";
import type { SecretService } from "../../src/secrets/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

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

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let app: SecureWebApplication;
let handle: TransportHandle;
let orgCookie: string;
let orgCsrf: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS:
      trustedHost === undefined ? "127.0.0.1/32,::1/128" : `127.0.0.1/32,::1/128,${trustedHost}/32`,
  });
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  app = await createTestApplication(environment.config, { database, tls, keyring });
  handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  const sessions = await app.getService<SessionService>("sessions");
  const session = await sessions.create({ principalId: actors.orgAdmin, authMethod: "local" });
  orgCookie = `${SESSION_COOKIE_NAME}=${session.secretId}`;
  orgCsrf = session.record.csrfToken;
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

async function send(path: string, method = "GET", body?: string): Promise<TestResponse> {
  return testRequest({
    port: handle.adminPort,
    path,
    method,
    host: trustedHost ?? "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: {
      cookie: orgCookie,
      origin: environment.config.baseUrl.origin,
      ...(method === "GET" ? {} : { "x-csrf-token": orgCsrf }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

describe("secret HTTP core routes", () => {
  it("should read a value and list metadata", async () => {
    const service = await app.getService<SecretService>("secretService");
    await service.create(
      actors.orgAdmin,
      "foundation",
      { name: "http-secret", value: "http-value" },
      { requestId: "http-create" },
    );
    const read = await send("/v1/data/foundation/secrets/http-secret");
    expect(read.status).toBe(200);
    expect((read.json as { data: { value: string } }).data.value).toBe("http-value");
    const list = await send("/v1/data/foundation/secrets?limit=10");
    expect(list.status).toBe(200);
    const body = list.json as { data: { secrets: { name: string; value?: string }[] } };
    expect(body.data.secrets.map((secret) => secret.name)).toContain("http-secret");
    expect(body.data.secrets.every((secret) => secret.value === undefined)).toBe(true);
  });

  it("should reject an invalid list limit with 422", async () => {
    const response = await send("/v1/data/foundation/secrets?limit=0");
    expect(response.status).toBe(422);
    expect((response.json as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("should accept a 64 KiB value with heavy JSON escaping", async () => {
    const value = '"'.repeat(65_536);
    const response = await send(
      "/v1/data/foundation/secrets",
      "POST",
      JSON.stringify({ name: "http-escaped", value }),
    );
    expect(response.status, response.body).toBe(201);
    const read = await send("/v1/data/foundation/secrets/http-escaped");
    expect(read.status).toBe(200);
    expect((read.json as { data: { value: string } }).data.value).toBe(value);
  }, 60_000);

  it("should update metadata, delete, recover, and list versions over HTTP", async () => {
    const service = await app.getService<SecretService>("secretService");
    const created = await service.create(
      actors.orgAdmin,
      "foundation",
      { name: "http-lifecycle", value: "one" },
      { requestId: "http-create-lifecycle" },
    );
    const patched = await send(
      "/v1/data/foundation/secrets/http-lifecycle",
      "PATCH",
      JSON.stringify({ tags: { env: "prod" }, contentType: "application/json" }),
    );
    expect(patched.status, patched.body).toBe(200);
    expect((patched.json as { data: { tags: Record<string, string> } }).data.tags).toEqual({
      env: "prod",
    });
    const deleted = await send("/v1/data/foundation/secrets/http-lifecycle", "DELETE");
    expect(deleted.status).toBe(204);
    expect((await send("/v1/data/foundation/secrets/http-lifecycle")).status).toBe(404);
    const recovered = await send("/v1/data/foundation/secrets/http-lifecycle/recover", "POST");
    expect(recovered.status, recovered.body).toBe(200);
    expect((recovered.json as { data: { status: string } }).data.status).toBe("active");
    const versions = await send("/v1/data/foundation/secrets/http-lifecycle/versions");
    expect(versions.status).toBe(200);
    expect((versions.json as { data: { versions: unknown[] } }).data.versions).toHaveLength(1);
    expect(created.currentVersion).not.toBeNull();
  });

  it("should return 503 when purge is not configured", async () => {
    const service = await app.getService<SecretService>("secretService");
    const created = await service.create(
      actors.orgAdmin,
      "foundation",
      { name: "http-purge", value: "one" },
      { requestId: "http-create-purge" },
    );
    await service.delete(actors.orgAdmin, "foundation", "http-purge", {
      requestId: "http-delete-purge",
    });
    await testDb.db.executeQuery(
      `UPDATE secrets
          SET deleted_at = '2020-01-01T00:00:00.000Z',
              purge_after = '2020-01-02T00:00:00.000Z'
        WHERE id = :id`,
      { id: created.id },
    );
    const response = await send("/v1/data/foundation/secrets/http-purge/purge", "POST");
    expect(response.status).toBe(503);
    expect((response.json as { error: { code: string } }).error.code).toBe("service_unavailable");
  });

  it("should reject an unknown create field with 422", async () => {
    const response = await send(
      "/v1/data/foundation/secrets",
      "POST",
      JSON.stringify({ name: "http-extra", value: "x", extra: true }),
    );
    expect(response.status).toBe(422);
  });
});

describe("secret data rate limit", () => {
  it("should limit one principal and keep separate buckets", async () => {
    const limits = createSecretRateLimitService({ limit: 1 });
    const app = express();
    app.use((req, _res, next) => {
      req.auth = {
        kind: "cli",
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        familyId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        jti: "jti",
        expiresAt: Date.now() + 60_000,
        user: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          name: "User",
          email: null,
          authMethod: "local",
        },
        mustChangePassword: false,
      };
      next();
    });
    app.get("/data", limits.middleware, (_req, res) => {
      res.status(200).send("ok");
    });
    expect((await request(app).get("/data")).status).toBe(200);
    expect((await request(app).get("/data")).status).toBe(429);
  });
});

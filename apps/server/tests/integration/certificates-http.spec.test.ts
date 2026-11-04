import { networkInterfaces } from "node:os";
import { newUlid } from "@openvault/core";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import type { CertificateService } from "../../src/certificates/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
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
let cookie: string;
let csrf: string;

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
  cookie = `${SESSION_COOKIE_NAME}=${session.secretId}`;
  csrf = session.record.csrfToken;
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

async function sendAs(
  cookieValue: string,
  csrfValue: string,
  path: string,
  method = "GET",
  body?: string,
): Promise<TestResponse> {
  return testRequest({
    port: handle.adminPort,
    path,
    method,
    host: trustedHost ?? "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: {
      cookie: cookieValue,
      origin: environment.config.baseUrl.origin,
      ...(method === "GET" ? {} : { "x-csrf-token": csrfValue }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function send(path: string, method = "GET", body?: string): Promise<TestResponse> {
  return sendAs(cookie, csrf, path, method, body);
}

describe("certificate HTTP routes", () => {
  it("should import, list, read, read the private key, patch, delete, and recover", async () => {
    const fixture = await createSelfSignedFixture();
    const imported = await send(
      "/v1/data/foundation/certificates/import",
      "POST",
      JSON.stringify({
        name: "http-cert",
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    );
    expect(imported.status, imported.body).toBe(201);
    const importedBody = imported.json as { data: { version: { id: string } } };
    expect(importedBody.data.version.id).toBeTruthy();

    const list = await send("/v1/data/foundation/certificates?limit=10");
    expect(list.status, list.body).toBe(200);
    const listed = (list.json as { data: { certificates: { name: string; value?: string }[] } })
      .data.certificates;
    expect(listed.some((entry) => entry.name === "http-cert")).toBe(true);
    expect(listed.every((entry) => entry.value === undefined)).toBe(true);

    const read = await send("/v1/data/foundation/certificates/http-cert");
    expect(read.status, read.body).toBe(200);
    expect((read.json as { data: { certificatePem: string } }).data.certificatePem).toContain(
      "BEGIN CERTIFICATE",
    );

    const privateKey = await send("/v1/data/foundation/certificates/http-cert/private-key");
    expect(privateKey.status, privateKey.body).toBe(200);
    expect((privateKey.json as { data: { privateKeyPem: string } }).data.privateKeyPem).toContain(
      "BEGIN PRIVATE KEY",
    );

    const patched = await send(
      "/v1/data/foundation/certificates/http-cert",
      "PATCH",
      JSON.stringify({ purgeProtected: true }),
    );
    expect(patched.status, patched.body).toBe(200);

    const deleted = await send("/v1/data/foundation/certificates/http-cert", "DELETE");
    expect(deleted.status).toBe(204);
    expect((await send("/v1/data/foundation/certificates/http-cert")).status).toBe(404);

    const recovered = await send("/v1/data/foundation/certificates/http-cert/recover", "POST");
    expect(recovered.status, recovered.body).toBe(200);
  });

  it("should reject a mutation without the CSRF header", async () => {
    const fixture = await createSelfSignedFixture();
    const response = await testRequest({
      port: handle.adminPort,
      path: "/v1/data/foundation/certificates/import",
      method: "POST",
      host: trustedHost ?? "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
      headers: {
        cookie,
        origin: environment.config.baseUrl.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "csrf-cert",
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    });
    expect(response.status).toBe(403);
  });

  it("should reject an invalid list limit and an oversized PEM", async () => {
    expect((await send("/v1/data/foundation/certificates?limit=0")).status).toBe(422);
    const fixture = await createSelfSignedFixture();
    const oversized = await send(
      "/v1/data/foundation/certificates/import",
      "POST",
      JSON.stringify({
        name: "oversized-cert",
        certificatePem: "a".repeat(131_073),
        privateKeyPem: fixture.privateKeyPem,
      }),
    );
    expect(oversized.status).toBe(413);
  });

  it("should deny certificate routes on the agent listener without a client certificate", async () => {
    const response = await testRequest({
      port: handle.agentPort,
      path: "/v1/data/foundation/certificates",
      method: "GET",
      host: trustedHost ?? "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
      headers: {},
    });
    expect(response.status).toBe(401);
  });

  it("should limit import/generate and private-key reads", async () => {
    const userId = newUlid();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status)
       VALUES (:id, 'user', 'Rate Limit User', :email, 'active')`,
      { id: userId, email: `${userId.toLowerCase()}@example.test` },
    );
    const sessions = await app.getService<SessionService>("sessions");
    const session = await sessions.create({ principalId: userId, authMethod: "local" });
    const userCookie = `${SESSION_COOKIE_NAME}=${session.secretId}`;
    const userCsrf = session.record.csrfToken;
    for (let index = 0; index < 10; index += 1) {
      const response = await sendAs(
        userCookie,
        userCsrf,
        "/v1/data/foundation/certificates/import",
        "POST",
        JSON.stringify({}),
      );
      expect(response.status).toBe(422);
    }
    const limitedWrite = await sendAs(
      userCookie,
      userCsrf,
      "/v1/data/foundation/certificates/import",
      "POST",
      JSON.stringify({}),
    );
    expect(limitedWrite.status).toBe(429);

    for (let index = 0; index < 30; index += 1) {
      const response = await sendAs(
        userCookie,
        userCsrf,
        "/v1/data/foundation/certificates/missing/private-key",
      );
      expect(response.status).toBe(403);
    }
    const limitedPrivate = await sendAs(
      userCookie,
      userCsrf,
      "/v1/data/foundation/certificates/missing/private-key",
    );
    expect(limitedPrivate.status).toBe(429);
  }, 60_000);

  it("should return 503 when purge is not configured", async () => {
    const service = await app.getService<CertificateService>("certificateService");
    const fixture = await createSelfSignedFixture();
    const created = await service.import(actors.orgAdmin, "foundation", {
      name: "http-purge",
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    await testDb.db.executeQuery(
      `UPDATE certificates
          SET deleted_at = '2020-01-01T00:00:00.000Z',
              purge_after = '2020-01-02T00:00:00.000Z'
        WHERE id = :id`,
      { id: created.response.id },
    );
    const response = await send("/v1/data/foundation/certificates/http-purge/purge", "POST");
    expect(response.status).toBe(503);
    expect((response.json as { error: { code: string } }).error.code).toBe("service_unavailable");
  });
});

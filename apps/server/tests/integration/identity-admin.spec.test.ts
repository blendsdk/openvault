import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  cliTokenResponseSchema,
  identityDetailSchema,
  identityListSchema,
  identitySummarySchema,
  joinTokenResponseSchema,
  ulidSchema,
} from "@openvault/api-contract";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionRecord, SessionService } from "../../src/auth/sessions.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestRequestOptions, type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const SESSION_COOKIE = SESSION_COOKIE_NAME;
const CONFIGURED_ORIGIN = "https://vault.example.com";
const CSRF_HEADER = "x-csrf-token";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";
const TEST_PASSWORD = "correct horse battery staple";
const PHC_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), statusCode: z.number().optional() }),
});
const summaryEnvelope = z.object({ success: z.literal(true), data: identitySummarySchema });
const listEnvelope = z.object({ success: z.literal(true), data: identityListSchema });
const detailEnvelope = z.object({ success: z.literal(true), data: identityDetailSchema });
const tokenEnvelope = z.object({ success: z.literal(true), data: joinTokenResponseSchema });
const cliLoginEnvelope = z.object({ success: z.literal(true), data: cliTokenResponseSchema });

interface RunningApp {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
}

interface FixtureUser {
  readonly id: string;
  readonly email: string;
}

interface FixtureProject {
  readonly id: string;
  readonly name: string;
}

let testDb: TestDatabase;
let running: RunningApp;
let sessions: SessionService;
let nextSeed = 500;
let nextProject = 0;

function fixtureId(): string {
  nextSeed += 1;
  return testUlid(nextSeed);
}

function projectName(): string {
  nextProject += 1;
  return `project-${nextProject}`;
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

function trustedProxyCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

type SendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername" | "body"> & {
  readonly body?: unknown;
};

function send(options: SendOptions): Promise<TestResponse> {
  const { body, ...requestOptions } = options;
  return testRequest({
    ...requestOptions,
    host: trustedHost ?? "127.0.0.1",
    port: running.handle.adminPort,
    ca: running.environment.tls.caPem,
    servername: "localhost",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function browserHeaders(secretId: string, csrfToken: string): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${secretId}`,
    [CSRF_HEADER]: csrfToken,
    origin: CONFIGURED_ORIGIN,
    "content-type": "application/json",
  };
}

function getErrorCode(response: TestResponse): string {
  return errorEnvelope.parse(response.json).error.code;
}

async function insertUser(
  options: { readonly localPassword?: boolean } = {},
): Promise<FixtureUser> {
  const id = fixtureId();
  const email = `admin-${id.toLowerCase()}@example.test`;
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Admin ${id}`, email },
  );
  if (options.localPassword === true) {
    await testDb.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash, must_change)
       VALUES (:id, :passwordHash, false)`,
      { id, passwordHash: PHC_HASH },
    );
  }
  return { id, email };
}

async function insertProject(): Promise<FixtureProject> {
  const id = fixtureId();
  const name = projectName();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id,
    name,
  });
  return { id, name };
}

async function assignRole(
  actor: FixtureUser,
  role: "org.admin" | "project.admin" | "auditor",
  scopeType: "org" | "project",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    {
      id: fixtureId(),
      principalId: actor.id,
      role,
      scopeType,
      scopeId,
    },
  );
}

async function insertService(
  project: FixtureProject,
  name = `service-${fixtureId().toLowerCase()}`,
): Promise<string> {
  const id = fixtureId();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', :name, :projectId)`,
    { id, name, projectId: project.id },
  );
  return id;
}

async function insertCertificate(
  principalId: string,
  options: {
    serial: string;
    revokedAt?: string | null;
    notBefore?: string;
    notAfter?: string;
  },
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after, revoked_at)
     VALUES (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter, :revokedAt)`,
    {
      id: fixtureId(),
      principalId,
      serial: options.serial,
      fingerprint: createHash("sha256").update(options.serial).digest("hex"),
      notBefore: options.notBefore ?? TIMESTAMP,
      notAfter: options.notAfter ?? "2027-10-30T12:00:00.000Z",
      revokedAt: options.revokedAt ?? null,
    },
  );
}

async function insertConsumer(principalId: string, projectId: string): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO consumers
       (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash,
        state, first_seen, last_seen)
     VALUES
       (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
        'ok', :firstSeen, :lastSeen)`,
    {
      id: fixtureId(),
      principalId,
      projectId,
      manifestHash: `sha256:${"b".repeat(64)}`,
      firstSeen: TIMESTAMP,
      lastSeen: TIMESTAMP,
    },
  );
}

async function insertToken(serviceId: string, projectId: string, actorId: string): Promise<string> {
  const token = "t".repeat(43);
  await testDb.db.executeQuery(
    `INSERT INTO join_tokens
       (id, token_hash, principal_id, project_id, expires_at, created_by)
     VALUES (:id, :tokenHash, :principalId, :projectId, :expiresAt, :createdBy)`,
    {
      id: fixtureId(),
      tokenHash: createHash("sha256").update(token).digest(),
      principalId: serviceId,
      projectId,
      expiresAt: "2027-10-30T12:00:00.000Z",
      createdBy: actorId,
    },
  );
  return token;
}

async function startApp(environment: ServerEnvironment): Promise<RunningApp> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, { database, tls, keyring });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return { app, handle, environment };
}

async function sessionFor(
  actor: FixtureUser,
): Promise<{ secretId: string; record: SessionRecord }> {
  return sessions.create({ principalId: actor.id, authMethod: "local" });
}

async function orgAdmin(): Promise<FixtureUser> {
  const actor = await insertUser();
  await assignRole(actor, "org.admin", "org", "org");
  return actor;
}

async function adminHeaders(actor: FixtureUser): Promise<Record<string, string>> {
  const session = await sessionFor(actor);
  return browserHeaders(session.secretId, session.record.csrfToken);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  const environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
  });
  running = await startApp(environment);
  sessions = await running.app.getService<SessionService>("sessions");
}, 30_000);

afterAll(async () => {
  if (running !== undefined) {
    await running.handle.stop();
    running.environment.cleanup();
  }
  if (testDb !== undefined) {
    await testDb.cleanup();
  }
});

describe.skipIf(trustedHost === undefined)("identity administration", () => {
  it("should create a project-owned service identity for an org admin", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const response = await send({
      method: "POST",
      path: "/v1/admin/identities",
      headers: await adminHeaders(actor),
      body: { name: "  payments-api  ", projectId: project.id },
    });

    expect(response.status).toBe(201);
    const body = summaryEnvelope.parse(response.json);
    expect(body.data).toMatchObject({
      name: "payments-api",
      projectId: project.id,
      status: "active",
    });
    expect(ulidSchema.safeParse(body.data.id).success).toBe(true);

    const row = await testDb.db.executeQuery<{ kind: string; owner_project_id: string }>(
      "SELECT kind, owner_project_id FROM principals WHERE id = :id",
      { id: body.data.id },
    );
    expect(row.records[0]).toEqual({ kind: "service", owner_project_id: project.id });
  });

  it("should reject missing, unknown, and deleted projects on create", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const headers = await adminHeaders(actor);

    for (const body of [
      { name: "missing-project" },
      { name: "unknown-project", projectId: testUlid(900) },
    ]) {
      const response = await send({
        method: "POST",
        path: "/v1/admin/identities",
        headers,
        body,
      });
      expect(response.status).toBe(422);
      expect(getErrorCode(response)).toBe("validation_error");
    }

    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: project.id,
    });
    const response = await send({
      method: "POST",
      path: "/v1/admin/identities",
      headers,
      body: { name: "deleted-project", projectId: project.id },
    });
    expect(response.status).toBe(422);
  });

  it("should reject a duplicate active service name", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const headers = await adminHeaders(actor);
    await insertService(project, "duplicate-service");

    const response = await send({
      method: "POST",
      path: "/v1/admin/identities",
      headers,
      body: { name: "duplicate-service", projectId: project.id },
    });
    expect(response.status).toBe(409);
    expect(getErrorCode(response)).toBe("identity_name_conflict");
  });

  it("should enforce project-scoped create and org-scoped project admin", async () => {
    const project = await insertProject();
    const otherProject = await insertProject();
    const projectAdmin = await insertUser();
    await assignRole(projectAdmin, "project.admin", "project", project.id);
    const projectHeaders = await adminHeaders(projectAdmin);

    expect(
      (
        await send({
          method: "POST",
          path: "/v1/admin/identities",
          headers: projectHeaders,
          body: { name: "owned-service", projectId: project.id },
        })
      ).status,
    ).toBe(201);

    const denied = await send({
      method: "POST",
      path: "/v1/admin/identities",
      headers: projectHeaders,
      body: { name: "other-service", projectId: otherProject.id },
    });
    expect(denied.status).toBe(403);
    expect(getErrorCode(denied)).toBe("access_denied");

    const orgProjectAdmin = await insertUser();
    await assignRole(orgProjectAdmin, "project.admin", "org", "org");
    const orgHeaders = await adminHeaders(orgProjectAdmin);
    expect(
      (
        await send({
          method: "POST",
          path: "/v1/admin/identities",
          headers: orgHeaders,
          body: { name: "org-service", projectId: otherProject.id },
        })
      ).status,
    ).toBe(201);
  });

  it("should allow auditor reads but not writes", async () => {
    const project = await insertProject();
    const auditor = await insertUser();
    await assignRole(auditor, "auditor", "project", project.id);
    const headers = await adminHeaders(auditor);

    expect((await send({ method: "GET", path: "/v1/admin/identities", headers })).status).toBe(200);
    const target = await insertService(project, "auditor-target");

    for (const [method, path, body] of [
      ["POST", "/v1/admin/identities", { name: "auditor-service", projectId: project.id }],
      ["POST", `/v1/admin/identities/${target}/revoke`, undefined],
      ["POST", `/v1/admin/identities/${target}/join-tokens`, {}],
    ] as const) {
      const response = await send({
        method,
        path,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(403);
      expect(getErrorCode(response)).toBe("access_denied");
    }
  });

  it("should scope list results by project and reject a foreign project filter", async () => {
    const projectA = await insertProject();
    const projectB = await insertProject();
    const orgActor = await orgAdmin();
    const projectActor = await insertUser();
    await assignRole(projectActor, "project.admin", "project", projectA.id);
    await insertService(projectA, "list-a");
    await insertService(projectB, "list-b");

    const orgList = listEnvelope.parse(
      (
        await send({
          method: "GET",
          path: "/v1/admin/identities",
          headers: await adminHeaders(orgActor),
        })
      ).json,
    );
    expect(orgList.data.identities.map((identity) => identity.name)).toEqual(
      expect.arrayContaining(["list-a", "list-b"]),
    );

    const projectList = listEnvelope.parse(
      (
        await send({
          method: "GET",
          path: `/v1/admin/identities?projectId=${projectA.id}`,
          headers: await adminHeaders(projectActor),
        })
      ).json,
    );
    expect(
      projectList.data.identities.every((identity) => identity.projectId === projectA.id),
    ).toBe(true);

    const denied = await send({
      method: "GET",
      path: `/v1/admin/identities?projectId=${projectB.id}`,
      headers: await adminHeaders(projectActor),
    });
    expect(denied.status).toBe(403);
    expect(getErrorCode(denied)).toBe("access_denied");
  });

  it("should return retained certificates and consumer detail, but hide foreign identities", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const serviceId = await insertService(project, "detail-service");
    await insertCertificate(serviceId, { serial: "01" });
    await insertCertificate(serviceId, {
      serial: "02",
      revokedAt: "2026-11-01T12:00:00.000Z",
    });
    await insertCertificate(serviceId, {
      serial: "03",
      notBefore: "2024-01-01T00:00:00.000Z",
      notAfter: "2025-01-01T00:00:00.000Z",
    });
    await insertConsumer(serviceId, project.id);

    const response = await send({
      method: "GET",
      path: `/v1/admin/identities/${serviceId}`,
      headers: await adminHeaders(actor),
    });
    expect(response.status).toBe(200);
    const body = detailEnvelope.parse(response.json);
    expect(body.data.certificates.map((certificate) => certificate.serial)).toEqual([
      "03",
      "02",
      "01",
    ]);
    expect(body.data.consumer?.selfReported).toBe(true);

    const projectAdmin = await insertUser();
    const otherProject = await insertProject();
    await assignRole(projectAdmin, "project.admin", "project", otherProject.id);
    const foreign = await send({
      method: "GET",
      path: `/v1/admin/identities/${serviceId}`,
      headers: await adminHeaders(projectAdmin),
    });
    expect(foreign.status).toBe(404);
    expect(getErrorCode(foreign)).toBe("identity_not_found");
  });

  it("should revoke atomically and idempotently", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const serviceId = await insertService(project, "revoke-service");
    await insertCertificate(serviceId, { serial: "revoke-cert" });
    await insertConsumer(serviceId, project.id);
    await insertToken(serviceId, project.id, actor.id);
    const headers = await adminHeaders(actor);

    const first = await send({
      method: "POST",
      path: `/v1/admin/identities/${serviceId}/revoke`,
      headers,
    });
    expect(first.status).toBe(204);
    const second = await send({
      method: "POST",
      path: `/v1/admin/identities/${serviceId}/revoke`,
      headers,
    });
    expect(second.status).toBe(204);

    const state = await testDb.db.executeQuery<{
      status: string;
      disabled_at: Date | null;
      cert_revoked: Date | null;
      token_revoked: Date | null;
      consumer_state: string;
    }>(
      `SELECT p.status, p.disabled_at, c.revoked_at AS cert_revoked,
              t.revoked_at AS token_revoked, u.state AS consumer_state
         FROM principals p
         LEFT JOIN workload_certs c ON c.principal_id = p.id
         LEFT JOIN join_tokens t ON t.principal_id = p.id
         LEFT JOIN consumers u ON u.principal_id = p.id
        WHERE p.id = :id`,
      { id: serviceId },
    );
    expect(state.records[0]?.status).toBe("disabled");
    expect(state.records[0]?.disabled_at).not.toBeNull();
    expect(state.records[0]?.cert_revoked).not.toBeNull();
    expect(state.records[0]?.token_revoked).not.toBeNull();
    expect(state.records[0]?.consumer_state).toBe("failed");
  });

  it("should issue a raw token once and reject inactive targets and invalid TTLs", async () => {
    const actor = await orgAdmin();
    const project = await insertProject();
    const serviceId = await insertService(project, "token-service");
    const headers = await adminHeaders(actor);

    const response = await send({
      method: "POST",
      path: `/v1/admin/identities/${serviceId}/join-tokens`,
      headers,
      body: { ttlSeconds: 900 },
    });
    expect(response.status).toBe(201);
    const token = tokenEnvelope.parse(response.json).data;
    expect(token.token).toHaveLength(43);

    for (const ttlSeconds of [1, 86_400]) {
      expect(
        (
          await send({
            method: "POST",
            path: `/v1/admin/identities/${serviceId}/join-tokens`,
            headers,
            body: { ttlSeconds },
          })
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await send({
          method: "POST",
          path: `/v1/admin/identities/${serviceId}/join-tokens`,
          headers,
          body: {},
        })
      ).status,
    ).toBe(201);

    const detail = detailEnvelope.parse(
      (
        await send({
          method: "GET",
          path: `/v1/admin/identities/${serviceId}`,
          headers,
        })
      ).json,
    );
    expect(JSON.stringify(detail.data)).not.toContain(token.token);

    for (const ttlSeconds of [0, 86_401]) {
      const invalid = await send({
        method: "POST",
        path: `/v1/admin/identities/${serviceId}/join-tokens`,
        headers,
        body: { ttlSeconds },
      });
      expect(invalid.status).toBe(422);
    }

    await testDb.db.executeQuery(
      "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
      { id: serviceId },
    );
    const inactive = await send({
      method: "POST",
      path: `/v1/admin/identities/${serviceId}/join-tokens`,
      headers,
      body: {},
    });
    expect(inactive.status).toBe(409);
    expect(getErrorCode(inactive)).toBe("identity_inactive");

    const deletedProject = await insertProject();
    const deletedService = await insertService(deletedProject, "deleted-token");
    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: deletedProject.id,
    });
    const deleted = await send({
      method: "POST",
      path: `/v1/admin/identities/${deletedService}/join-tokens`,
      headers,
      body: {},
    });
    expect(deleted.status).toBe(404);
    expect(getErrorCode(deleted)).toBe("identity_not_found");
  });

  it("should not reveal or mutate a foreign identity", async () => {
    const owner = await orgAdmin();
    const project = await insertProject();
    const serviceId = await insertService(project, "foreign-service");
    const foreignAdmin = await insertUser();
    const otherProject = await insertProject();
    await assignRole(foreignAdmin, "project.admin", "project", otherProject.id);
    const headers = await adminHeaders(foreignAdmin);

    for (const path of [
      `/v1/admin/identities/${serviceId}/revoke`,
      `/v1/admin/identities/${serviceId}/join-tokens`,
    ]) {
      const response = await send({ method: "POST", path, headers, body: {} });
      expect(response.status).toBe(404);
    }

    const state = await testDb.db.executeQuery<{ status: string }>(
      "SELECT status FROM principals WHERE id = :id",
      { id: serviceId },
    );
    expect(state.records[0]?.status).toBe("active");
    expect(
      (
        await send({
          method: "GET",
          path: `/v1/admin/identities/${serviceId}`,
          headers: await adminHeaders(owner),
        })
      ).status,
    ).toBe(200);
  });

  it("should return 403 for a signed-in caller with no identity role", async () => {
    const owner = await orgAdmin();
    const project = await insertProject();
    const serviceId = await insertService(project, "no-role-target");
    const noRole = await insertUser();
    const response = await send({
      method: "GET",
      path: `/v1/admin/identities/${serviceId}`,
      headers: await adminHeaders(noRole),
    });
    expect(response.status).toBe(403);
    expect(getErrorCode(response)).toBe("access_denied");
    expect(
      (
        await send({
          method: "GET",
          path: `/v1/admin/identities/${serviceId}`,
          headers: await adminHeaders(owner),
        })
      ).status,
    ).toBe(200);
  });

  it("should accept a CLI bearer on the admin identity surface", async () => {
    const actor = await insertUser({ localPassword: true });
    await assignRole(actor, "org.admin", "org", "org");
    const login = await send({
      method: "POST",
      path: "/v1/auth/cli/login",
      headers: { "content-type": "application/json" },
      body: { identifier: actor.email, password: TEST_PASSWORD },
    });
    expect(login.status).toBe(200);
    const accessToken = cliLoginEnvelope.parse(login.json).data.accessToken;
    const response = await send({
      method: "GET",
      path: "/v1/admin/identities",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  it("should require authentication on every admin identity route", async () => {
    const serviceId = await insertService(await insertProject(), "auth-target");
    const requests = [
      { method: "GET" as const, path: "/v1/admin/identities" },
      { method: "GET" as const, path: `/v1/admin/identities/${serviceId}` },
      { method: "POST" as const, path: "/v1/admin/identities", body: { name: "x" } },
      { method: "POST" as const, path: `/v1/admin/identities/${serviceId}/revoke` },
      { method: "POST" as const, path: `/v1/admin/identities/${serviceId}/join-tokens`, body: {} },
    ];
    for (const request of requests) {
      const response = await send({
        ...request,
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(401);
    }
  });

  it("should return 404 for a malformed path id", async () => {
    const actor = await orgAdmin();
    const response = await send({
      method: "GET",
      path: "/v1/admin/identities/not-a-ulid",
      headers: await adminHeaders(actor),
    });
    expect(response.status).toBe(404);
    expect(getErrorCode(response)).toBe("identity_not_found");
  });
});

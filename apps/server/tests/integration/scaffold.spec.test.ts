import { networkInterfaces } from "node:os";
import { scaffoldResponseSchema } from "@openvault/api-contract";
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

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), statusCode: z.number().optional() }),
});
const scaffoldEnvelope = z.object({ success: z.literal(true), data: scaffoldResponseSchema });

let testDb: TestDatabase;
let running: {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
};
let sessions: SessionService;
let nextSeed = 9_000;

function id(): string {
  nextSeed += 1;
  return testUlid(nextSeed);
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

async function insertUser(): Promise<string> {
  const userId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    {
      id: userId,
      name: `Scaffold ${userId}`,
      email: `scaffold-${userId.toLowerCase()}@example.test`,
    },
  );
  return userId;
}

async function assign(
  actorId: string,
  role: "org.admin" | "project.admin" | "reader",
  scopeType: "org" | "project",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: id(), principalId: actorId, role, scopeType, scopeId },
  );
}

async function insertProject(name: string): Promise<string> {
  const projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id: projectId,
    name,
  });
  return projectId;
}

async function insertSecret(projectId: string, name: string): Promise<string> {
  const secretId = id();
  await testDb.db.executeQuery(
    "INSERT INTO secrets (id, project_id, name) VALUES (:id, :projectId, :name)",
    { id: secretId, projectId, name },
  );
  return secretId;
}

async function sessionHeaders(actorId: string): Promise<Record<string, string>> {
  const session: { secretId: string; record: SessionRecord } = await sessions.create({
    principalId: actorId,
    authMethod: "local",
  });
  return {
    cookie: `${SESSION_COOKIE}=${session.secretId}`,
    [CSRF_HEADER]: session.record.csrfToken,
    origin: CONFIGURED_ORIGIN,
    "content-type": "application/json",
  };
}

function errorCode(response: TestResponse): string {
  return errorEnvelope.parse(response.json).error.code;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  const environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
  });
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, { database, tls, keyring });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  running = { app, handle, environment };
  sessions = await app.getService<SessionService>("sessions");
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

describe.skipIf(trustedHost === undefined)("compose scaffold", () => {
  it("should create the identity, object grants, token, compose, and manifest", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await insertSecret(projectId, "db-password");
    await insertSecret(projectId, "stripe-key");

    const response = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers: await sessionHeaders(actor),
      body: { project: projectName, service: "api", entries: ["db-password", "stripe-key"] },
    });
    expect(response.status).toBe(200);
    const body = scaffoldEnvelope.parse(response.json).data;
    expect(body.project.id).toBe(projectId);
    expect(body.identity.name).toBe("api");
    expect(body.assignments).toHaveLength(2);
    expect(body.compose).toContain("openvault-agent-api");
    expect(body.compose).toContain("service_healthy");
    expect(body.compose).not.toContain(body.joinToken.token);
    expect(body.manifest).not.toContain(body.joinToken.token);
    expect(body.manifest).toContain("db-password");
    expect(body.manifestFile).toContain("api.manifest.yaml");

    const rows = await testDb.db.executeQuery<{
      role: string;
      scope_type: string;
      scope_id: string;
    }>("SELECT role, scope_type, scope_id FROM role_assignments WHERE principal_id = :id", {
      id: body.identity.id,
    });
    expect(rows.records).toHaveLength(2);
    expect(
      rows.records.every((row) => row.role === "secrets.reader" && row.scope_type === "object"),
    ).toBe(true);
  });

  it("should be idempotent and rotate the unused token", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await insertSecret(projectId, "db-password");
    const headers = await sessionHeaders(actor);
    const body = { project: projectName, service: "api", entries: ["db-password"] };

    const first = scaffoldEnvelope.parse(
      (await send({ method: "POST", path: "/v1/admin/scaffold", headers, body })).json,
    ).data;
    const second = scaffoldEnvelope.parse(
      (await send({ method: "POST", path: "/v1/admin/scaffold", headers, body })).json,
    ).data;

    expect(second.project.id).toBe(first.project.id);
    expect(second.identity.id).toBe(first.identity.id);
    expect(second.assignments.map((entry) => entry.assignment.id)).toEqual(
      first.assignments.map((entry) => entry.assignment.id),
    );
    expect(second.joinToken.token).not.toBe(first.joinToken.token);
    const tokens = await testDb.db.executeQuery<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM join_tokens WHERE principal_id = :id",
      { id: first.identity.id },
    );
    expect(tokens.records.filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it("should reject an unknown secret before issuing a token", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    const response = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers: await sessionHeaders(actor),
      body: { project: projectName, service: "api", entries: ["missing"] },
    });
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("validation_error");
    const identities = await testDb.db.executeQuery(
      "SELECT id FROM principals WHERE owner_project_id = :projectId AND kind = 'service'",
      { projectId },
    );
    expect(identities.records).toHaveLength(0);
  });

  it("should reject a new project with entries and create an empty one without entries", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const headers = await sessionHeaders(actor);
    const name = `scaffold-${id().slice(-8).toLowerCase()}`;
    const rejected = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers,
      body: { project: name, service: "api", entries: ["db-password"] },
    });
    expect(rejected.status).toBe(422);
    const notCreated = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM projects WHERE name = :name",
      { name },
    );
    expect(notCreated.records[0]?.count).toBe(0);
    const created = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers,
      body: { project: name, service: "api", entries: [] },
    });
    expect(created.status).toBe(200);
    const body = scaffoldEnvelope.parse(created.json).data;
    expect(body.assignments).toHaveLength(0);
    expect(body.manifest).toContain("entries");
  });

  it("should reject a reused identity with a broader grant", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await insertSecret(projectId, "db-password");
    const identityId = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id, status)
       VALUES (:id, 'service', 'api', :projectId, 'active')`,
      { id: identityId, projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
       VALUES (:id, :principalId, 'secrets.reader', 'project', :projectId, :principalId)`,
      { id: id(), principalId: identityId, projectId },
    );
    const response = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers: await sessionHeaders(actor),
      body: { project: projectName, service: "api", entries: ["db-password"] },
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("identity_scope_conflict");
  });

  it("should remove an object grant when the entry set shrinks", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await insertSecret(projectId, "alpha");
    await insertSecret(projectId, "beta");
    const headers = await sessionHeaders(actor);
    await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers,
      body: { project: projectName, service: "api", entries: ["alpha", "beta"] },
    });
    const second = scaffoldEnvelope.parse(
      (
        await send({
          method: "POST",
          path: "/v1/admin/scaffold",
          headers,
          body: { project: projectName, service: "api", entries: ["alpha"] },
        })
      ).json,
    ).data;
    expect(second.assignments).toHaveLength(1);
    const rows = await testDb.db.executeQuery<{ scope_id: string }>(
      "SELECT scope_id FROM role_assignments WHERE principal_id = :id AND role = 'secrets.reader' AND scope_type = 'object'",
      { id: second.identity.id },
    );
    expect(rows.records).toHaveLength(1);
  });

  it("should deny a viewer without assignment.write", async () => {
    const actor = await insertUser();
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await assign(actor, "reader", "project", projectId);
    const response = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers: await sessionHeaders(actor),
      body: { project: projectName, service: "api", entries: [] },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("access_denied");
  });
  it("should ignore an expired broader grant when reusing an identity", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    await insertSecret(projectId, "db-password");
    const identityId = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id, status)
       VALUES (:id, 'service', 'api', :projectId, 'active')`,
      { id: identityId, projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
       VALUES (:id, :principalId, 'secrets.reader', 'project', :projectId, :principalId, now() - interval '1 hour')`,
      { id: id(), principalId: identityId, projectId },
    );
    const response = await send({
      method: "POST",
      path: "/v1/admin/scaffold",
      headers: await sessionHeaders(actor),
      body: { project: projectName, service: "api", entries: ["db-password"] },
    });
    expect(response.status).toBe(200);
    const body = scaffoldEnvelope.parse(response.json).data;
    expect(body.identity.id).toBe(identityId);
  });

  it("should serialize concurrent scaffolds with different entry sets", async () => {
    const actor = await insertUser();
    await assign(actor, "org.admin", "org", "org");
    const projectId = await insertProject(`scaffold-${id().slice(-8).toLowerCase()}`);
    const projectName =
      (
        await testDb.db.executeQuery<{ name: string }>("SELECT name FROM projects WHERE id = :id", {
          id: projectId,
        })
      ).records[0]?.name ?? "";
    const alphaId = await insertSecret(projectId, "alpha");
    const betaId = await insertSecret(projectId, "beta");
    const headers = await sessionHeaders(actor);
    const [first, second] = await Promise.all([
      send({
        method: "POST",
        path: "/v1/admin/scaffold",
        headers,
        body: { project: projectName, service: "api", entries: ["alpha"] },
      }),
      send({
        method: "POST",
        path: "/v1/admin/scaffold",
        headers,
        body: { project: projectName, service: "api", entries: ["beta"] },
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await testDb.db.executeQuery<{ scope_id: string }>(
      "SELECT scope_id FROM role_assignments WHERE principal_id = :id AND role = 'secrets.reader' AND scope_type = 'object'",
      { id: scaffoldEnvelope.parse(first.json).data.identity.id },
    );
    expect(rows.records).toHaveLength(1);
    expect([alphaId, betaId]).toContain(rows.records[0]?.scope_id);
  });
});

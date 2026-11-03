import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import { AssignmentService } from "../../src/rbac/assignment-service.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import type { PolicyService } from "../../src/rbac/policy-service.js";
import { PolicyService as PolicyEngine } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

class RecordingAudit implements PolicyAuditPort {
  readonly decisions: PolicyDecisionEvent[] = [];
  readonly mutations: PolicyMutationEvent[] = [];

  async recordDecision(event: PolicyDecisionEvent): Promise<void> {
    this.decisions.push(event);
  }

  async recordMutation(event: PolicyMutationEvent): Promise<void> {
    this.mutations.push(event);
  }
}

let testDb: TestDatabase;
let base: BaseFixture;
let audit: RecordingAudit;
let policy: PolicyService;
let service: AssignmentService;
let projectB: string;
let secretB: string;
let orgAdmin: string;
let projectAdmin: string;
let auditor: string;
let manager: string;
let target: string;
let nextUser = 7_000;
let nextAssignment = 8_000;

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
const CSRF_HEADER = "x-csrf-token";

async function insertUser(): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Assignment ${id}`, email: `assignment-${id.toLowerCase()}@example.test` },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
  expiresAt: string | null = null,
): Promise<string> {
  nextAssignment += 1;
  const id = testUlid(nextAssignment);
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)`,
    { id, principalId, role, scopeType, scopeId, grantedBy: base.userId, expiresAt },
  );
  return id;
}

async function version(): Promise<number> {
  return new PolicyRepository(testDb.db).readPolicyVersion();
}

async function assignmentCount(): Promise<number> {
  const result = await testDb.db.executeQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM role_assignments",
  );
  return result.records[0]?.count ?? 0;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  projectB = testUlid(7_900);
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'assignments-b')", {
    id: projectB,
  });
  secretB = testUlid(7_901);
  await testDb.db.executeQuery(
    "INSERT INTO secrets (id, project_id, name) VALUES (:id, :projectId, 'assignments-secret-b')",
    { id: secretB, projectId: projectB },
  );

  orgAdmin = await insertUser();
  projectAdmin = await insertUser();
  auditor = await insertUser();
  manager = await insertUser();
  target = await insertUser();
  await assign(orgAdmin, "org.admin", "org", "org");
  await assign(projectAdmin, "project.admin", "project", base.projectId);
  await assign(auditor, "auditor", "project", base.projectId);
  await assign(manager, "secrets.manager", "project", base.projectId);

  audit = new RecordingAudit();
  policy = new PolicyEngine({
    repository: new PolicyRepository(testDb.db),
    audit,
  });
  service = new AssignmentService({
    database: testDb.db,
    repository: new PolicyRepository(testDb.db),
    policy,
    audit,
    now: () => Date.now(),
  });
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("assignment creation", () => {
  it("should create an assignment, bump the version, and audit the decision and mutation", async () => {
    const beforeVersion = await version();
    audit.decisions.length = 0;
    audit.mutations.length = 0;

    const created = await service.create(orgAdmin, {
      principalId: target,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: base.projectId,
    });

    expect(created).toMatchObject({
      principalId: target,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: base.projectId,
      grantedBy: orgAdmin,
    });
    expect(await version()).toBe(beforeVersion + 1);
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({
      action: "assignment.write",
      result: "allow",
      reason: "allowed",
      policyVersion: beforeVersion,
    });
    expect(audit.mutations).toHaveLength(1);
    expect(audit.mutations[0]).toMatchObject({
      action: "assignment.grant",
      policyVersion: beforeVersion + 1,
      assignmentId: created.id,
      targetPrincipalId: target,
      role: "secrets.reader",
      result: "allow",
    });
  });

  it("should scope project administrators to their own project", async () => {
    const ownTarget = await insertUser();
    const own = await service.create(projectAdmin, {
      principalId: ownTarget,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: base.projectId,
    });
    expect(own.scopeId).toBe(base.projectId);

    await expect(
      service.create(projectAdmin, {
        principalId: ownTarget,
        role: "secrets.reader",
        scopeType: "project",
        scopeId: projectB,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
  });

  it("should enforce the grant guards in order", async () => {
    await expect(
      service.create(manager, {
        principalId: target,
        role: "project.admin",
        scopeType: "project",
        scopeId: base.projectId,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });

    await expect(
      service.create(projectAdmin, {
        principalId: target,
        role: "auditor",
        scopeType: "project",
        scopeId: base.projectId,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });

    const orgProjectAdmin = await insertUser();
    await assign(orgProjectAdmin, "project.admin", "org", "org");
    await expect(
      service.create(orgProjectAdmin, {
        principalId: target,
        role: "org.admin",
        scopeType: "org",
        scopeId: "org",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });

    const created = await service.create(orgAdmin, {
      principalId: target,
      role: "org.admin",
      scopeType: "org",
      scopeId: "org",
    });
    expect(created.role).toBe("org.admin");

    const auditorTarget = await insertUser();
    const auditorGrant = await service.create(orgAdmin, {
      principalId: auditorTarget,
      role: "auditor",
      scopeType: "project",
      scopeId: base.projectId,
    });
    expect(auditorGrant.role).toBe("auditor");
  });

  it("should reject a control-plane grant to a service identity", async () => {
    await expect(
      service.create(orgAdmin, {
        principalId: base.serviceId,
        role: "org.admin",
        scopeType: "org",
        scopeId: "org",
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "service_control_plane" });

    const created = await service.create(projectAdmin, {
      principalId: base.serviceId,
      role: "secrets.reader",
      scopeType: "object",
      scopeId: base.secretId,
    });
    expect(created.role).toBe("secrets.reader");
  });

  it("should reject duplicate tuples and past expiry without changing the version", async () => {
    const before = await version();
    await expect(
      service.create(orgAdmin, {
        principalId: target,
        role: "secrets.reader",
        scopeType: "project",
        scopeId: base.projectId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "assignment_conflict" });
    expect(await version()).toBe(before);

    await expect(
      service.create(orgAdmin, {
        principalId: target,
        role: "secrets.reader",
        scopeType: "project",
        scopeId: projectB,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
    expect(await version()).toBe(before);
  });

  it("should reject an object grant with a non-reader role or a missing object", async () => {
    await expect(
      service.create(orgAdmin, {
        principalId: target,
        role: "secrets.officer",
        scopeType: "object",
        scopeId: base.secretId,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });

    await expect(
      service.create(orgAdmin, {
        principalId: target,
        role: "secrets.reader",
        scopeType: "object",
        scopeId: testUlid(7_999),
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
  });
});

describe("assignment deletion", () => {
  it("should protect the last active org administrator", async () => {
    const adminTarget = await insertUser();
    const sole = await service.create(orgAdmin, {
      principalId: adminTarget,
      role: "org.admin",
      scopeType: "org",
      scopeId: "org",
    });
    // Remove the second admin created by the guard test so only `sole` and the
    // original actor's org.admin remain.
    const second = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM role_assignments WHERE principal_id = :id AND role = 'org.admin'",
      { id: orgAdmin },
    );
    expect(second.records.length).toBeGreaterThan(0);

    // Deleting the target's last admin is allowed while the actor remains one.
    await service.delete(orgAdmin, sole.id);
    const remaining = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM role_assignments r JOIN principals p ON p.id = r.principal_id WHERE r.role = 'org.admin' AND p.status = 'active'",
    );
    expect(remaining.records[0]?.count).toBeGreaterThan(0);

    // Deleting the actor's own last admin is rejected.
    const actorAssignment = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM role_assignments WHERE principal_id = :id AND role = 'org.admin'",
      { id: orgAdmin },
    );
    const actorAssignmentId = actorAssignment.records[0]?.id;
    expect(actorAssignmentId).toBeDefined();
    // Remove any other admins first so the actor is the last one.
    await testDb.db.executeQuery(
      "DELETE FROM role_assignments WHERE role = 'org.admin' AND principal_id <> :id",
      { id: orgAdmin },
    );
    const beforeVersion = await version();
    await expect(service.delete(orgAdmin, actorAssignmentId ?? "")).rejects.toMatchObject({
      statusCode: 409,
      code: "last_org_admin",
    });
    expect(await version()).toBe(beforeVersion);
  });

  it("should hide an assignment outside the caller's project", async () => {
    const other = await insertUser();
    const foreign = await service.create(orgAdmin, {
      principalId: other,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: projectB,
    });
    const beforeVersion = await version();
    const beforeCount = await assignmentCount();
    audit.decisions.length = 0;
    await expect(service.delete(auditor, foreign.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "assignment_not_found",
    });
    expect(await version()).toBe(beforeVersion);
    expect(await assignmentCount()).toBe(beforeCount);
    expect(audit.decisions).toHaveLength(1);
  });

  it("should return 403 for a visible assignment the caller cannot write", async () => {
    const other = await insertUser();
    const visible = await service.create(orgAdmin, {
      principalId: other,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: base.projectId,
    });
    await expect(service.delete(auditor, visible.id)).rejects.toMatchObject({
      statusCode: 403,
      code: "access_denied",
    });
  });
});

describe("assignment listing", () => {
  it("should filter by principal, role, scope, and visibility", async () => {
    const listed = await service.list(orgAdmin, { principalId: target });
    expect(listed.every((assignment) => assignment.principalId === target)).toBe(true);
    expect(listed.length).toBeGreaterThan(0);

    const filtered = await service.list(orgAdmin, {
      role: "secrets.reader",
      scopeType: "project",
      scopeId: base.projectId,
    });
    expect(filtered.every((assignment) => assignment.role === "secrets.reader")).toBe(true);
    expect(filtered.every((assignment) => assignment.scopeId === base.projectId)).toBe(true);
  });

  it("should scope a project auditor to its project", async () => {
    const visible = await service.list(auditor, {});
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((assignment) => assignment.scopeType !== "org")).toBe(true);

    const reader = await insertUser();
    await expect(service.list(reader, {})).rejects.toMatchObject({
      statusCode: 403,
      code: "access_denied",
    });
  });
});

it("should serialize concurrent last-admin deletes", async () => {
  const first = await insertUser();
  const second = await insertUser();
  const firstAssignment = await assign(first, "org.admin", "org", "org");
  const secondAssignment = await assign(second, "org.admin", "org", "org");
  // Remove the existing admin so the two new admins are the only ones.
  await testDb.db.executeQuery(
    "DELETE FROM role_assignments WHERE role = 'org.admin' AND principal_id NOT IN (:first, :second)",
    { first, second },
  );

  const results = await Promise.allSettled([
    service.delete(first, firstAssignment),
    service.delete(second, secondAssignment),
  ]);
  const statuses = results.map((result) => (result.status === "fulfilled" ? "ok" : "rejected"));
  expect(statuses.sort()).toEqual(["ok", "rejected"]);
  const remaining = await testDb.db.executeQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM role_assignments WHERE role = 'org.admin'",
  );
  expect(remaining.records[0]?.count).toBe(1);
});

describe("assignment HTTP routes", () => {
  it("should create, list, explain, and delete through the admin listener", async () => {
    const httpAdmin = await insertUser();
    await assign(httpAdmin, "org.admin", "org", "org");
    const httpTarget = await insertUser();
    const environment = createServerEnvironment({
      OPENVAULT_DB_URL: testDb.url,
      OPENVAULT_PROXY_CIDRS:
        trustedHost === undefined
          ? "127.0.0.1/32,::1/128"
          : `127.0.0.1/32,::1/128,${trustedHost}/32`,
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
    const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
    const sessions = await app.getService<SessionService>("sessions");
    const session = await sessions.create({ principalId: httpAdmin, authMethod: "local" });
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${session.secretId}`,
      [CSRF_HEADER]: session.record.csrfToken,
      origin: environment.config.baseUrl.origin,
      "content-type": "application/json",
    };
    const send = (options: {
      readonly method?: string;
      readonly path: string;
      readonly body?: unknown;
    }) =>
      testRequest({
        method: options.method ?? "GET",
        port: handle.adminPort,
        path: options.path,
        host: trustedHost ?? "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    try {
      const created = await send({
        method: "POST",
        path: "/v1/admin/assignments",
        body: {
          principalId: httpTarget,
          role: "secrets.reader",
          scopeType: "project",
          scopeId: base.projectId,
        },
      });
      expect(created.status, created.body).toBe(201);
      const assignment = (created.json as { data: { id: string } }).data;
      expect(assignment.id).toHaveLength(26);

      const listed = await send({
        path: `/v1/admin/assignments?principalId=${httpTarget}`,
      });
      expect(listed.status, listed.body).toBe(200);
      expect((listed.json as { data: { assignments: unknown[] } }).data.assignments).toHaveLength(
        1,
      );

      const unauthenticated = await testRequest({
        port: handle.adminPort,
        path: `/v1/admin/access-explain?action=secret.read&scopeType=object&scopeId=${base.secretId}`,
        host: trustedHost ?? "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
      });
      expect(unauthenticated.status).toBe(401);

      const explained = await send({
        path: `/v1/admin/access-explain?action=secret.read&scopeType=object&scopeId=${base.secretId}`,
      });
      expect(explained.status, explained.body).toBe(200);
      expect(
        (explained.json as { data: { principals: unknown[] } }).data.principals.length,
      ).toBeGreaterThan(0);

      const deleted = await send({
        method: "DELETE",
        path: `/v1/admin/assignments/${assignment.id}`,
      });
      expect(deleted.status, deleted.body).toBe(204);
    } finally {
      await handle.stop();
      environment.cleanup();
    }
  }, 30_000);

  it("should return 429 after thirty assignment writes from one principal", async () => {
    const httpAdmin = await insertUser();
    await assign(httpAdmin, "org.admin", "org", "org");
    const environment = createServerEnvironment({
      OPENVAULT_DB_URL: testDb.url,
      OPENVAULT_PROXY_CIDRS:
        trustedHost === undefined
          ? "127.0.0.1/32,::1/128"
          : `127.0.0.1/32,::1/128,${trustedHost}/32`,
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
    const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
    const sessions = await app.getService<SessionService>("sessions");
    const session = await sessions.create({ principalId: httpAdmin, authMethod: "local" });
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${session.secretId}`,
      [CSRF_HEADER]: session.record.csrfToken,
      origin: environment.config.baseUrl.origin,
      "content-type": "application/json",
    };
    const send = () =>
      testRequest({
        method: "POST",
        port: handle.adminPort,
        path: "/v1/admin/assignments",
        host: trustedHost ?? "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
        headers,
        body: JSON.stringify({}),
      });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await send()).status).toBe(422);
      }
      expect((await send()).status).toBe(429);
    } finally {
      await handle.stop();
      environment.cleanup();
    }
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityServiceError } from "../../src/identity/errors.js";
import { IdentityAuthorizer } from "../../src/identity/identity-authorizer.js";
import { createIdentityRuntime } from "../../src/identity/identity-runtime.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

class RecordingAudit implements PolicyAuditPort {
  readonly decisions: PolicyDecisionEvent[] = [];

  async recordDecision(event: PolicyDecisionEvent): Promise<void> {
    this.decisions.push(event);
  }

  async recordMutation(_event: PolicyMutationEvent): Promise<void> {}
}

let testDb: TestDatabase;
let base: BaseFixture;
let projectB: string;
let authorizer: IdentityAuthorizer;
let audit: RecordingAudit;
let nextUser = 3_000;
let nextAssignment = 4_000;

async function insertUser(): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Identity RBAC ${id}`, email: `identity-rbac-${id.toLowerCase()}@example.test` },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project",
  scopeId: string,
  expiresAt?: string,
): Promise<void> {
  nextAssignment += 1;
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)`,
    {
      id: testUlid(nextAssignment),
      principalId,
      role,
      scopeType,
      scopeId,
      grantedBy: base.userId,
      expiresAt: expiresAt ?? null,
    },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  projectB = testUlid(2_900);
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'identity-rbac-b')", {
    id: projectB,
  });
  audit = new RecordingAudit();
  authorizer = new IdentityAuthorizer(
    testDb.db,
    new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit,
    }),
  );
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("identity authorizer bridge", () => {
  it("should preserve org and project coverage", async () => {
    const orgAdmin = await insertUser();
    await assign(orgAdmin, "org.admin", "org", "org");
    expect(await authorizer.can("identity.create", orgAdmin, base.projectId)).toBe(true);
    expect(await authorizer.can("identity.read", orgAdmin, projectB)).toBe(true);
    expect(await authorizer.canReadAll(orgAdmin)).toBe(true);

    const orgProjectAdmin = await insertUser();
    await assign(orgProjectAdmin, "project.admin", "org", "org");
    expect(await authorizer.can("identity.revoke", orgProjectAdmin, projectB)).toBe(true);
    expect(await authorizer.canReadAll(orgProjectAdmin)).toBe(true);

    const projectAdmin = await insertUser();
    await assign(projectAdmin, "project.admin", "project", base.projectId);
    expect(await authorizer.can("identity.create", projectAdmin, base.projectId)).toBe(true);
    expect(await authorizer.can("identity.create", projectAdmin, projectB)).toBe(false);
    expect(await authorizer.hasAny("identity.create", projectAdmin)).toBe(true);
    expect(await authorizer.canReadAll(projectAdmin)).toBe(false);
    expect(await authorizer.readableProjectIds(projectAdmin)).toEqual([base.projectId]);
  });

  it("should keep auditors read-only and ignore project-scoped org.admin", async () => {
    const auditor = await insertUser();
    await assign(auditor, "auditor", "project", base.projectId);
    expect(await authorizer.can("identity.read", auditor, base.projectId)).toBe(true);
    expect(await authorizer.can("identity.create", auditor, base.projectId)).toBe(false);
    expect(await authorizer.can("identity.revoke", auditor, base.projectId)).toBe(false);
    expect(await authorizer.readableProjectIds(auditor)).toEqual([base.projectId]);
    expect(await authorizer.hasAny("identity.create", auditor)).toBe(false);

    const invalidAdmin = await insertUser();
    await assign(invalidAdmin, "org.admin", "project", base.projectId);
    expect(await authorizer.can("identity.create", invalidAdmin, base.projectId)).toBe(false);
    expect(await authorizer.canReadAll(invalidAdmin)).toBe(false);
    expect(await authorizer.readableProjectIds(invalidAdmin)).toEqual([]);
  });

  it("should ignore expired assignments and service principals", async () => {
    const expired = await insertUser();
    await assign(expired, "org.admin", "org", "org", "2020-01-01T00:00:00.000Z");
    expect(await authorizer.can("identity.read", expired, base.projectId)).toBe(false);
    expect(await authorizer.canReadAll(expired)).toBe(false);
    expect(await authorizer.hasAny("identity.read", expired)).toBe(false);

    await assign(base.serviceId, "org.admin", "org", "org");
    expect(await authorizer.can("identity.read", base.serviceId, base.projectId)).toBe(false);
    expect(await authorizer.canReadAll(base.serviceId)).toBe(false);
    expect(await authorizer.hasAny("identity.read", base.serviceId)).toBe(false);
    expect(await authorizer.readableProjectIds(base.serviceId)).toEqual([]);
  });
});

describe("identity list and decision evidence", () => {
  it("should return no scope for a user with no assignment", async () => {
    const user = await insertUser();
    expect(await authorizer.readScope(user)).toBeUndefined();
    expect(await authorizer.canReadAll(user)).toBe(false);
    expect(await authorizer.readableProjectIds(user)).toEqual([]);
    expect(await authorizer.can("identity.read", user, base.projectId)).toBe(false);
  });

  it("should return all or project scope and audit one list decision", async () => {
    const orgAdmin = await insertUser();
    await assign(orgAdmin, "org.admin", "org", "org");
    audit.decisions.length = 0;
    expect(await authorizer.readScope(orgAdmin)).toEqual({ kind: "all" });
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({
      action: "identity.read",
      result: "allow",
      scopeType: "org",
    });

    const auditor = await insertUser();
    await assign(auditor, "auditor", "project", base.projectId);
    audit.decisions.length = 0;
    expect(await authorizer.readScope(auditor)).toEqual({
      kind: "projects",
      projectIds: [base.projectId],
    });
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({
      action: "identity.read",
      result: "allow",
      scopeType: "project",
    });
  });

  it("should audit one event per can check and fail a denied list", async () => {
    const orgAdmin = await insertUser();
    await assign(orgAdmin, "org.admin", "org", "org");
    audit.decisions.length = 0;
    await authorizer.can("identity.read", orgAdmin, base.projectId);
    expect(audit.decisions).toHaveLength(1);
    await authorizer.hasAny("identity.read", orgAdmin);
    expect(audit.decisions).toHaveLength(2);
  });

  it("should deny the identity list with no assignment", async () => {
    const user = await insertUser();
    const environment = createServerEnvironment({ OPENVAULT_DB_URL: testDb.url });
    const runtime = createIdentityRuntime({
      database: testDb.db,
      config: environment.config,
    });
    try {
      await expect(runtime.service.list(user)).rejects.toMatchObject({
        statusCode: 403,
        code: "access_denied",
      });
      await expect(runtime.service.list(user)).rejects.toBeInstanceOf(IdentityServiceError);
    } finally {
      environment.cleanup();
    }
  });
});

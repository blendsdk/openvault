import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentService } from "../../src/rbac/assignment-service.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
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
let service: AssignmentService;
let projectB: string;
let secretB: string;
let orgAdmin: string;
let projectAdmin: string;
let projectBAdmin: string;
let reader: string;
let objectReader: string;
let noAccess: string;
let nextUser = 9_000;
let nextAssignment = 9_500;

async function insertUser(): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Explain ${id}`, email: `explain-${id.toLowerCase()}@example.test` },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
): Promise<void> {
  nextAssignment += 1;
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy)`,
    {
      id: testUlid(nextAssignment),
      principalId,
      role,
      scopeType,
      scopeId,
      grantedBy: base.userId,
    },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  projectB = testUlid(8_900);
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'explain-b')", {
    id: projectB,
  });
  secretB = testUlid(8_901);
  await testDb.db.executeQuery(
    "INSERT INTO secrets (id, project_id, name) VALUES (:id, :projectId, 'explain-secret-b')",
    { id: secretB, projectId: projectB },
  );

  orgAdmin = await insertUser();
  projectAdmin = await insertUser();
  projectBAdmin = await insertUser();
  reader = await insertUser();
  objectReader = await insertUser();
  noAccess = await insertUser();
  await assign(orgAdmin, "org.admin", "org", "org");
  await assign(projectAdmin, "project.admin", "project", base.projectId);
  await assign(projectBAdmin, "project.admin", "project", projectB);
  await assign(reader, "reader", "project", base.projectId);
  await assign(objectReader, "secrets.reader", "object", base.secretId);

  await testDb.db.executeQuery(
    `INSERT INTO consumers
       (id, principal_id, project_id, compose_project, compose_service, hostname,
        manifest_hash, state, first_seen, last_seen)
     VALUES
       (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
        'ok', now() - interval '1 hour', now())`,
    {
      id: testUlid(8_902),
      principalId: base.serviceId,
      projectId: base.projectId,
      manifestHash: `sha256:${"c".repeat(64)}`,
    },
  );
  await assign(base.serviceId, "secrets.reader", "object", base.secretId);

  audit = new RecordingAudit();
  service = new AssignmentService({
    database: testDb.db,
    repository: new PolicyRepository(testDb.db),
    policy: new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit,
    }),
    audit,
  });
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("access explanation", () => {
  it("should list every principal with an effective permission", async () => {
    const result = await service.explain(orgAdmin, {
      action: "secret.read",
      scopeType: "object",
      scopeId: base.secretId,
    });

    expect(result.action).toBe("secret.read");
    expect(result.scope).toEqual({ type: "object", id: base.secretId });
    expect(result.policyVersion).toBeGreaterThan(0);
    const principalIds = result.principals.map((entry) => entry.principalId);
    expect(principalIds).toEqual(
      expect.arrayContaining([orgAdmin, projectAdmin, objectReader, base.serviceId]),
    );
    expect(principalIds).not.toContain(reader);
    expect(principalIds).not.toContain(noAccess);
    expect(principalIds).not.toContain(projectBAdmin);
  });

  it("should include consumer metadata for a service principal", async () => {
    const result = await service.explain(orgAdmin, {
      action: "secret.read",
      scopeType: "object",
      scopeId: base.secretId,
    });
    const entry = result.principals.find((candidate) => candidate.principalId === base.serviceId);
    expect(entry).toMatchObject({
      kind: "service",
      role: "secrets.reader",
      consumer: {
        composeProject: "payments",
        composeService: "api",
        hostname: "api-1",
        state: "ok",
      },
    });
    const user = result.principals.find((candidate) => candidate.principalId === orgAdmin);
    expect(user?.consumer).toBeNull();
  });

  it("should hide a foreign project from a project-scoped auditor", async () => {
    const auditor = await insertUser();
    await assign(auditor, "auditor", "project", base.projectId);
    await expect(
      service.explain(auditor, {
        action: "secret.read",
        scopeType: "project",
        scopeId: projectB,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });

    const own = await service.explain(auditor, {
      action: "secret.read",
      scopeType: "project",
      scopeId: base.projectId,
    });
    expect(own.principals.length).toBeGreaterThan(0);
  });

  it("should return 404 for a missing or deleted object", async () => {
    await expect(
      service.explain(orgAdmin, {
        action: "secret.read",
        scopeType: "object",
        scopeId: testUlid(8_999),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });

    await testDb.db.executeQuery("UPDATE secrets SET deleted_at = now() WHERE id = :id", {
      id: secretB,
    });
    await expect(
      service.explain(orgAdmin, {
        action: "secret.read",
        scopeType: "object",
        scopeId: secretB,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });
  });

  it("should reject a data-plane action at org scope and an unresolvable object type", async () => {
    await expect(
      service.explain(orgAdmin, {
        action: "secret.read",
        scopeType: "org",
        scopeId: "org",
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });

    await expect(
      service.explain(orgAdmin, {
        action: "assignment.read",
        scopeType: "object",
        scopeId: base.secretId,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
  });

  it("should hide the resource from a caller without assignment.read", async () => {
    await expect(
      service.explain(noAccess, {
        action: "secret.read",
        scopeType: "object",
        scopeId: base.secretId,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });
  });

  it("should explain an identity resource with project ownership", async () => {
    const result = await service.explain(orgAdmin, {
      action: "identity.read",
      scopeType: "object",
      scopeId: base.serviceId,
      objectType: "identity",
    });
    expect(result.scope).toEqual({ type: "project", id: base.projectId });
    expect(result.principals.map((entry) => entry.principalId)).toEqual(
      expect.arrayContaining([orgAdmin, projectAdmin]),
    );
  });
});

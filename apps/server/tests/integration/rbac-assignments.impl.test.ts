import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentService } from "../../src/rbac/assignment-service.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

class SwitchableAudit implements PolicyAuditPort {
  readonly decisions: PolicyDecisionEvent[] = [];
  readonly mutations: PolicyMutationEvent[] = [];
  failMutations = false;

  async recordDecision(event: PolicyDecisionEvent): Promise<void> {
    this.decisions.push(event);
  }

  async recordMutation(event: PolicyMutationEvent): Promise<void> {
    if (this.failMutations) {
      throw new Error("audit unavailable");
    }
    this.mutations.push(event);
  }
}

let testDb: TestDatabase;
let base: BaseFixture;
let audit: SwitchableAudit;
let service: AssignmentService;
let orgAdmin: string;
let target: string;
let nextUser = 11_000;
let nextAssignment = 12_000;

async function insertUser(): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    {
      id,
      name: `Assignment Impl ${id}`,
      email: `assignment-impl-${id.toLowerCase()}@example.test`,
    },
  );
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  orgAdmin = await insertUser();
  target = await insertUser();
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: testUlid(11_100), principalId: orgAdmin },
  );
  audit = new SwitchableAudit();
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

describe("assignment transaction internals", () => {
  it("should roll back the row and version when the mutation audit fails", async () => {
    const beforeVersion = await new PolicyRepository(testDb.db).readPolicyVersion();
    const beforeCount = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM role_assignments",
    );
    audit.failMutations = true;
    try {
      await expect(
        service.create(orgAdmin, {
          principalId: target,
          role: "secrets.reader",
          scopeType: "project",
          scopeId: base.projectId,
        }),
      ).rejects.toBeInstanceOf(PolicyUnavailableError);
    } finally {
      audit.failMutations = false;
    }
    expect(await new PolicyRepository(testDb.db).readPolicyVersion()).toBe(beforeVersion);
    const afterCount = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM role_assignments",
    );
    expect(afterCount.records[0]?.count).toBe(beforeCount.records[0]?.count);
  });

  it("should let an org admin clean up an assignment whose object row is gone", async () => {
    const assignmentId = testUlid(nextAssignment++);
    await testDb.db.executeQuery(
      `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
       VALUES (:id, :principalId, 'secrets.reader', 'object', :scopeId, :grantedBy)`,
      {
        id: assignmentId,
        principalId: target,
        scopeId: testUlid(11_999),
        grantedBy: orgAdmin,
      },
    );

    await expect(service.delete(orgAdmin, assignmentId)).resolves.toBeUndefined();
    const row = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM role_assignments WHERE id = :id",
      { id: assignmentId },
    );
    expect(row.records[0]?.count).toBe(0);
  });
});

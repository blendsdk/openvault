import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../../src/rbac/audit.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

class RecordingAudit implements PolicyAuditPort {
  async recordDecision(_event: PolicyDecisionEvent): Promise<void> {}
  async recordMutation(_event: PolicyMutationEvent): Promise<void> {}
}

let testDb: TestDatabase;
let base: BaseFixture;
let policy: PolicyService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: new RecordingAudit(),
  });
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
});

const ZERO = {
  canRead: false,
  canWrite: false,
  canDelete: false,
  canRecover: false,
  canPurge: false,
  canManage: false,
  canReadPrivate: false,
} as const;

describe("zero capability projection", () => {
  it("should return every capability false for an inactive principal", async () => {
    const id = newUlid();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status, disabled_at)
       VALUES (:id, 'user', 'Disabled User', :email, 'disabled', now())`,
      { id, email: `${id.toLowerCase()}@example.test` },
    );
    await testDb.db.executeQuery(
      `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
       VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
      { id: newUlid(), principalId: id },
    );

    expect(
      await policy.capabilitiesFor(id, {
        type: "certificate",
        id: base.certificateId,
        projectId: base.projectId,
      }),
    ).toEqual(ZERO);
  });

  it("should return every capability false for a principal with no snapshot", async () => {
    const resources = [
      { type: "certificate" as const, id: base.certificateId, projectId: base.projectId },
      { type: "secret" as const, id: base.secretId, projectId: base.projectId },
    ];
    const result = await policy.capabilitiesForMany(newUlid(), resources);
    expect(result.get(base.certificateId)).toEqual(ZERO);
    expect(result.get(base.secretId)).toEqual(ZERO);
  });
});

import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../../src/rbac/audit.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { type AuditActors, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

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
let actors: AuditActors;
let policy: PolicyService;

async function insertUser(label: string): Promise<string> {
  const id = newUlid();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: label, email: `${id.toLowerCase()}@example.test` },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: newUlid(), principalId, role, scopeType, scopeId },
  );
}

function certificate() {
  return { type: "certificate" as const, id: base.certificateId, projectId: base.projectId };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: new RecordingAudit(),
  });
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
});

describe("certificate capability flags", () => {
  it("should report list-only access for a certificate reader", async () => {
    const reader = await insertUser("Certificate Reader");
    await assign(reader, "certificates.reader", "project", base.projectId);

    expect(await policy.capabilitiesFor(reader, certificate())).toEqual({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canRecover: false,
      canPurge: false,
      canManage: false,
      canReadPrivate: false,
    });
  });

  it("should report recover and private-key access for a certificate officer", async () => {
    const officer = await insertUser("Certificate Officer");
    await assign(officer, "certificates.officer", "project", base.projectId);

    expect(await policy.capabilitiesFor(officer, certificate())).toEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRecover: true,
      canPurge: false,
      canManage: false,
      canReadPrivate: true,
    });
  });

  it("should report purge access for a project administrator", async () => {
    const projectAdmin = await insertUser("Project Admin");
    await assign(projectAdmin, "project.admin", "project", base.projectId);

    expect(await policy.capabilitiesFor(projectAdmin, certificate())).toEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRecover: true,
      canPurge: true,
      canManage: true,
      canReadPrivate: true,
    });
  });

  it("should report every certificate capability for an organization administrator", async () => {
    expect(await policy.capabilitiesFor(actors.orgAdmin, certificate())).toEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRecover: true,
      canPurge: true,
      canManage: true,
      canReadPrivate: true,
    });
  });
});

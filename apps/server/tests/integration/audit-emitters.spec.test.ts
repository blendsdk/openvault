import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from "../../src/identity/identity-runtime.js";
import { createPolicyRuntime } from "../../src/rbac/runtime.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let identity: IdentityRuntime;
let actors: AuditActors;

async function events(action: string): Promise<
  readonly {
    result: string;
    project_id: string | null;
    object_type: string | null;
    object_id: string | null;
  }[]
> {
  const rows = await testDb.db.executeQuery<{
    result: string;
    project_id: string | null;
    object_type: string | null;
    object_id: string | null;
  }>(
    "SELECT result, project_id, object_type, object_id FROM audit_events WHERE action = :action ORDER BY id ASC",
    { action },
  );
  return rows.records;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring });
  const policyRuntime = createPolicyRuntime({
    database: testDb.db,
    audit: core.policyAudit,
  });
  identity = createIdentityRuntime({
    database: testDb.db,
    config: environment.config,
    policyRuntime,
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

describe("identity audit emitters", () => {
  it("should record one allow decision for identity creation", async () => {
    const created = await identity.service.create(
      actors.orgAdmin,
      { name: "audit-service-create", projectId: base.projectId },
      { requestId: "identity-create" },
    );
    expect(created.projectId).toBe(base.projectId);

    const rows = await events("identity.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "allow",
      project_id: base.projectId,
      object_type: "project",
      object_id: base.projectId,
    });
  });

  it("should record one allow decision for revoke and join-token issuance", async () => {
    const created = await identity.service.create(actors.orgAdmin, {
      name: "audit-service-actions",
      projectId: base.projectId,
    });
    await identity.service.revoke(actors.orgAdmin, created.id, { requestId: "identity-revoke" });
    expect(await events("identity.revoke")).toHaveLength(1);
    expect((await events("identity.revoke"))[0]).toMatchObject({
      result: "allow",
      object_type: "identity",
      object_id: created.id,
    });

    const tokenTarget = await identity.service.create(actors.orgAdmin, {
      name: "audit-service-token",
      projectId: base.projectId,
    });
    await identity.service.issueJoinToken(actors.orgAdmin, tokenTarget.id, undefined, {
      requestId: "identity-token",
    });
    const tokenEvents = await events("identity.join_token");
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]).toMatchObject({
      result: "allow",
      object_type: "identity",
      object_id: tokenTarget.id,
    });
  });

  it("should record one deny decision for a denied revoke without a second visibility event", async () => {
    const target = await identity.service.create(actors.orgAdmin, {
      name: "audit-service-denied",
      projectId: base.projectId,
    });
    await expect(
      identity.service.revoke(actors.projectAuditor, target.id, { requestId: "identity-denied" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const rows = await events("identity.revoke");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("deny");
  });

  it("should record one deny decision for an identity hidden by project scope", async () => {
    const target = await identity.service.create(actors.orgAdmin, {
      name: "audit-service-hidden",
      projectId: base.projectId,
    });
    await expect(
      identity.service.get(actors.otherAuditor, target.id, { requestId: "identity-hidden" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await events("identity.read")).toHaveLength(1);
    expect((await events("identity.read"))[0]?.result).toBe("deny");
  });

  it("should record one list decision without extra visibility events", async () => {
    await identity.service.list(actors.orgAdmin, base.projectId, { requestId: "identity-list" });
    expect(await events("identity.read")).toHaveLength(1);
  });
});

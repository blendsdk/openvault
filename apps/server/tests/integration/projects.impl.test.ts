import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { ProjectService } from "../../src/projects/service.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let projects: ProjectService;
let policy: PolicyService;

function name(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

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
  scopeType: "org" | "project",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: newUlid(), principalId, role, scopeType, scopeId },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring });
  const repository = new PolicyRepository(testDb.db);
  policy = new PolicyService({ repository, audit: core.policyAudit });
  projects = new ProjectService({
    database: testDb.db,
    repository: new ProjectRepository(testDb.db),
    policy,
    audit: core.writer,
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

describe("project implementation", () => {
  it("should serialize a rename conflict so exactly one name wins", async () => {
    const first = await projects.create(actors.orgAdmin, { name: name("first") });
    const second = await projects.create(actors.orgAdmin, { name: name("second") });
    const target = name("target");

    const results = await Promise.allSettled([
      projects.update(actors.orgAdmin, first.id, { name: target }),
      projects.update(actors.orgAdmin, second.id, { name: target }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM projects WHERE name = :target",
      { target },
    );
    expect(count.records[0]?.count).toBe(1);
  });

  it("should reject a rename after a concurrent soft delete", async () => {
    const created = await projects.create(actors.orgAdmin, { name: name("race") });
    await projects.delete(actors.orgAdmin, created.id);
    await expect(
      projects.update(actors.orgAdmin, created.id, { name: name("renamed") }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });

  it("should ignore a project-scope assignment after its project is deleted", async () => {
    const created = await projects.create(actors.orgAdmin, { name: name("hidden") });
    const reader = await insertUser("Hidden Reader");
    await assign(reader, "reader", "project", created.id);
    expect(
      (await policy.authorize(reader, "project.read", { type: "project", id: created.id })).allowed,
    ).toBe(true);
    await projects.delete(actors.orgAdmin, created.id);
    const decision = await policy.authorize(reader, "project.read", {
      type: "project",
      id: created.id,
    });
    expect(decision.allowed).toBe(false);
  });

  it("should record one allow and one error for a duplicate create", async () => {
    const target = name("audit");
    await projects.create(actors.orgAdmin, { name: target });
    await expect(projects.create(actors.orgAdmin, { name: target })).rejects.toMatchObject({
      statusCode: 409,
    });
    const rows = await testDb.db.executeQuery<{ result: string }>(
      "SELECT result FROM audit_events WHERE action = 'project.create' ORDER BY id ASC",
    );
    expect(rows.records.map((row) => row.result)).toEqual(["allow", "error"]);
  });
});

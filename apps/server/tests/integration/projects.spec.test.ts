import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { ProjectServiceError } from "../../src/projects/errors.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { ProjectService } from "../../src/projects/service.js";
import { AssignmentService } from "../../src/rbac/assignment-service.js";
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
let assignments: AssignmentService;
let policy: PolicyService;
let currentTime = Date.parse("2026-11-04T12:00:00.000Z");

const clock = (): number => currentTime;

/** Builds a unique valid project name for one test run. */
function projectName(prefix: string): string {
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
  scopeType: "org" | "project" | "object",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: newUlid(), principalId, role, scopeType, scopeId },
  );
}

async function projectRow(id: string): Promise<{ deleted_at: Date | null } | undefined> {
  const result = await testDb.db.executeQuery<{ deleted_at: Date | null }>(
    "SELECT deleted_at FROM projects WHERE id = :id",
    { id },
  );
  return result.records[0];
}

async function auditRows(action: string): Promise<
  readonly {
    result: string;
    object_type: string | null;
    object_id: string | null;
    project_id: string | null;
  }[]
> {
  const result = await testDb.db.executeQuery<{
    result: string;
    object_type: string | null;
    object_id: string | null;
    project_id: string | null;
  }>(
    "SELECT result, object_type, object_id, project_id FROM audit_events WHERE action = :action ORDER BY id ASC",
    {
      action,
    },
  );
  return result.records;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring, now: clock });
  const repository = new PolicyRepository(testDb.db);
  policy = new PolicyService({ repository, audit: core.policyAudit, now: clock });
  projects = new ProjectService({
    database: testDb.db,
    repository: new ProjectRepository(testDb.db),
    policy,
    audit: core.writer,
    now: clock,
  });
  assignments = new AssignmentService({
    database: testDb.db,
    repository,
    policy,
    audit: core.policyAudit,
    now: clock,
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-11-04T12:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("project lifecycle", () => {
  it("should create a project and record a project-scoped decision", async () => {
    const name = projectName("payments");
    const created = await projects.create(
      actors.orgAdmin,
      { name },
      {
        requestId: "project-create",
      },
    );
    expect(created.name).toBe(name);
    expect(created.deletedAt).toBeNull();
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await projectRow(created.id))?.deleted_at).toBeNull();

    const rows = await auditRows("project.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "allow",
      object_type: "project",
      object_id: created.id,
      project_id: created.id,
    });
  });

  it("should reject a duplicate active project name without a second allow", async () => {
    const name = projectName("payments");
    await projects.create(actors.orgAdmin, { name });
    await expect(projects.create(actors.orgAdmin, { name })).rejects.toMatchObject({
      statusCode: 409,
      code: "project_name_conflict",
    });
    const rows = await auditRows("project.create");
    expect(rows.filter((row) => row.result === "allow")).toHaveLength(1);
    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM projects WHERE name = :name",
      { name },
    );
    expect(count.records[0]?.count).toBe(1);
  });

  it("should list only projects covered by a project-scope reader grant", async () => {
    await projects.create(actors.orgAdmin, { name: projectName("payments") });
    await projects.create(actors.orgAdmin, { name: projectName("billing") });
    await assign(actors.projectAuditor, "reader", "project", base.projectId);

    const visible = await projects.list(actors.projectAuditor, { requestId: "project-list" });
    expect(visible.map((project) => project.id).sort()).toEqual([base.projectId]);
  });

  it("should rename a project", async () => {
    const created = await projects.create(actors.orgAdmin, { name: projectName("payments") });
    const renamed = await projects.update(
      actors.orgAdmin,
      created.id,
      { name: projectName("payments-prod") },
      { requestId: "project-rename" },
    );
    expect(renamed.name).toMatch(/^payments-prod-/);
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("should soft delete a project and hide a repeat delete", async () => {
    const created = await projects.create(actors.orgAdmin, { name: projectName("payments") });
    await projects.delete(actors.orgAdmin, created.id, { requestId: "project-delete" });
    expect((await projectRow(created.id))?.deleted_at).not.toBeNull();
    await expect(
      projects.delete(actors.orgAdmin, created.id, { requestId: "project-delete-2" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
    await expect(
      projects.get(actors.orgAdmin, created.id, { requestId: "project-get" }),
    ).rejects.toBeInstanceOf(ProjectServiceError);
  });

  it("should hide project resources, assignments, and explanations after delete", async () => {
    const created = await projects.create(actors.orgAdmin, { name: projectName("hidden") });
    const secretId = newUlid();
    await testDb.db.executeQuery(
      "INSERT INTO secrets (id, project_id, name) VALUES (:id, :projectId, 'hidden-secret')",
      { id: secretId, projectId: created.id },
    );
    await assign(actors.projectAuditor, "secrets.reader", "object", secretId);

    await projects.delete(actors.orgAdmin, created.id, { requestId: "project-delete" });

    await expect(
      projects.get(actors.orgAdmin, created.id, { requestId: "project-get-hidden" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
    const listed = await assignments.list(
      actors.orgAdmin,
      { scopeType: "project", scopeId: created.id },
      { requestId: "assignment-list-hidden" },
    );
    expect(listed).toEqual([]);
    await expect(
      assignments.explain(
        actors.orgAdmin,
        { action: "secret.read", scopeType: "object", scopeId: secretId },
        { requestId: "explain-hidden" },
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });
    await expect(
      assignments.create(
        actors.orgAdmin,
        {
          principalId: actors.projectAuditor,
          role: "secrets.reader",
          scopeType: "object",
          scopeId: secretId,
        },
        { requestId: "assignment-hidden" },
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "resource_not_found" });
  });

  it("should reject a project admin updating another project with 404", async () => {
    const created = await projects.create(actors.orgAdmin, { name: projectName("payments") });
    const admin = await insertUser("Project Admin");
    await assign(admin, "project.admin", "project", base.projectId);
    await expect(
      projects.update(
        admin,
        created.id,
        { name: projectName("other") },
        { requestId: "project-update" },
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });

  it("should reject a project admin deleting its own project with 403", async () => {
    const admin = await insertUser("Project Admin Delete");
    await assign(admin, "project.admin", "project", base.projectId);
    await expect(
      projects.delete(admin, base.projectId, { requestId: "project-delete-denied" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
  });

  it("should return 404 for an unknown or deleted project", async () => {
    await expect(
      projects.get(actors.orgAdmin, newUlid(), { requestId: "project-missing" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });

  it("should return 404 for a reader requesting a project outside its grant", async () => {
    const created = await projects.create(actors.orgAdmin, { name: projectName("outside") });
    const reader = await insertUser("Outside Reader");
    await assign(reader, "reader", "project", base.projectId);
    await expect(
      projects.get(reader, created.id, { requestId: "project-outside" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityAuthorizer } from "../../../src/identity/identity-authorizer.js";
import { type BaseFixture, seedBase, testUlid } from "../helpers/fixtures.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let authorizer: IdentityAuthorizer;
let projectA: string;
let projectB: string;
let nextUser = 620;
let nextRole = 720;

async function insertUser(): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Authorizer ${id}`, email: `authorizer-${id.toLowerCase()}@example.test` },
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
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)`,
    {
      id: testUlid(nextRole++),
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
  authorizer = new IdentityAuthorizer(testDb.db);
  projectA = base.projectId;
  projectB = testUlid(601);
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'impl-project-b')", {
    id: projectB,
  });
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
});

describe("identity authorization internals", () => {
  it("should let org roles cover every project and project roles cover only their project", async () => {
    const orgAdmin = await insertUser();
    await assign(orgAdmin, "org.admin", "org", "org");
    expect(await authorizer.can("identity.create", orgAdmin, projectA)).toBe(true);
    expect(await authorizer.can("identity.read", orgAdmin, projectB)).toBe(true);
    expect(await authorizer.canReadAll(orgAdmin)).toBe(true);

    const orgProjectAdmin = await insertUser();
    await assign(orgProjectAdmin, "project.admin", "org", "org");
    expect(await authorizer.can("identity.revoke", orgProjectAdmin, projectB)).toBe(true);
    expect(await authorizer.canReadAll(orgProjectAdmin)).toBe(true);

    const projectAdmin = await insertUser();
    await assign(projectAdmin, "project.admin", "project", projectA);
    expect(await authorizer.can("identity.create", projectAdmin, projectA)).toBe(true);
    expect(await authorizer.can("identity.create", projectAdmin, projectB)).toBe(false);
    expect(await authorizer.hasAny("identity.create", projectAdmin)).toBe(true);
    expect(await authorizer.canReadAll(projectAdmin)).toBe(false);
    expect(await authorizer.readableProjectIds(projectAdmin)).toEqual([projectA]);
  });

  it("should make auditors read-only and ignore project-scoped org.admin", async () => {
    const auditor = await insertUser();
    await assign(auditor, "auditor", "project", projectA);
    expect(await authorizer.can("identity.read", auditor, projectA)).toBe(true);
    expect(await authorizer.can("identity.create", auditor, projectA)).toBe(false);
    expect(await authorizer.can("identity.revoke", auditor, projectA)).toBe(false);
    expect(await authorizer.readableProjectIds(auditor)).toEqual([projectA]);
    expect(await authorizer.hasAny("identity.create", auditor)).toBe(false);

    const invalidAdmin = await insertUser();
    await assign(invalidAdmin, "org.admin", "project", projectA);
    expect(await authorizer.can("identity.create", invalidAdmin, projectA)).toBe(false);
    expect(await authorizer.canReadAll(invalidAdmin)).toBe(false);
    expect(await authorizer.readableProjectIds(invalidAdmin)).toEqual([]);
  });

  it("should ignore expired assignments and service principals", async () => {
    const expired = await insertUser();
    await assign(expired, "org.admin", "org", "org", "2020-01-01T00:00:00.000Z");
    expect(await authorizer.can("identity.read", expired, projectA)).toBe(false);
    expect(await authorizer.canReadAll(expired)).toBe(false);
    expect(await authorizer.hasAny("identity.read", expired)).toBe(false);

    expect(await authorizer.can("identity.read", base.serviceId, projectA)).toBe(false);
    expect(await authorizer.readableProjectIds(base.serviceId)).toEqual([]);
  });

  it("should return empty scopes for a user with no assignments", async () => {
    const user = await insertUser();
    expect(await authorizer.canReadAll(user)).toBe(false);
    expect(await authorizer.readableProjectIds(user)).toEqual([]);
    expect(await authorizer.can("identity.read", user, projectA)).toBe(false);
  });
});

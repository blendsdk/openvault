import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from "../../src/identity/identity-runtime.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let base: BaseFixture;
let runtime: IdentityRuntime;
let actorId: string;
let nextSeed = 800;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  environment = createServerEnvironment({ OPENVAULT_DB_URL: testDb.url });
  runtime = createIdentityRuntime({ database: testDb.db, config: environment.config });

  actorId = testUlid(nextSeed++);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    {
      id: actorId,
      name: "Identity Operator",
      email: `operator-${actorId.toLowerCase()}@example.test`,
    },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: testUlid(nextSeed++), principalId: actorId },
  );
}, 30_000);

afterAll(async () => {
  if (environment !== undefined) {
    environment.cleanup();
  }
  if (testDb !== undefined) {
    await testDb.cleanup();
  }
});

async function createService(name = `impl-${nextSeed}`): Promise<string> {
  const identity = await runtime.service.create(actorId, {
    name: `${name}-${nextSeed++}`,
    projectId: base.projectId,
  });
  return identity.id;
}

describe("identity lifecycle internals", () => {
  it("should persist the issuing actor and reject out-of-range TTLs", async () => {
    const serviceId = await createService("token");
    const issued = await runtime.service.issueJoinToken(actorId, serviceId, 60);
    expect(issued.token).toHaveLength(43);

    const row = await testDb.db.executeQuery<{
      created_by: string;
      token_hash: Buffer;
    }>("SELECT created_by, token_hash FROM join_tokens WHERE id = :id", { id: issued.id });
    expect(row.records[0]?.created_by).toBe(actorId);
    expect(row.records[0]?.token_hash).toHaveLength(32);

    for (const ttl of [0, 86_401]) {
      await expect(runtime.service.issueJoinToken(actorId, serviceId, ttl)).rejects.toMatchObject({
        code: "validation_error",
        statusCode: 422,
      });
    }
  });

  it("should reject token issuance and creation for inactive targets", async () => {
    const serviceId = await createService("inactive");
    await testDb.db.executeQuery(
      "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
      { id: serviceId },
    );
    await expect(runtime.service.issueJoinToken(actorId, serviceId, 60)).rejects.toMatchObject({
      code: "identity_inactive",
      statusCode: 409,
    });

    const deletedProject = testUlid(nextSeed++);
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'deleted-target')", {
      id: deletedProject,
    });
    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: deletedProject,
    });
    await expect(
      runtime.service.create(actorId, { name: "deleted-create", projectId: deletedProject }),
    ).rejects.toMatchObject({ code: "validation_error", statusCode: 422 });
  });

  it("should revoke idempotently and clear unused tokens", async () => {
    const serviceId = await createService("revoke");
    await runtime.service.issueJoinToken(actorId, serviceId, 60);
    await runtime.service.revoke(actorId, serviceId);
    await expect(runtime.service.revoke(actorId, serviceId)).resolves.toBeUndefined();

    const state = await testDb.db.executeQuery<{ status: string; live_tokens: number }>(
      `SELECT p.status,
              (SELECT count(*)::int FROM join_tokens t
                WHERE t.principal_id = p.id AND t.used_at IS NULL AND t.revoked_at IS NULL) AS live_tokens
         FROM principals p
        WHERE p.id = :id`,
      { id: serviceId },
    );
    expect(state.records[0]).toEqual({ status: "disabled", live_tokens: 0 });
  });

  it("should leave no live token when issue races revoke", async () => {
    const serviceId = await createService("race");
    await Promise.allSettled([
      runtime.service.issueJoinToken(actorId, serviceId, 60),
      runtime.service.revoke(actorId, serviceId),
    ]);

    const live = await testDb.db.executeQuery<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM join_tokens
        WHERE principal_id = :id AND used_at IS NULL AND revoked_at IS NULL`,
      { id: serviceId },
    );
    expect(live.records[0]?.count).toBe(0);
  });

  it("should reject a duplicate active name and allow a name after revoke", async () => {
    const name = `reuse-${nextSeed++}`;
    const first = await runtime.service.create(actorId, { name, projectId: base.projectId });
    await expect(
      runtime.service.create(actorId, { name, projectId: base.projectId }),
    ).rejects.toMatchObject({ code: "identity_name_conflict", statusCode: 409 });

    await runtime.service.revoke(actorId, first.id);
    await expect(
      runtime.service.create(actorId, { name, projectId: base.projectId }),
    ).resolves.toMatchObject({ name });
  });

  it("should expose an empty detail for a newly created identity", async () => {
    const serviceId = await createService("detail");
    const detail = await runtime.service.get(actorId, serviceId);
    expect(detail).toMatchObject({
      id: serviceId,
      projectId: base.projectId,
      status: "active",
      certificates: [],
      consumer: null,
    });
  });
});

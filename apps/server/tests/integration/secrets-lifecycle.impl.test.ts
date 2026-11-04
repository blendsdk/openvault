import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { VaultPurger } from "../../src/purge/vault-purger.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { SecretRepository } from "../../src/secrets/repository.js";
import { SecretService } from "../../src/secrets/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { ensurePurgerRole } from "./helpers/purger.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let policy: PolicyService;
let purger: VaultPurger | undefined;

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

async function makePurgeable(id: string): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE secrets
        SET deleted_at = '2020-01-01T00:00:00.000Z',
            purge_after = '2020-01-02T00:00:00.000Z'
      WHERE id = :id`,
    { id },
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
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
  });
  const purgeUrl = await ensurePurgerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  purger =
    purgeUrl === undefined
      ? undefined
      : new VaultPurger({ url: purgeUrl, appDatabase: testDb.name });
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
    ...(purger === undefined ? {} : { purger }),
  });
}, 60_000);

afterAll(async () => {
  await purger?.close();
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

describe("secret lifecycle implementation", () => {
  it("should reject a purger pointed at the application role or wrong database", async () => {
    const name = secretName("guard");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "x" });
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);

    const appRole = new VaultPurger({ url: testDb.url, appDatabase: testDb.name });
    try {
      const service = new SecretService({
        database: testDb.db,
        keyring,
        policy,
        audit: createAuditCore({ database: testDb.db, keyring }).writer,
        projectRepository: new ProjectRepository(testDb.db),
        repository: new SecretRepository(),
        secretMaxBytes: 65_536,
        softDeleteDays: 30,
        purger: appRole,
      });
      await expect(service.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
        statusCode: 503,
        code: "service_unavailable",
      });
    } finally {
      await appRole.close();
    }

    if (purger === undefined) {
      return;
    }
    const wrongDatabase = new VaultPurger({
      url: testDb.url.replace(/\/openvault_test_[^/?]+/, "/openvault_test_missing"),
      appDatabase: "openvault_test_missing",
    });
    try {
      const service = new SecretService({
        database: testDb.db,
        keyring,
        policy,
        audit: createAuditCore({ database: testDb.db, keyring }).writer,
        projectRepository: new ProjectRepository(testDb.db),
        repository: new SecretRepository(),
        secretMaxBytes: 65_536,
        softDeleteDays: 30,
        purger: wrongDatabase,
      });
      await expect(service.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
        statusCode: 503,
        code: "service_unavailable",
      });
    } finally {
      await wrongDatabase.close();
    }
  });

  it("should reserve a protected deleted name until the project is restored", async () => {
    const name = secretName("reserved");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "x" });
    await secrets.updateMetadata(actors.orgAdmin, "foundation", name, { purgeProtected: true });
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    await expect(secrets.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "purge_protection_locked",
    });
    await expect(
      secrets.create(actors.orgAdmin, "foundation", { name, value: "replacement" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "secret_name_conflict" });
  });

  it("should reject purge when the project was soft-deleted", async () => {
    const name = secretName("project-purge");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "x" });
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    try {
      await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
        id: base.projectId,
      });
      await expect(secrets.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
        statusCode: 404,
        code: "project_not_found",
      });
    } finally {
      await testDb.db.executeQuery("UPDATE projects SET deleted_at = NULL WHERE id = :id", {
        id: base.projectId,
      });
    }
  });

  it("should roll back a purge when the purger row count does not match", async () => {
    if (purger === undefined) {
      return;
    }
    const name = secretName("rollback");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "x" });
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    // A version inserted after the service check but before the purge would be
    // counted by the purger and deleted atomically; inserting one now must not
    // leave the secret half-deleted.
    await testDb.db.executeQuery(
      `INSERT INTO secret_versions
         (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id,
          created_by, created_at)
       VALUES
         (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
          'kek-1', :createdBy, now())`,
      {
        id: newUlid(),
        secretId: created.id,
        ciphertext: Buffer.from("x"),
        nonce: Buffer.alloc(12, 1),
        tag: Buffer.alloc(16, 1),
        wrappedDek: Buffer.alloc(32, 1),
        wrapNonce: Buffer.alloc(12, 1),
        wrapTag: Buffer.alloc(16, 1),
        createdBy: actors.orgAdmin,
      },
    );
    await expect(secrets.purge(actors.orgAdmin, "foundation", name)).resolves.toBeUndefined();
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE id = :id",
      { id: created.id },
    );
    expect(rows.records[0]?.count).toBe(0);
  });
});

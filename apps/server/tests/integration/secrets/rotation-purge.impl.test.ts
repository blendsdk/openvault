import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { VaultPurger } from "../../../src/purge/vault-purger.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { SecretRepository } from "../../../src/secrets/repository.js";
import { SecretService } from "../../../src/secrets/service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import { ensurePurgerRole } from "../helpers/purger.js";
import { createServerEnvironment } from "../helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let purger: VaultPurger | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring });
  const policy = new PolicyService({
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

describe("rotation notification purge", () => {
  it("should remove notification rows when the secret is purged", async () => {
    if (purger === undefined) {
      return;
    }
    const name = `purge-rotation-${newUlid().slice(-10).toLowerCase()}`;
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "x" });
    const versionId = created.version.id;
    await testDb.db.executeQuery(
      `INSERT INTO secret_rotation_notifications
         (id, secret_id, project_id, version_id, status, due_at, days_until_due,
          audit_event_id, claimed_at)
       VALUES
         (:id, :secretId, :projectId, :versionId, 'due_soon', :dueAt, 5,
          :auditEventId, now())`,
      {
        id: newUlid(),
        secretId: created.id,
        projectId: base.projectId,
        versionId,
        dueAt: new Date("2026-11-09T12:00:00.000Z"),
        auditEventId: newUlid(),
      },
    );
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await testDb.db.executeQuery(
      `UPDATE secrets
          SET deleted_at = '2020-01-01T00:00:00.000Z',
              purge_after = '2020-01-02T00:00:00.000Z'
        WHERE id = :id`,
      { id: created.id },
    );
    await secrets.purge(actors.orgAdmin, "foundation", name);
    const rows = await testDb.db.executeQuery<{ readonly count: number }>(
      "SELECT count(*)::int AS count FROM secret_rotation_notifications WHERE secret_id = :id",
      { id: created.id },
    );
    expect(rows.records[0]?.count).toBe(0);
    const secretRows = await testDb.db.executeQuery<{ readonly count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE id = :id",
      { id: created.id },
    );
    expect(secretRows.records[0]?.count).toBe(0);
  });
});

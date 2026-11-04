import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateLifecycle } from "../../src/certificates/lifecycle.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { VaultPurger } from "../../src/purge/vault-purger.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { ensurePurgerRole } from "./helpers/purger.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let service: CertificateService;
let lifecycle: CertificateLifecycle;
let purger: VaultPurger | undefined;

function certificateName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

async function importSelfSigned(name: string) {
  const fixture = await createSelfSignedFixture();
  return service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
}

async function makePurgeable(id: string): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE certificates
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
  const policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
  });
  const projectRepository = new ProjectRepository(testDb.db);
  const repository = new CertificateRepository();
  service = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository,
    repository,
    certMaxBytes: 131_072,
  });
  const purgeUrl = await ensurePurgerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  purger =
    purgeUrl === undefined
      ? undefined
      : new VaultPurger({ url: purgeUrl, appDatabase: testDb.name });
  lifecycle = new CertificateLifecycle({
    database: testDb.db,
    repository,
    service,
    projectRepository,
    policy,
    audit: core.writer,
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

describe("certificate lifecycle", () => {
  it("should update tags without creating a version", async () => {
    const name = certificateName("tags");
    const created = await importSelfSigned(name);
    const updated = await lifecycle.updateMetadata(actors.orgAdmin, "foundation", name, {
      tags: { owner: "payments" },
    });
    expect(updated.tags).toEqual({ owner: "payments" });
    expect(updated.version.id).toBe(created.response.version.id);
  });

  it("should soft delete, hide, and recover before retention", async () => {
    const name = certificateName("recover");
    await importSelfSigned(name);
    const deleted = await lifecycle.delete(actors.orgAdmin, "foundation", name);
    expect(deleted).toBeUndefined();
    await expect(service.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(lifecycle.delete(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 404,
    });
    const recovered = await lifecycle.recover(actors.orgAdmin, "foundation", name);
    expect(recovered.status).toBe("active");
  });

  it("should reject recovery after retention", async () => {
    const name = certificateName("late");
    const created = await importSelfSigned(name);
    await lifecycle.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.response.id);
    await expect(lifecycle.recover(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "certificate_not_recoverable",
    });
  });

  it("should enable protection, reject disabling it, and block purge", async () => {
    const name = certificateName("protect");
    const created = await importSelfSigned(name);
    const enabled = await lifecycle.updateMetadata(actors.orgAdmin, "foundation", name, {
      purgeProtected: true,
    });
    expect(enabled.purgeProtected).toBe(true);
    await expect(
      lifecycle.updateMetadata(actors.orgAdmin, "foundation", name, {
        purgeProtected: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "purge_protection_locked" });
    await lifecycle.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.response.id);
    await expect(lifecycle.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "purge_protection_locked",
    });
    const replacement = await createSelfSignedFixture();
    await expect(
      service.import(actors.orgAdmin, "foundation", {
        name,
        certificatePem: replacement.certificatePem,
        privateKeyPem: replacement.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "certificate_name_conflict" });
  });

  it("should return 409 before retention and purge after retention", async () => {
    if (purger === undefined) {
      return;
    }
    const name = certificateName("purge");
    const created = await importSelfSigned(name);
    await lifecycle.delete(actors.orgAdmin, "foundation", name);
    await expect(lifecycle.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "certificate_retention_active",
    });
    await makePurgeable(created.response.id);
    await testDb.db.executeQuery(
      `INSERT INTO certificate_expiry_notifications
         (certificate_id, version_id, threshold_days, days_to_expiry, audit_event_id)
       VALUES (:certificateId, :versionId, 30, 30, :auditEventId)`,
      {
        certificateId: created.response.id,
        versionId: created.response.version.id,
        auditEventId: newUlid(),
      },
    );
    await expect(lifecycle.purge(actors.orgAdmin, "foundation", name)).resolves.toBeUndefined();
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificates WHERE id = :id",
      { id: created.response.id },
    );
    expect(rows.records[0]?.count).toBe(0);
    const notifications = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificate_expiry_notifications WHERE certificate_id = :id",
      { id: created.response.id },
    );
    expect(notifications.records[0]?.count).toBe(0);
    await expect(importSelfSigned(name)).resolves.toMatchObject({ created: true });
  });

  it("should return 503 when purge is not configured", async () => {
    const name = certificateName("no-purger");
    const created = await importSelfSigned(name);
    await lifecycle.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.response.id);
    const core = createAuditCore({ database: testDb.db, keyring });
    const policy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: core.policyAudit,
    });
    const without = new CertificateLifecycle({
      database: testDb.db,
      repository: new CertificateRepository(),
      service,
      projectRepository: new ProjectRepository(testDb.db),
      policy,
      audit: core.writer,
      softDeleteDays: 30,
    });
    await expect(without.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
    });
  });

  it("should reject purge when the project is soft-deleted", async () => {
    const name = certificateName("project-hidden");
    const created = await importSelfSigned(name);
    await lifecycle.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.response.id);
    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: base.projectId,
    });
    try {
      await expect(service.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(lifecycle.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
        statusCode: 404,
        code: "project_not_found",
      });
    } finally {
      await testDb.db.executeQuery("UPDATE projects SET deleted_at = NULL WHERE id = :id", {
        id: base.projectId,
      });
    }
  });
});

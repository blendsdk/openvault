import { newUlid } from "@openvault/core";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
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
let purger: VaultPurger | undefined;
let purgeUrl: string | undefined;

async function createPurgeable(
  name: string,
): Promise<{ id: string; versionId: string; name: string }> {
  const fixture = await createSelfSignedFixture();
  const created = await service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
  await testDb.db.executeQuery(
    `UPDATE certificates
        SET deleted_at = '2020-01-01T00:00:00.000Z',
            purge_after = '2020-01-02T00:00:00.000Z'
      WHERE id = :id`,
    { id: created.response.id },
  );
  return { id: created.response.id, versionId: created.response.version.id, name };
}

async function setPurgerMembership(grant: boolean): Promise<void> {
  const client = new Client({ connectionString: testDb.url });
  await client.connect();
  try {
    await client.query(
      grant ? "GRANT openvault TO openvault_purger" : "REVOKE openvault FROM openvault_purger",
    );
  } finally {
    await client.end();
  }
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
  service = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new CertificateRepository(),
    certMaxBytes: 131_072,
  });
  purgeUrl = await ensurePurgerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  purger =
    purgeUrl === undefined
      ? undefined
      : new VaultPurger({ url: purgeUrl, appDatabase: testDb.name });
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

describe("certificate purge guards", () => {
  it("should reject the application role and an owner-role membership", async () => {
    if (purger === undefined) {
      return;
    }
    const target = await createPurgeable(`guard-${newUlid().slice(-8).toLowerCase()}`);
    const appRole = new VaultPurger({ url: testDb.url, appDatabase: testDb.name });
    try {
      await expect(
        appRole.deleteCertificate(target.id, base.projectId, target.name),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      await appRole.close();
    }
    await setPurgerMembership(true);
    try {
      await expect(
        purger.deleteCertificate(target.id, base.projectId, target.name),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      await setPurgerMembership(false);
    }
  });

  it("should reject a project or name that does not match the certificate", async () => {
    if (purger === undefined) {
      return;
    }
    const name = `mismatch-${newUlid().slice(-8).toLowerCase()}`;
    const target = await createPurgeable(name);
    await expect(
      purger.deleteCertificate(target.id, base.projectId, "different-name"),
    ).rejects.toMatchObject({ code: "target_not_found" });
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificates WHERE id = :id",
      { id: target.id },
    );
    expect(rows.records[0]?.count).toBe(1);
  });

  it("should reject a missing purge database", async () => {
    const missing = new VaultPurger({
      url: testDb.url.replace(/\/openvault_test_[^/?]+/, "/openvault_test_missing"),
      appDatabase: "openvault_test_missing",
    });
    try {
      await expect(
        missing.deleteCertificate(newUlid(), base.projectId, "missing"),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      await missing.close();
    }
  });
});

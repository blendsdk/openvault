import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { CertificateRepository } from "../../../src/certificates/repository.js";
import { CertificateService } from "../../../src/certificates/service.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, seedAuditActors } from "../helpers/audit-harness.js";
import { createSelfSignedFixture } from "../helpers/certificate-fixtures.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
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
let service: CertificateService;
const repository = new CertificateRepository();

async function importCertificate(name: string, subject?: string): Promise<void> {
  const fixture = await createSelfSignedFixture(subject === undefined ? {} : { subject });
  await service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
}

async function softDelete(name: string): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE certificates
        SET deleted_at = now(), purge_after = now() + interval '30 days'
      WHERE project_id = :projectId AND name = :name`,
    { projectId: base.projectId, name },
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
    now: () => Date.parse("2026-11-08T12:00:00.000Z"),
  });
  service = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository,
    certMaxBytes: 131_072,
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

describe("certificate repository list filters", () => {
  it("should escape percent and underscore metacharacters in the search term", async () => {
    await importCertificate("percent-100");
    await importCertificate("100-abc", "CN=under_score.example.test");

    const literalPercent = await repository.listCertificates(testDb.db, base.projectId, {
      q: "100%",
      status: "active",
      limit: 50,
    });
    expect(literalPercent).toHaveLength(0);

    const literalUnderscore = await repository.listCertificates(testDb.db, base.projectId, {
      q: "under_score",
      status: "active",
      limit: 50,
    });
    expect(literalUnderscore.map((row) => row.name)).toContain("100-abc");

    const wildcardUnderscore = await repository.listCertificates(testDb.db, base.projectId, {
      q: "underXscore",
      status: "active",
      limit: 50,
    });
    expect(wildcardUnderscore).toHaveLength(0);
  });

  it("should continue a deleted-status page from the returned name", async () => {
    await importCertificate("page-a");
    await importCertificate("page-b");
    await softDelete("page-a");
    await softDelete("page-b");

    const first = await repository.listCertificates(testDb.db, base.projectId, {
      q: "page-",
      status: "deleted",
      limit: 1,
    });
    const firstRow = first[0];
    expect(firstRow).toBeDefined();
    if (firstRow === undefined) {
      return;
    }
    const second = await repository.listCertificates(testDb.db, base.projectId, {
      q: "page-",
      status: "deleted",
      limit: 1,
      cursor: { name: firstRow.name, id: firstRow.id },
    });
    expect(second.map((row) => row.name)).toEqual(["page-b"]);
  });

  it("should return an empty page past the last deleted row", async () => {
    await importCertificate("page-c");
    await softDelete("page-c");

    const rows = await repository.listCertificates(testDb.db, base.projectId, {
      q: "page-",
      status: "deleted",
      limit: 1,
      cursor: { name: "zzz", id: "zzz" },
    });
    expect(rows).toHaveLength(0);
  });

  it("should return no rows when no certificate is deleted", async () => {
    const rows = await repository.listCertificates(testDb.db, base.projectId, {
      q: "never-deleted",
      status: "deleted",
      limit: 25,
    });
    expect(rows).toHaveLength(0);
  });
});

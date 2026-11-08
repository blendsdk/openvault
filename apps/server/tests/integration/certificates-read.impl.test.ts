import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let service: CertificateService;

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
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

describe("certificate read internals", () => {
  it("should reject a malformed cursor", async () => {
    await expect(
      service.list(actors.orgAdmin, "foundation", {
        status: "active",
        limit: 1,
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should report a tampered private-key envelope as an error, not an allow", async () => {
    const name = certificateName("tampered");
    const created = await importSelfSigned(name);
    await testDb.db.executeQuery(
      "ALTER TABLE certificate_versions DISABLE TRIGGER certificate_versions_no_update",
    );
    try {
      await testDb.db.executeQuery(
        "UPDATE certificate_versions SET ciphertext = :ciphertext WHERE id = :id",
        { id: created.response.version.id, ciphertext: Buffer.from("tampered") },
      );
    } finally {
      await testDb.db.executeQuery(
        "ALTER TABLE certificate_versions ENABLE TRIGGER certificate_versions_no_update",
      );
    }
    await expect(
      service.readPrivate(actors.orgAdmin, "foundation", name, {}),
    ).rejects.toMatchObject({ statusCode: 500, code: "certificate_integrity_failed" });
    const events = await testDb.db.executeQuery<{ result: string }>(
      "SELECT result FROM audit_events WHERE action = 'certificate.read_private' ORDER BY id ASC",
    );
    expect(events.records.map((row) => row.result)).toEqual(["error"]);
  });

  it("should return 503 and no key when the private-read audit write fails", async () => {
    const name = certificateName("audit-fail");
    await importSelfSigned(name);
    class FailingWriter extends AuditWriter {
      public override async record(
        input: Parameters<AuditWriter["record"]>[0],
        tx?: Parameters<AuditWriter["record"]>[1],
        options?: Parameters<AuditWriter["record"]>[2],
      ): ReturnType<AuditWriter["record"]> {
        if (tx === undefined && input.action === "certificate.read_private") {
          throw new Error("audit unavailable");
        }
        return super.record(input, tx, options);
      }
    }
    const failingWriter = new FailingWriter({ database: testDb.db, keyring });
    const failingPolicy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: new PersistentPolicyAudit({
        writer: failingWriter,
        database: testDb.db,
      }),
    });
    const failingService = new CertificateService({
      database: testDb.db,
      keyring,
      policy: failingPolicy,
      audit: failingWriter,
      projectRepository: new ProjectRepository(testDb.db),
      repository: new CertificateRepository(),
      certMaxBytes: 131_072,
    });
    await expect(
      failingService.readPrivate(actors.orgAdmin, "foundation", name, {}),
    ).rejects.toBeInstanceOf(PolicyUnavailableError);
  });
});

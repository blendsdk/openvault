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
let core: ReturnType<typeof createAuditCore>;
let policy: PolicyService;

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
  core = createAuditCore({ database: testDb.db, keyring });
  policy = new PolicyService({
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

describe("certificate write internals", () => {
  it("should keep two concurrent renewals as two versions", async () => {
    const name = certificateName("concurrent");
    const fixture = await createSelfSignedFixture();
    await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const results = await Promise.all([
      service.generate(actors.orgAdmin, "foundation", {
        name,
        subject: "CN=one.example.test",
        sans: ["DNS:one.example.test"],
      }),
      service.generate(actors.orgAdmin, "foundation", {
        name,
        subject: "CN=two.example.test",
        sans: ["DNS:two.example.test"],
      }),
    ]);
    expect(results).toHaveLength(2);
    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificate_versions v JOIN certificates c ON c.id = v.certificate_id WHERE c.name = :name",
      { name },
    );
    expect(count.records[0]?.count).toBe(3);
  }, 60_000);

  it("should roll back the certificate and allow event when the joined audit write fails", async () => {
    const name = certificateName("rollback");
    const fixture = await createSelfSignedFixture();
    class FailingWriter extends AuditWriter {
      public override async record(
        input: Parameters<AuditWriter["record"]>[0],
        tx?: Parameters<AuditWriter["record"]>[1],
        options?: Parameters<AuditWriter["record"]>[2],
      ): ReturnType<AuditWriter["record"]> {
        if (tx !== undefined && input.action === "certificate.write") {
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
      failingService.import(actors.orgAdmin, "foundation", {
        name,
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toBeInstanceOf(PolicyUnavailableError);
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificates WHERE name = :name",
      { name },
    );
    expect(rows.records[0]?.count).toBe(0);
    const allows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action = 'certificate.write' AND result = 'allow'",
    );
    expect(allows.records[0]?.count).toBe(0);
  });

  it("should remove notification rows for superseded versions on renewal", async () => {
    const name = certificateName("cleanup");
    const first = await importSelfSigned(name);
    await testDb.db.executeQuery(
      `INSERT INTO certificate_expiry_notifications
         (certificate_id, version_id, threshold_days, days_to_expiry, audit_event_id)
       VALUES (:certificateId, :versionId, 30, 30, :auditEventId)`,
      {
        certificateId: first.response.id,
        versionId: first.response.version.id,
        auditEventId: newUlid(),
      },
    );
    const fixture = await createSelfSignedFixture();
    await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificate_expiry_notifications WHERE certificate_id = :id",
      { id: first.response.id },
    );
    expect(rows.records[0]?.count).toBe(0);
  });

  it("should reject a write at the retained version limit", async () => {
    const name = certificateName("limit");
    const fixture = await createSelfSignedFixture();
    const created = await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const first = await testDb.db.executeQuery<{
      id: string;
      chain_pem: string;
      ciphertext: Buffer;
      nonce: Buffer;
      tag: Buffer;
      wrapped_dek: Buffer;
      wrap_nonce: Buffer;
      wrap_tag: Buffer;
      kek_id: string;
      fingerprint: string;
      subject: string;
      sans: unknown;
      issuer: string;
      serial: string;
      not_before: Date;
      not_after: Date;
    }>("SELECT * FROM certificate_versions WHERE certificate_id = :id LIMIT 1", {
      id: created.response.id,
    });
    const version = first.records[0];
    if (version === undefined) {
      throw new Error("missing first version");
    }
    for (let index = 0; index < 999; index += 1) {
      await testDb.db.executeQuery(
        `INSERT INTO certificate_versions
           (id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
            wrap_tag, kek_id, fingerprint, subject, sans, issuer, serial, not_before,
            not_after, created_by)
         VALUES
           (:id, :certificateId, :chainPem, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce,
            :wrapTag, :kekId, :fingerprint, :subject, :sans, :issuer, :serial, :notBefore,
            :notAfter, :createdBy)`,
        {
          id: newUlid(),
          certificateId: created.response.id,
          chainPem: version.chain_pem,
          ciphertext: version.ciphertext,
          nonce: version.nonce,
          tag: version.tag,
          wrappedDek: version.wrapped_dek,
          wrapNonce: version.wrap_nonce,
          wrapTag: version.wrap_tag,
          kekId: version.kek_id,
          fingerprint: version.fingerprint,
          subject: version.subject,
          sans: JSON.stringify(version.sans),
          issuer: version.issuer,
          serial: version.serial,
          notBefore: version.not_before,
          notAfter: version.not_after,
          createdBy: actors.orgAdmin,
        },
      );
    }
    await expect(
      service.generate(actors.orgAdmin, "foundation", {
        name,
        subject: "CN=blocked.example.test",
        sans: ["DNS:blocked.example.test"],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "certificate_version_limit" });
  }, 60_000);
});

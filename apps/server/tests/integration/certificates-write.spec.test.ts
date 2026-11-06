import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createChainFixture, createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
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

async function importSelfSigned(name: string) {
  const fixture = await createSelfSignedFixture();
  return service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
}

describe("certificate import and renewal", () => {
  it("should create a certificate and write one joined allow event", async () => {
    const name = certificateName("import");
    const result = await importSelfSigned(name);
    expect(result.created).toBe(true);
    expect(result.response.name).toBe(name);
    expect(result.response.status).toBe("active");
    expect(result.response.subject).toBe("CN=fixture.example.test");
    expect(result.response.chainLength).toBe(1);
    expect(result.response.certificatePem).toContain("BEGIN CERTIFICATE");
    const events = await testDb.db.executeQuery<{ result: string; details: unknown }>(
      "SELECT result, details FROM audit_events WHERE action = 'certificate.write'",
    );
    expect(events.records).toHaveLength(1);
    expect(events.records[0]).toMatchObject({ result: "allow" });
    expect(events.records[0]?.details).toMatchObject({ mode: "import", renewal: 0 });
  });

  it("should renew an active name into a second immutable version", async () => {
    const name = certificateName("renew");
    const first = await importSelfSigned(name);
    const fixture = await createSelfSignedFixture();
    const second = await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
      expectedVersionId: first.response.version.id,
    });
    expect(second.created).toBe(false);
    expect(second.response.version.id).not.toBe(first.response.version.id);
    const oldVersion = await service.read(
      actors.orgAdmin,
      "foundation",
      name,
      { version: first.response.version.id },
      {},
    );
    expect(oldVersion.certificatePem).toBe(first.response.certificatePem);
    const current = await service.read(actors.orgAdmin, "foundation", name, {}, {});
    expect(current.version.id).toBe(second.response.version.id);
  });

  it("should reject a stale expected version", async () => {
    const name = certificateName("stale");
    const first = await importSelfSigned(name);
    const fixture = await createSelfSignedFixture();
    await expect(
      service.import(actors.orgAdmin, "foundation", {
        name,
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
        expectedVersionId: newUlid(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "certificate_version_conflict" });
    expect(first.response.version.id).toBeTruthy();
  });

  it("should import a valid intermediate chain", async () => {
    const name = certificateName("chain");
    const fixture = await createChainFixture();
    const result = await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.leafPem,
      chainPem: fixture.chainPem,
      privateKeyPem: fixture.privateKeyPem,
    });
    expect(result.response.chainLength).toBe(3);
    expect(result.response.chainPem).toContain("BEGIN CERTIFICATE");
  });

  it("should reject a project that does not exist", async () => {
    const fixture = await createSelfSignedFixture();
    await expect(
      service.import(actors.orgAdmin, "missing-project", {
        name: certificateName("missing"),
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "certificate_not_found" });
  });
});

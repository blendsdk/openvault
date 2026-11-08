import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { CryptoIntegrityError, decryptValue, type EncryptedValue, newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createExpiredFixture, createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
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

async function insertUser(label: string): Promise<string> {
  const id = newUlid();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: label, email: `${id.toLowerCase()}@example.test` },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: newUlid(), principalId, role, scopeType, scopeId },
  );
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

describe("certificate reads and lists", () => {
  it("should return the public chain and never the private key", async () => {
    const name = certificateName("public");
    await importSelfSigned(name);
    const read = await service.read(actors.orgAdmin, "foundation", name, {});
    expect(read.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(read).not.toHaveProperty("privateKeyPem");
    expect(read.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(read.chainLength).toBe(1);
  });

  it("should return a private key only to a read_private caller", async () => {
    const name = certificateName("private");
    const created = await importSelfSigned(name);
    const key = await service.readPrivate(actors.orgAdmin, "foundation", name, {});
    expect(key.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(key.version.id).toBe(created.response.version.id);
    const cert = readCertificatePem(created.response.certificatePem);
    const privateKey = createPrivateKey({ key: key.privateKeyPem, format: "pem" });
    const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    expect(Buffer.from(cert.publicKey.export({ type: "spki", format: "der" })).equals(spki)).toBe(
      true,
    );
    const events = await testDb.db.executeQuery<{ details: unknown }>(
      "SELECT details FROM audit_events WHERE action = 'certificate.read_private'",
    );
    expect(JSON.stringify(events.records)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("should return 403 for a public reader without read_private", async () => {
    const name = certificateName("no-private");
    await importSelfSigned(name);
    const reader = await insertUser("Certificate Reader");
    await assign(reader, "certificates.reader", "project", base.projectId);
    await expect(service.readPrivate(reader, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("should allow an object-scope reader to read but not list", async () => {
    const name = certificateName("object");
    const created = await importSelfSigned(name);
    const reader = await insertUser("Object Certificate Reader");
    await assign(reader, "certificates.reader", "object", created.response.id);
    const read = await service.read(reader, "foundation", name, {});
    expect(read.name).toBe(name);
    await expect(
      service.list(reader, "foundation", { status: "active", limit: 50 }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "project_not_found",
    });
  });

  it("should return 410 for an expired current read and 200 for an explicit version", async () => {
    const name = certificateName("expired");
    const fixture = await createExpiredFixture(Date.now());
    const created = await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    await expect(service.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 410,
      code: "certificate_expired",
    });
    const explicit = await service.read(actors.orgAdmin, "foundation", name, {
      version: created.response.version.id,
    });
    expect(explicit.certificatePem).toContain("BEGIN CERTIFICATE");
  });

  it("should list metadata without PEM and with capabilities", async () => {
    const name = certificateName("list");
    await importSelfSigned(name);
    const list = await service.list(actors.orgAdmin, "foundation", {
      q: "fixture",
      status: "active",
      limit: 50,
    });
    const item = list.certificates.find((certificate) => certificate.name === name);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty("certificatePem");
    expect(item).not.toHaveProperty("privateKeyPem");
    expect(item?.capabilities.canRead).toBe(true);
    expect(item?.chainLength).toBe(1);
  });

  it("should filter by subject, SAN, expiry window, and cursor", async () => {
    const prefix = certificateName("search");
    for (const [suffix, subject, san] of [
      ["a", "CN=alpha.example.test", "DNS:alpha.example.test"],
      ["b", "CN=beta.example.test", "DNS:beta.example.test"],
      ["c", "CN=alphabet.example.test", "DNS:alphabet.example.test"],
    ] as const) {
      const fixture = await createSelfSignedFixture({ subject, sans: [san] });
      await service.import(actors.orgAdmin, "foundation", {
        name: `${prefix}-${suffix}`,
        certificatePem: fixture.certificatePem,
        privateKeyPem: fixture.privateKeyPem,
      });
    }
    const bySubject = await service.list(actors.orgAdmin, "foundation", {
      q: "alpha",
      status: "active",
      limit: 50,
    });
    expect(bySubject.certificates).toHaveLength(2);
    const bySan = await service.list(actors.orgAdmin, "foundation", {
      san: "DNS:beta.example.test",
      status: "active",
      limit: 50,
    });
    expect(bySan.certificates.map((certificate) => certificate.name)).toEqual([`${prefix}-b`]);
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const byExpiry = await service.list(actors.orgAdmin, "foundation", {
      expiresBefore: future,
      status: "active",
      limit: 50,
    });
    expect(byExpiry.certificates.length).toBeGreaterThanOrEqual(3);
    const first = await service.list(actors.orgAdmin, "foundation", {
      q: "alpha",
      status: "active",
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(actors.orgAdmin, "foundation", {
      q: "alpha",
      status: "active",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.certificates[0]?.name).not.toBe(first.certificates[0]?.name);
  });

  it("should hide certificates from a foreign project and from a caller with no access", async () => {
    const name = certificateName("hidden");
    await importSelfSigned(name);
    const foreignProjectId = newUlid();
    await testDb.db.executeQuery(
      "INSERT INTO projects (id, name) VALUES (:id, 'foreign-project')",
      { id: foreignProjectId },
    );
    const reader = await insertUser("Foreign Certificate Reader");
    await assign(reader, "certificates.reader", "project", foreignProjectId);
    await expect(service.read(reader, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 404,
    });
    const noAccess = await insertUser("No Access");
    await expect(service.read(noAccess, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 404,
      code: "certificate_not_found",
    });
  });

  it("should fail certificate envelope decryption under the secret object type", async () => {
    const name = certificateName("aad");
    const created = await importSelfSigned(name);
    const row = await testDb.db.executeQuery<{
      project_id: string;
      certificate_id: string;
      id: string;
      ciphertext: Buffer;
      nonce: Buffer;
      tag: Buffer;
      wrapped_dek: Buffer;
      wrap_nonce: Buffer;
      wrap_tag: Buffer;
      kek_id: string;
    }>(
      `SELECT c.project_id, v.certificate_id, v.id, v.ciphertext, v.nonce, v.tag,
              v.wrapped_dek, v.wrap_nonce, v.wrap_tag, v.kek_id
         FROM certificate_versions v JOIN certificates c ON c.id = v.certificate_id
        WHERE v.id = :id`,
      { id: created.response.version.id },
    );
    const version = row.records[0];
    if (version === undefined) {
      throw new Error("missing version");
    }
    const envelope: EncryptedValue = {
      kekId: version.kek_id,
      nonce: version.nonce.toString("base64"),
      ciphertext: version.ciphertext.toString("base64"),
      tag: version.tag.toString("base64"),
      wrapNonce: version.wrap_nonce.toString("base64"),
      wrappedDek: version.wrapped_dek.toString("base64"),
      wrapTag: version.wrap_tag.toString("base64"),
    };
    expect(() =>
      decryptValue(
        envelope,
        keyring,
        {
          objectType: "secret",
          projectId: version.project_id,
          objectId: version.certificate_id,
          version: version.id,
        },
        { maxCiphertextBytes: 131_072 },
      ),
    ).toThrow(CryptoIntegrityError);
  });
});

function readCertificatePem(pem: string): X509Certificate {
  return new X509Certificate(pem);
}

import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { CertificateLifecycle } from "../../../src/certificates/lifecycle.js";
import { CertificateRepository } from "../../../src/certificates/repository.js";
import { CertificateService } from "../../../src/certificates/service.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { SecretRepository } from "../../../src/secrets/repository.js";
import { SecretService } from "../../../src/secrets/service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "../helpers/audit-harness.js";
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
let secrets: SecretService;
let certificates: CertificateService;
let lifecycle: CertificateLifecycle;

function name(prefix: string): string {
  return `${prefix}-${newUlid().slice(-8).toLowerCase()}`;
}

async function insertUser(label: string): Promise<string> {
  const id = newUlid();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :label, :email, 'active')`,
    { id, label, email: `${id.toLowerCase()}@example.test` },
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

async function statusOf(
  action: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await action();
    return { code: "ok", message: "" };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
      return {
        code: String(Reflect.get(error, "code")),
        message: String(Reflect.get(error, "message")),
      };
    }
    throw error;
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
  const projectRepository = new ProjectRepository(testDb.db);
  const certificateRepository = new CertificateRepository();
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository,
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
  });
  certificates = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository,
    repository: certificateRepository,
    certMaxBytes: 131_072,
  });
  lifecycle = new CertificateLifecycle({
    database: testDb.db,
    repository: certificateRepository,
    service: certificates,
    projectRepository,
    policy,
    audit: core.writer,
    softDeleteDays: 30,
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

describe("collection visibility", () => {
  it("should give an unassigned caller identical 404 bodies for existing and missing secret names", async () => {
    const existing = name("hidden");
    await secrets.create(actors.orgAdmin, "foundation", { name: existing, value: "x" });
    const principal = await insertUser("Unassigned");
    const existingResult = await statusOf(() =>
      secrets.read(principal, "foundation", existing, {}),
    );
    const missingResult = await statusOf(() =>
      secrets.read(principal, "foundation", name("missing"), {}),
    );

    expect(existingResult).toEqual({
      code: "secret_not_found",
      message: "Resource not found",
    });
    expect(missingResult).toEqual(existingResult);
    expect(await statusOf(() => secrets.list(principal, "foundation", { limit: 50 }))).toEqual({
      code: "project_not_found",
      message: "Project not found",
    });
    expect(await statusOf(() => secrets.list(principal, "missing-project", { limit: 50 }))).toEqual(
      {
        code: "project_not_found",
        message: "Project not found",
      },
    );
  });

  it("should authorize before body validation on secret write paths", async () => {
    const existing = name("write-hidden");
    await secrets.create(actors.orgAdmin, "foundation", { name: existing, value: "x" });
    const unassigned = await insertUser("Write Unassigned");
    const oversized = "x".repeat(65_537);

    expect(
      await statusOf(() => secrets.write(unassigned, "foundation", existing, { value: oversized })),
    ).toEqual({ code: "secret_not_found", message: "Resource not found" });
    expect(
      await statusOf(() =>
        secrets.write(unassigned, "foundation", name("write-missing"), { value: oversized }),
      ),
    ).toEqual({ code: "secret_not_found", message: "Resource not found" });
    expect(
      await statusOf(() =>
        secrets.create(unassigned, "foundation", { name: name("new"), value: oversized }),
      ),
    ).toEqual({ code: "secret_not_found", message: "Resource not found" });
    expect(
      await statusOf(() =>
        secrets.create(unassigned, "missing-project", { name: name("new"), value: oversized }),
      ),
    ).toEqual({ code: "secret_not_found", message: "Resource not found" });
  });

  it("should keep 403 for a list-capable reader and 404 for a missing name", async () => {
    const existing = name("reader");
    await secrets.create(actors.orgAdmin, "foundation", { name: existing, value: "x" });
    const reader = await insertUser("Reader");
    await assign(reader, "reader", "project", base.projectId);

    expect(await statusOf(() => secrets.read(reader, "foundation", existing, {}))).toEqual({
      code: "access_denied",
      message: "Access denied",
    });
    expect(await statusOf(() => secrets.read(reader, "foundation", name("missing"), {}))).toEqual({
      code: "secret_not_found",
      message: "Resource not found",
    });
  });

  it("should allow an object-scope reader but hide every other name", async () => {
    const assigned = name("assigned");
    const other = name("other");
    const created = await secrets.create(actors.orgAdmin, "foundation", {
      name: assigned,
      value: "assigned-value",
    });
    await secrets.create(actors.orgAdmin, "foundation", { name: other, value: "other" });
    const reader = await insertUser("Object Reader");
    await assign(reader, "secrets.reader", "object", created.id);

    await expect(secrets.read(reader, "foundation", assigned, {})).resolves.toMatchObject({
      value: "assigned-value",
    });
    expect(await statusOf(() => secrets.read(reader, "foundation", other, {}))).toEqual({
      code: "secret_not_found",
      message: "Resource not found",
    });
    expect(await statusOf(() => secrets.read(reader, "foundation", name("missing"), {}))).toEqual({
      code: "secret_not_found",
      message: "Resource not found",
    });
  });

  it("should hide certificate names from an unassigned caller and keep 403 for a reader", async () => {
    const existing = name("cert");
    const fixture = await createSelfSignedFixture();
    await certificates.import(actors.orgAdmin, "foundation", {
      name: existing,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const unassigned = await insertUser("Cert Unassigned");
    const reader = await insertUser("Cert Reader");
    await assign(reader, "reader", "project", base.projectId);

    expect(await statusOf(() => certificates.read(unassigned, "foundation", existing, {}))).toEqual(
      {
        code: "certificate_not_found",
        message: "Resource not found",
      },
    );
    expect(
      await statusOf(() => certificates.read(unassigned, "foundation", name("missing"), {})),
    ).toEqual({ code: "certificate_not_found", message: "Resource not found" });
    expect(await statusOf(() => certificates.read(reader, "foundation", existing, {}))).toEqual({
      code: "access_denied",
      message: "Access denied",
    });
    expect(
      await statusOf(() => certificates.read(reader, "foundation", name("missing"), {})),
    ).toEqual({
      code: "certificate_not_found",
      message: "Resource not found",
    });
  });

  it("should keep 403 on a private-key read for an object-scope reader that knows the certificate", async () => {
    const existing = name("private");
    const fixture = await createSelfSignedFixture();
    const created = await certificates.import(actors.orgAdmin, "foundation", {
      name: existing,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const reader = await insertUser("Private Object Reader");
    await assign(reader, "certificates.reader", "object", created.response.id);

    await expect(
      certificates.readPrivate(reader, "foundation", existing, {}),
    ).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
  });

  it("should apply collection visibility to certificate lifecycle pre-authorization", async () => {
    const existing = name("lifecycle");
    const fixture = await createSelfSignedFixture();
    await certificates.import(actors.orgAdmin, "foundation", {
      name: existing,
      certificatePem: fixture.certificatePem,
      privateKeyPem: fixture.privateKeyPem,
    });
    const unassigned = await insertUser("Lifecycle Unassigned");
    const reader = await insertUser("Lifecycle Reader");
    await assign(reader, "reader", "project", base.projectId);

    expect(await statusOf(() => lifecycle.delete(unassigned, "foundation", existing))).toEqual({
      code: "certificate_not_found",
      message: "Resource not found",
    });
    expect(
      await statusOf(() => lifecycle.delete(unassigned, "foundation", name("missing"))),
    ).toEqual({ code: "certificate_not_found", message: "Resource not found" });
    expect(await statusOf(() => lifecycle.delete(reader, "foundation", existing))).toEqual({
      code: "access_denied",
      message: "Access denied",
    });
    expect(await statusOf(() => lifecycle.delete(reader, "foundation", name("missing")))).toEqual({
      code: "access_denied",
      message: "Access denied",
    });
  });
});

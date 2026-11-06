import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { SecretRepository } from "../../src/secrets/repository.js";
import { SecretService } from "../../src/secrets/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let policy: PolicyService;
let currentTime = Date.parse("2026-11-04T12:00:00.000Z");

const clock = (): number => currentTime;

function secretName(prefix: string): string {
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

async function createSecret(
  name: string,
  value = "value",
  actor = actors.orgAdmin,
): Promise<Awaited<ReturnType<SecretService["create"]>>> {
  return secrets.create(
    actor,
    "foundation",
    { name, value, encoding: "utf8", contentType: "text/plain", tags: {} },
    { requestId: `create-${name}` },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring, now: clock });
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
    now: clock,
  });
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
    now: clock,
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-11-04T12:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("secret write and read", () => {
  it("should create and read back an exact 64 KiB value", async () => {
    const name = secretName("large");
    const value = "a".repeat(65_536);
    const created = await createSecret(name, value);
    expect(created.currentVersion).not.toBeNull();
    const read = await secrets.read(
      actors.orgAdmin,
      "foundation",
      name,
      {},
      { requestId: "read-large" },
    );
    expect(read.encoding).toBe("utf8");
    expect(read.value).toBe(value);
  });

  it("should reject a value above the configured maximum", async () => {
    const name = secretName("too-large");
    await expect(createSecret(name, "a".repeat(65_537))).rejects.toMatchObject({
      statusCode: 413,
      code: "secret_too_large",
    });
    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE name = :name",
      { name },
    );
    expect(count.records[0]?.count).toBe(0);
  });

  it("should reject empty and whitespace-only values", async () => {
    for (const value of ["", "   ", "\t\n"]) {
      await expect(createSecret(secretName("empty"), value)).rejects.toMatchObject({
        statusCode: 422,
        code: "validation_error",
      });
    }
  });

  it("should reject a lone surrogate in a UTF-8 value", async () => {
    await expect(createSecret(secretName("surrogate"), "\uD800")).rejects.toMatchObject({
      statusCode: 422,
      code: "validation_error",
    });
  });

  it("should reject malformed base64 and whitespace-only decoded bytes", async () => {
    for (const value of ["abc", "ICAg"]) {
      await expect(
        secrets.create(
          actors.orgAdmin,
          "foundation",
          { name: secretName("base64"), value, encoding: "base64" },
          { requestId: "base64" },
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
    }
  });

  it("should round-trip a binary base64 value", async () => {
    const name = secretName("binary");
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const created = await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name, value: bytes.toString("base64"), encoding: "base64" },
      { requestId: "binary" },
    );
    expect(created.currentVersion).not.toBeNull();
    const read = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(read.encoding).toBe("base64");
    expect(Buffer.from(read.value, "base64").equals(bytes)).toBe(true);
  });

  it("should create a new version and keep the first readable by id", async () => {
    const name = secretName("versions");
    const first = await createSecret(name, "one");
    const second = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two", encoding: "utf8" },
      { requestId: "write-two" },
    );
    expect(second.version.id).not.toBe(first.version.id);
    const firstRead = await secrets.read(actors.orgAdmin, "foundation", name, {
      version: first.version.id,
    });
    expect(firstRead.value).toBe("one");
    const current = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(current.value).toBe("two");
  });

  it("should keep a sentinel value out of metadata, errors, and audit", async () => {
    const sentinel = `sentinel-${newUlid().toLowerCase()}`;
    const name = secretName("sentinel");
    const created = await createSecret(name, sentinel);
    const list = await secrets.list(actors.orgAdmin, "foundation", { q: name, limit: 50 });
    const versions = await secrets.versions(actors.orgAdmin, "foundation", name);
    const consumers = await secrets.consumers(actors.orgAdmin, "foundation", name);
    const audit = await testDb.db.executeQuery<Record<string, unknown>>(
      "SELECT event_id, request_id, action, details, user_agent FROM audit_events",
    );
    const output = JSON.stringify({
      created,
      list,
      versions,
      consumers,
      audit: audit.records,
    });
    expect(output).not.toContain(sentinel);
    const error = await secrets
      .create(actors.orgAdmin, "foundation", { name: secretName("empty"), value: "" })
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(sentinel);
  });

  it("should reject an invalid name and an inactive project", async () => {
    for (const name of ["bad/name", "..", "bad\u0001name", "pаypayments"]) {
      await expect(
        secrets.create(actors.orgAdmin, "foundation", { name, value: "x" }),
      ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
    }
    await expect(
      secrets.create(actors.orgAdmin, "missing-project", {
        name: secretName("missing"),
        value: "x",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "secret_not_found" });
  });

  it("should reject a duplicate active or deleted name", async () => {
    const name = secretName("duplicate");
    await createSecret(name);
    await expect(createSecret(name)).rejects.toMatchObject({
      statusCode: 409,
      code: "secret_name_conflict",
    });
  });

  it("should deny a caller without secret.read and hide another project", async () => {
    const name = secretName("hidden");
    await createSecret(name);
    await expect(
      secrets.read(actors.noAccess, "foundation", name, {}, { requestId: "no-access" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "secret_not_found" });
    const otherReader = await insertUser("Other Reader");
    await assign(otherReader, "secrets.reader", "project", actors.projectB);
    await expect(
      secrets.read(otherReader, "foundation", name, {}, { requestId: "other" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "secret_not_found" });
    await expect(
      secrets.list(otherReader, "foundation", { limit: 50 }, { requestId: "list-other" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });

  it("should allow an object-scope reader to read the value but not list", async () => {
    const name = secretName("object");
    const created = await createSecret(name);
    const objectReader = await insertUser("Object Reader");
    await assign(objectReader, "secrets.reader", "object", created.id);
    const read = await secrets.read(
      objectReader,
      "foundation",
      name,
      {},
      { requestId: "object-read" },
    );
    expect(read.value).toBe("value");
    await expect(
      secrets.list(objectReader, "foundation", { limit: 50 }, { requestId: "object-list" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
    await expect(
      secrets.versions(objectReader, "foundation", name, { requestId: "object-versions" }),
    ).resolves.toHaveLength(1);
  });

  it("should round-trip tags and content type without creating a version", async () => {
    const name = secretName("metadata");
    const created = await secrets.create(
      actors.orgAdmin,
      "foundation",
      {
        name,
        value: "x",
        contentType: "application/octet-stream",
        tags: { env: "prod", team: "payments" },
      },
      { requestId: "metadata" },
    );
    expect(created.tags).toEqual({ env: "prod", team: "payments" });
    expect(created.contentType).toBe("application/octet-stream");
    expect(await secrets.versions(actors.orgAdmin, "foundation", name)).toHaveLength(1);
  });

  it("should return no value in a list and include capabilities", async () => {
    await createSecret(secretName("list-a"));
    await createSecret(secretName("list-b"));
    const list = await secrets.list(
      actors.orgAdmin,
      "foundation",
      { limit: 50 },
      { requestId: "list" },
    );
    expect(list.secrets.length).toBeGreaterThanOrEqual(2);
    for (const secret of list.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret.capabilities.canRead).toBe(true);
      expect(secret.capabilities.canWrite).toBe(true);
    }
  });

  it("should search literally, filter by tag, and continue with a cursor", async () => {
    const prefix = secretName("search");
    await secrets.create(actors.orgAdmin, "foundation", {
      name: `${prefix}-a`,
      value: "x",
      tags: { env: "prod" },
    });
    await secrets.create(actors.orgAdmin, "foundation", {
      name: `${prefix}-b`,
      value: "x",
      tags: { env: "dev" },
    });
    await secrets.create(actors.orgAdmin, "foundation", {
      name: `${prefix}-percent`,
      value: "x",
      tags: { env: "prod" },
    });
    const literal = await secrets.list(actors.orgAdmin, "foundation", {
      q: "%",
      limit: 50,
    });
    expect(literal.secrets).toEqual([]);
    const tagged = await secrets.list(actors.orgAdmin, "foundation", {
      q: prefix,
      tagKey: "env",
      tagValue: "prod",
      limit: 50,
    });
    expect(tagged.secrets).toHaveLength(2);
    const first = await secrets.list(actors.orgAdmin, "foundation", { q: prefix, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await secrets.list(actors.orgAdmin, "foundation", {
      q: prefix,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.secrets[0]?.name).not.toBe(first.secrets[0]?.name);
  });

  it("should reject a malformed cursor", async () => {
    await expect(
      secrets.list(actors.orgAdmin, "foundation", { limit: 1, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
  });

  it("should reject a past expiry", async () => {
    await expect(
      secrets.create(
        actors.orgAdmin,
        "foundation",
        { name: secretName("expired"), value: "x", expiresAt: "2020-01-01T00:00:00.000Z" },
        { requestId: "expired" },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
  });

  it("should list consumers with a live secret.read grant only", async () => {
    const name = secretName("consumer");
    const created = await createSecret(name);
    const consumerId = newUlid();
    await testDb.db.executeQuery(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash)
       VALUES
         (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :hash)`,
      {
        id: consumerId,
        principalId: base.serviceId,
        projectId: base.projectId,
        hash: `sha256:${"a".repeat(64)}`,
      },
    );
    await assign(base.serviceId, "secrets.reader", "project", base.projectId);
    const list = await secrets.consumers(actors.orgAdmin, "foundation", name, {
      requestId: "consumers",
    });
    expect(list).toEqual([
      expect.objectContaining({ composeProject: "payments", composeService: "api" }),
    ]);
    expect(list[0]).not.toHaveProperty("hostname");
    expect(created.id).toBeTruthy();
  });

  it("should compute capabilities for every role", async () => {
    const name = secretName("capabilities");
    await createSecret(name);
    const manager = await insertUser("Secrets Manager");
    const officer = await insertUser("Secrets Officer");
    const reader = await insertUser("Secrets Reader");
    const auditor = await insertUser("Secrets Auditor");
    const plain = await insertUser("Plain Reader");
    await assign(manager, "secrets.manager", "project", base.projectId);
    await assign(officer, "secrets.officer", "project", base.projectId);
    await assign(reader, "secrets.reader", "project", base.projectId);
    await assign(auditor, "auditor", "project", base.projectId);
    await assign(plain, "reader", "project", base.projectId);

    const managerFlags = await secrets.list(manager, "foundation", { limit: 50 });
    expect(managerFlags.secrets[0]?.capabilities).toEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canPurge: true,
      canManage: false,
    });
    const officerFlags = await secrets.list(officer, "foundation", { limit: 50 });
    expect(officerFlags.secrets[0]?.capabilities).toMatchObject({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canPurge: false,
    });
    const readerFlags = await secrets.list(reader, "foundation", { limit: 50 });
    expect(readerFlags.secrets[0]?.capabilities).toMatchObject({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canPurge: false,
    });
    const auditorFlags = await secrets.list(auditor, "foundation", { limit: 50 });
    expect(auditorFlags.secrets[0]?.capabilities.canRead).toBe(false);
    const plainFlags = await secrets.list(plain, "foundation", { limit: 50 });
    expect(plainFlags.secrets[0]?.capabilities.canRead).toBe(false);
  });
});

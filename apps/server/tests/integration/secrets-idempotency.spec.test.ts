import { createHash } from "node:crypto";
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
let currentTime = Date.parse("2026-11-04T12:00:00.000Z");

const clock = (): number => currentTime;

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring, now: clock });
  const policy = new PolicyService({
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

describe("secret idempotency", () => {
  it("should replay a create and keep one secret and version", async () => {
    const name = secretName("idem-create");
    const first = await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name, value: "one" },
      { requestId: "create-1" },
      "key-create-1",
    );
    const second = await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name, value: "one" },
      { requestId: "create-2" },
      "key-create-1",
    );
    expect(second.version.id).toBe(first.version.id);
    const secretsCount = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE name = :name",
      { name },
    );
    const versionsCount = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secret_versions WHERE secret_id = :id",
      { id: first.id },
    );
    expect(secretsCount.records[0]?.count).toBe(1);
    expect(versionsCount.records[0]?.count).toBe(1);
  });

  it("should replay a value write and keep one new version", async () => {
    const name = secretName("idem-write");
    const first = await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    const second = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      { requestId: "write-1" },
      "key-write-1",
    );
    const third = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      { requestId: "write-2" },
      "key-write-1",
    );
    expect(third.version.id).toBe(second.version.id);
    const versionsCount = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secret_versions WHERE secret_id = :id",
      { id: first.id },
    );
    expect(versionsCount.records[0]?.count).toBe(2);
  });

  it("should return the written version after an intervening write", async () => {
    const name = secretName("idem-v1");
    await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    const v1 = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      {},
      "key-v1",
    );
    await secrets.write(actors.orgAdmin, "foundation", name, { value: "three" });
    const replay = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      {},
      "key-v1",
    );
    expect(replay.version.id).toBe(v1.version.id);
    const current = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(current.value).toBe("three");
  });

  it("should reject a different body or path for the same key", async () => {
    const name = secretName("idem-conflict");
    await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" }, {}, "key-conflict");
    await expect(
      secrets.create(
        actors.orgAdmin,
        "foundation",
        { name, value: "different" },
        {},
        "key-conflict",
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    await expect(
      secrets.write(actors.orgAdmin, "foundation", name, { value: "one" }, {}, "key-conflict"),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
  });

  it("should replace an expired claim", async () => {
    const first = await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name: secretName("idem-expired"), value: "one" },
      {},
      "key-expired",
    );
    await testDb.db.executeQuery(
      "UPDATE idempotency_keys SET expires_at = '2026-11-04T11:00:00.000Z' WHERE key = 'key-expired'",
    );
    const second = await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name: secretName("idem-expired-new"), value: "two" },
      {},
      "key-expired",
    );
    expect(second.id).not.toBe(first.id);
    const rows = await testDb.db.executeQuery<{ resource_id: string }>(
      "SELECT resource_id FROM idempotency_keys WHERE key = 'key-expired'",
    );
    expect(rows.records[0]?.resource_id).toBe(second.version.id);
  });

  it("should reject an invalid key", async () => {
    for (const key of ["", "a".repeat(201), "bad\u0001key"]) {
      await expect(
        secrets.create(
          actors.orgAdmin,
          "foundation",
          { name: secretName("idem-invalid"), value: "x" },
          {},
          key,
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
    }
  });

  it("should not store a plain hash of the secret value", async () => {
    const value = "sentinel-idempotency-value";
    await secrets.create(
      actors.orgAdmin,
      "foundation",
      { name: secretName("idem-hash"), value },
      {},
      "key-hash",
    );
    const row = await testDb.db.executeQuery<{ request_hash: Buffer }>(
      "SELECT request_hash FROM idempotency_keys WHERE key = 'key-hash'",
    );
    const hash = row.records[0]?.request_hash;
    expect(hash).toHaveLength(32);
    expect(hash?.equals(createHash("sha256").update(value).digest())).toBe(false);
  });
});

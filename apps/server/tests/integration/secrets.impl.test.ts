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
let repository: SecretRepository;
let currentTime = Date.parse("2026-11-04T12:00:00.000Z");

const clock = (): number => currentTime;

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

/** Runs one mutation with the version immutability trigger disabled. */
async function mutateVersion(action: () => Promise<void>): Promise<void> {
  await testDb.db.executeQuery(
    "ALTER TABLE secret_versions DISABLE TRIGGER secret_versions_no_update",
  );
  try {
    await action();
  } finally {
    await testDb.db.executeQuery(
      "ALTER TABLE secret_versions ENABLE TRIGGER secret_versions_no_update",
    );
  }
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
  repository = new SecretRepository();
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository,
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

describe("secret core implementation", () => {
  it("should fall back to the newest active version when the current version expired", async () => {
    const name = secretName("expiry");
    const first = await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    currentTime += 1_000;
    await secrets.write(actors.orgAdmin, "foundation", name, { value: "two" });
    const second = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM secret_versions WHERE secret_id = :id ORDER BY created_at DESC, id DESC LIMIT 1",
      { id: first.id },
    );
    await mutateVersion(async () => {
      await testDb.db.executeQuery(
        "UPDATE secret_versions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = :id",
        { id: second.records[0]?.id },
      );
    });
    const read = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(read.value).toBe("one");
    expect(read.version.id).toBe(first.version.id);
  });

  it("should reject a write at the retained version limit", async () => {
    const name = secretName("limit");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    for (let index = 0; index < 999; index += 1) {
      await testDb.db.executeQuery(
        `INSERT INTO secret_versions
           (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id,
            created_by, created_at)
         VALUES
           (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
            'kek-1', :createdBy, now())`,
        {
          id: newUlid(),
          secretId: created.id,
          ciphertext: Buffer.from("x"),
          nonce: Buffer.alloc(12, 1),
          tag: Buffer.alloc(16, 1),
          wrappedDek: Buffer.alloc(32, 1),
          wrapNonce: Buffer.alloc(12, 1),
          wrapTag: Buffer.alloc(16, 1),
          createdBy: actors.orgAdmin,
        },
      );
    }
    await expect(
      secrets.write(actors.orgAdmin, "foundation", name, { value: "blocked" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "secret_version_limit" });
  }, 60_000);

  it("should keep two concurrent writes as two versions", async () => {
    const name = secretName("concurrent");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    await Promise.all([
      secrets.write(actors.orgAdmin, "foundation", name, { value: "two" }),
      secrets.write(actors.orgAdmin, "foundation", name, { value: "three" }),
    ]);
    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secret_versions WHERE secret_id = :id",
      { id: created.id },
    );
    expect(count.records[0]?.count).toBe(3);
    const current = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(["two", "three"]).toContain(current.value);
  }, 60_000);

  it("should return an integrity error for a tampered stored version", async () => {
    const name = secretName("tampered");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "value" });
    await mutateVersion(async () => {
      await testDb.db.executeQuery(
        "UPDATE secret_versions SET ciphertext = :ciphertext WHERE id = :id",
        { id: created.version.id, ciphertext: Buffer.from("tampered") },
      );
    });
    await expect(secrets.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 500,
      code: "secret_integrity_failed",
    });
  });

  it("should reject an expired named version", async () => {
    const name = secretName("named-expiry");
    const created = await secrets.create(actors.orgAdmin, "foundation", { name, value: "one" });
    await mutateVersion(async () => {
      await testDb.db.executeQuery(
        "UPDATE secret_versions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = :id",
        { id: created.version.id },
      );
    });
    await expect(
      secrets.read(actors.orgAdmin, "foundation", name, { version: created.version.id }),
    ).rejects.toMatchObject({ statusCode: 410, code: "secret_expired" });
  });
});

import { secretListQuerySchema } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { SecretRepository } from "../../../src/secrets/repository.js";
import { SecretService } from "../../../src/secrets/service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import { createServerEnvironment } from "../helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let currentTime = NOW;

const clock = (): number => currentTime;

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

async function createSecret(name: string): Promise<void> {
  await secrets.create(
    actors.orgAdmin,
    "foundation",
    { name, value: "value", encoding: "utf8", contentType: "text/plain", tags: {} },
    { requestId: `create-${name}` },
  );
}

async function insertVersionAt(name: string, createdAt: string): Promise<void> {
  const found = await testDb.db.executeQuery<{ readonly id: string }>(
    "SELECT id FROM secrets WHERE name = :name",
    { name },
  );
  const secretId = found.records[0]?.id;
  if (secretId === undefined) {
    throw new Error(`Secret ${name} was not found`);
  }
  const versionId = newUlid();
  await testDb.db.executeQuery(
    `INSERT INTO secret_versions
       (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag,
        kek_id, created_by, created_at)
     VALUES
       (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
        'kek-1', :createdBy, :createdAt)`,
    {
      id: versionId,
      secretId,
      ciphertext: Buffer.from("rotation-fixture"),
      nonce: Buffer.alloc(12, 1),
      tag: Buffer.alloc(16, 2),
      wrappedDek: Buffer.alloc(32, 3),
      wrapNonce: Buffer.alloc(12, 4),
      wrapTag: Buffer.alloc(16, 5),
      createdBy: base.userId,
      createdAt,
    },
  );
  await testDb.db.executeQuery(
    "UPDATE secrets SET current_version_id = :versionId WHERE id = :secretId",
    { versionId, secretId },
  );
}

async function setPolicy(name: string, days: number | null): Promise<void> {
  await secrets.updateMetadata(actors.orgAdmin, "foundation", name, {
    rotationIntervalDays: days,
  });
}

async function list(rotation?: "policy" | "due" | "overdue", q?: string) {
  return await secrets.list(actors.orgAdmin, "foundation", {
    limit: 50,
    ...(q === undefined ? {} : { q }),
    ...(rotation === undefined ? {} : { rotation }),
  });
}

async function metadataFor(name: string) {
  const page = await list(undefined, name);
  const found = page.secrets.find((secret) => secret.name === name);
  if (found === undefined) {
    throw new Error(`Secret ${name} was not returned`);
  }
  return found;
}

async function seedConsumer(): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO consumers
       (id, principal_id, project_id, compose_project, compose_service, hostname,
        manifest_hash, state)
     VALUES
       (:id, :principalId, :projectId, 'payments', 'api', 'api-1',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'degraded')`,
    { id: newUlid(), principalId: base.serviceId, projectId: base.projectId },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'secrets.reader', 'project', :projectId, :grantedBy)`,
    {
      id: newUlid(),
      principalId: base.serviceId,
      projectId: base.projectId,
      grantedBy: base.userId,
    },
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
    softDeleteDays: 30,
    rotationWarningDays: 7,
    now: clock,
  });
  await seedConsumer();
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = NOW;
  await resetAuditTables(testDb.db);
});

describe("rotation policy metadata", () => {
  it("should return the interval, derived due date, and ok status", async () => {
    const name = secretName("policy-ok");
    await createSecret(name);
    await insertVersionAt(name, "2026-11-04T12:00:00.000Z");
    await setPolicy(name, 30);

    const metadata = await metadataFor(name);
    expect(metadata.rotationIntervalDays).toBe(30);
    expect(metadata.rotationDueAt).toBe("2026-12-04T12:00:00.000Z");
    expect(metadata.rotationStatus).toBe("ok");
  });

  it("should clear the policy and all rotation fields", async () => {
    const name = secretName("policy-clear");
    await createSecret(name);
    await setPolicy(name, 30);
    const cleared = await secrets.updateMetadata(actors.orgAdmin, "foundation", name, {
      rotationIntervalDays: null,
    });
    expect(cleared.rotationIntervalDays).toBeNull();
    expect(cleared.rotationDueAt).toBeNull();
    expect(cleared.rotationStatus).toBeNull();
  });

  it("should compute ok, due_soon, and overdue at the boundaries", async () => {
    const name = secretName("policy-status");
    await createSecret(name);
    await setPolicy(name, 30);

    await insertVersionAt(name, "2026-10-13T12:00:00.000Z");
    let metadata = await metadataFor(name);
    expect(metadata.rotationStatus).toBe("ok");

    await insertVersionAt(name, "2026-10-12T12:00:00.000Z");
    metadata = await metadataFor(name);
    expect(metadata.rotationStatus).toBe("due_soon");

    await insertVersionAt(name, "2026-10-05T12:00:00.000Z");
    metadata = await metadataFor(name);
    expect(metadata.rotationStatus).toBe("overdue");
  });

  it("should return null rotation fields when there is no current version", async () => {
    const name = secretName("policy-no-version");
    await createSecret(name);
    await setPolicy(name, 30);
    await testDb.db.executeQuery(
      "UPDATE secrets SET current_version_id = NULL WHERE name = :name",
      { name },
    );
    const metadata = await metadataFor(name);
    expect(metadata.rotationIntervalDays).toBe(30);
    expect(metadata.rotationDueAt).toBeNull();
    expect(metadata.rotationStatus).toBeNull();
  });

  it("should reject an interval below 1, above 3650, and a fraction", async () => {
    const name = secretName("bad-interval");
    await createSecret(name);
    for (const value of [0, 3651, 1.5]) {
      await expect(
        secrets.updateMetadata(actors.orgAdmin, "foundation", name, {
          rotationIntervalDays: value,
        }),
      ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
    }
  });
});

describe("rotation list filters", () => {
  it("should list only policy secrets with rotation=policy", async () => {
    const policyName = secretName("filter-policy");
    const plainName = secretName("filter-plain");
    await createSecret(policyName);
    await createSecret(plainName);
    await setPolicy(policyName, 30);

    const page = await list("policy");
    const names = page.secrets.map((secret) => secret.name);
    expect(names).toContain(policyName);
    expect(names).not.toContain(plainName);
  });

  it("should include due-soon and overdue secrets with rotation=due", async () => {
    const dueSoon = secretName("filter-due-soon");
    const overdue = secretName("filter-overdue");
    const ok = secretName("filter-ok");
    const plain = secretName("filter-plain-2");
    for (const name of [dueSoon, overdue, ok, plain]) {
      await createSecret(name);
    }
    await setPolicy(dueSoon, 30);
    await setPolicy(overdue, 30);
    await setPolicy(ok, 30);
    await insertVersionAt(dueSoon, "2026-10-10T12:00:00.000Z");
    await insertVersionAt(overdue, "2026-10-01T12:00:00.000Z");
    await insertVersionAt(ok, "2026-11-01T12:00:00.000Z");

    const page = await list("due");
    const names = page.secrets.map((secret) => secret.name);
    expect(names).toEqual(expect.arrayContaining([dueSoon, overdue]));
    expect(names).not.toContain(ok);
    expect(names).not.toContain(plain);
  });

  it("should list only overdue secrets with rotation=overdue", async () => {
    const dueSoon = secretName("filter-due-soon-2");
    const overdue = secretName("filter-overdue-2");
    await createSecret(dueSoon);
    await createSecret(overdue);
    await setPolicy(dueSoon, 30);
    await setPolicy(overdue, 30);
    await insertVersionAt(dueSoon, "2026-10-10T12:00:00.000Z");
    await insertVersionAt(overdue, "2026-10-01T12:00:00.000Z");

    const page = await list("overdue");
    const names = page.secrets.map((secret) => secret.name);
    expect(names).toContain(overdue);
    expect(names).not.toContain(dueSoon);
  });

  it("should keep the unfiltered list unchanged and expose rotation fields", async () => {
    const name = secretName("filter-none");
    await createSecret(name);
    await setPolicy(name, 30);
    const page = await list();
    const found = page.secrets.find((secret) => secret.name === name);
    expect(found?.rotationIntervalDays).toBe(30);
    expect(found?.rotationStatus).toBeDefined();
  });

  it("should reject an unknown rotation filter value", () => {
    expect(secretListQuerySchema.safeParse({ rotation: "attention" }).success).toBe(false);
    expect(secretListQuerySchema.safeParse({ rotation: "policy" }).success).toBe(true);
  });
});

describe("consumer summaries", () => {
  it("should expose the consumer state through secret metadata and the consumer list", async () => {
    const metadata = await secrets.updateMetadata(
      actors.orgAdmin,
      "foundation",
      "database-password",
      {},
    );
    expect(metadata.consumers[0]?.state).toBe("degraded");
    expect(metadata.consumers[0]?.lastSeen).toBeDefined();

    const consumers = await secrets.consumers(actors.orgAdmin, "foundation", "database-password");
    expect(consumers[0]?.state).toBe("degraded");
  });
});

describe("warning-window boundary", () => {
  it("should use the injected clock at the exact warning boundary", async () => {
    const name = secretName("clock-boundary");
    await createSecret(name);
    await setPolicy(name, 30);
    // dueAt minus seven days must be exactly NOW for this version age.
    await insertVersionAt(name, "2026-10-12T12:00:00.000Z");

    currentTime = NOW;
    const atBoundary = await list("due");
    expect(atBoundary.secrets.map((secret) => secret.name)).toContain(name);
    expect((await metadataFor(name)).rotationStatus).toBe("due_soon");

    currentTime = NOW - 1;
    const beforeBoundary = await list("due");
    expect(beforeBoundary.secrets.map((secret) => secret.name)).not.toContain(name);
    expect((await metadataFor(name)).rotationStatus).toBe("ok");
  });
});

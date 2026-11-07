import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConsumerRepository } from "../../src/agent/consumer-repository.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import { createAuditCore } from "../../src/audit/runtime.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { VaultPurger } from "../../src/purge/vault-purger.js";
import type { PolicyAuditContext } from "../../src/rbac/audit.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import {
  type PolicyDecision,
  PolicyService,
  type RecordDecisionOptions,
} from "../../src/rbac/policy-service.js";
import { SecretRepository } from "../../src/secrets/repository.js";
import { SecretService } from "../../src/secrets/service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { ensurePurgerRole } from "./helpers/purger.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let purger: VaultPurger | undefined;
let currentTime = Date.parse("2026-11-04T12:00:00.000Z");

const clock = (): number => currentTime;

/** Simulates an audit outage after the purge transaction commits. */
class CompletionFailingPolicy extends PolicyService {
  public override async recordDecision(
    decision: PolicyDecision,
    context?: PolicyAuditContext,
    tx?: Parameters<PolicyService["recordDecision"]>[2],
    options: RecordDecisionOptions = {},
  ): Promise<void> {
    if (options.details?.phase === "completed") {
      throw new PolicyUnavailableError();
    }
    return super.recordDecision(decision, context, tx, options);
  }
}

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

async function createSecret(
  name: string,
  value = "value",
): Promise<Awaited<ReturnType<SecretService["create"]>>> {
  return secrets.create(
    actors.orgAdmin,
    "foundation",
    { name, value },
    { requestId: `create-${name}` },
  );
}

async function makePurgeable(id: string): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE secrets
        SET deleted_at = '2020-01-01T00:00:00.000Z',
            purge_after = '2020-01-02T00:00:00.000Z'
      WHERE id = :id`,
    { id },
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
  const purgeUrl = await ensurePurgerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  purger =
    purgeUrl === undefined
      ? undefined
      : new VaultPurger({ url: purgeUrl, appDatabase: testDb.name });
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
    ...(purger === undefined ? {} : { purger }),
    now: clock,
  });
}, 60_000);

afterAll(async () => {
  await purger?.close();
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-11-04T12:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("secret lifecycle", () => {
  it("should update metadata without creating a version", async () => {
    const name = secretName("metadata");
    const created = await createSecret(name);
    const updated = await secrets.updateMetadata(actors.orgAdmin, "foundation", name, {
      tags: { env: "prod" },
      contentType: "application/json",
    });
    expect(updated.tags).toEqual({ env: "prod" });
    expect(updated.contentType).toBe("application/json");
    expect(await secrets.versions(actors.orgAdmin, "foundation", name)).toHaveLength(1);
    expect(updated.currentVersion?.id).toBe(created.version.id);
  });

  it("should enable protection, reject disabling it, and treat false/false as a no-op", async () => {
    const name = secretName("protect");
    await createSecret(name);
    const enabled = await secrets.updateMetadata(actors.orgAdmin, "foundation", name, {
      purgeProtected: true,
    });
    expect(enabled.purgeProtected).toBe(true);
    await expect(
      secrets.updateMetadata(actors.orgAdmin, "foundation", name, { purgeProtected: false }),
    ).rejects.toMatchObject({ statusCode: 409, code: "purge_protection_locked" });

    const plain = secretName("plain");
    await createSecret(plain);
    const noop = await secrets.updateMetadata(actors.orgAdmin, "foundation", plain, {
      purgeProtected: false,
    });
    expect(noop.purgeProtected).toBe(false);
  });

  it("should soft delete and recover before retention", async () => {
    const name = secretName("recover");
    await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await expect(secrets.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
      statusCode: 404,
      code: "secret_not_found",
    });
    const listed = await secrets.list(actors.orgAdmin, "foundation", { q: name, limit: 50 });
    expect(listed.secrets.some((secret) => secret.name === name)).toBe(false);
    const recovered = await secrets.recover(actors.orgAdmin, "foundation", name);
    expect(recovered.status).toBe("active");
    const read = await secrets.read(actors.orgAdmin, "foundation", name, {});
    expect(read.value).toBe("value");
  });

  it("should reject recovery after retention and a repeated delete", async () => {
    const name = secretName("late");
    const created = await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await expect(secrets.delete(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 404,
      code: "secret_not_found",
    });
    await makePurgeable(created.id);
    await expect(secrets.recover(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "secret_not_recoverable",
    });
  });

  it("should reject purge before retention and while protected", async () => {
    const name = secretName("early");
    const early = await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await expect(secrets.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 409,
      code: "secret_retention_active",
    });
    await makePurgeable(early.id);

    const protectedName = secretName("protected");
    const protectedSecret = await createSecret(protectedName);
    await secrets.updateMetadata(actors.orgAdmin, "foundation", protectedName, {
      purgeProtected: true,
    });
    await secrets.delete(actors.orgAdmin, "foundation", protectedName);
    await makePurgeable(protectedSecret.id);
    await expect(secrets.purge(actors.orgAdmin, "foundation", protectedName)).rejects.toMatchObject(
      { statusCode: 409, code: "purge_protection_locked" },
    );
  });

  it("should replay a value write after the secret is soft deleted", async () => {
    const name = secretName("replay-deleted");
    await createSecret(name);
    const written = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      {},
      "key-deleted-replay",
    );
    await secrets.delete(actors.orgAdmin, "foundation", name);
    const replay = await secrets.write(
      actors.orgAdmin,
      "foundation",
      name,
      { value: "two" },
      {},
      "key-deleted-replay",
    );
    expect(replay.version.id).toBe(written.version.id);
  });

  it("should purge after retention and allow the name to be reused", async () => {
    if (purger === undefined) {
      return;
    }
    const name = secretName("purge");
    const created = await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    await expect(secrets.purge(actors.orgAdmin, "foundation", name)).resolves.toBeUndefined();
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE id = :id",
      { id: created.id },
    );
    expect(rows.records[0]?.count).toBe(0);
    const events = await testDb.db.executeQuery<{ result: string; phase: string }>(
      `SELECT result, details->>'phase' AS phase
         FROM audit_events
        WHERE action = 'secret.purge'
        ORDER BY id`,
    );
    expect(events.records).toEqual([
      { result: "allow", phase: "authorized" },
      { result: "allow", phase: "completed" },
    ]);
    await expect(createSecret(name)).resolves.toMatchObject({ name });
  });

  it("should keep authorization evidence when the completion audit fails", async () => {
    if (purger === undefined) {
      return;
    }
    const name = secretName("completion");
    const created = await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    const core = createAuditCore({ database: testDb.db, keyring, now: clock });
    const policy = new CompletionFailingPolicy({
      repository: new PolicyRepository(testDb.db),
      audit: core.policyAudit,
      now: clock,
    });
    const service = new SecretService({
      database: testDb.db,
      keyring,
      policy,
      audit: core.writer,
      projectRepository: new ProjectRepository(testDb.db),
      repository: new SecretRepository(),
      secretMaxBytes: 65_536,
      softDeleteDays: 30,
      purger,
      now: clock,
    });

    await expect(service.purge(actors.orgAdmin, "foundation", name)).rejects.toBeInstanceOf(
      PolicyUnavailableError,
    );
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secrets WHERE id = :id",
      { id: created.id },
    );
    expect(rows.records[0]?.count).toBe(0);
    const events = await testDb.db.executeQuery<{ result: string; phase: string }>(
      `SELECT result, details->>'phase' AS phase
         FROM audit_events
        WHERE action = 'secret.purge'
        ORDER BY id`,
    );
    expect(events.records).toEqual([{ result: "allow", phase: "authorized" }]);
  });

  it("should reject purge without a configured or valid purger", async () => {
    const name = secretName("nopurger");
    const created = await createSecret(name);
    await secrets.delete(actors.orgAdmin, "foundation", name);
    await makePurgeable(created.id);
    const core = createAuditCore({ database: testDb.db, keyring, now: clock });
    const policy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: core.policyAudit,
      now: clock,
    });
    const without = new SecretService({
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
    await expect(without.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
    });

    const wrong = new VaultPurger({
      url: testDb.url,
      appDatabase: testDb.name,
    });
    try {
      const wrongService = new SecretService({
        database: testDb.db,
        keyring,
        policy,
        audit: core.writer,
        projectRepository: new ProjectRepository(testDb.db),
        repository: new SecretRepository(),
        secretMaxBytes: 65_536,
        softDeleteDays: 30,
        purger: wrong,
        now: clock,
      });
      await expect(wrongService.purge(actors.orgAdmin, "foundation", name)).rejects.toMatchObject({
        statusCode: 503,
        code: "service_unavailable",
      });
    } finally {
      await wrong.close();
    }
  });

  it("should hide a secret after its project is deleted", async () => {
    const name = secretName("project-hidden");
    await createSecret(name);
    try {
      await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
        id: base.projectId,
      });
      await expect(secrets.read(actors.orgAdmin, "foundation", name, {})).rejects.toMatchObject({
        statusCode: 404,
        code: "secret_not_found",
      });
    } finally {
      await testDb.db.executeQuery("UPDATE projects SET deleted_at = NULL WHERE id = :id", {
        id: base.projectId,
      });
    }
  });

  it("should update the consumer heartbeat on an agent read", async () => {
    const name = secretName("consumer-touch");
    await createSecret(name);
    await testDb.db.executeQuery(
      `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
       VALUES (:id, :principalId, 'secrets.reader', 'project', :projectId, :principalId)`,
      { id: newUlid(), principalId: base.serviceId, projectId: base.projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash,
          last_seen)
       VALUES
         (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :hash,
          now() - interval '1 hour')`,
      {
        id: newUlid(),
        principalId: base.serviceId,
        projectId: base.projectId,
        hash: `sha256:${"b".repeat(64)}`,
      },
    );
    const before = await testDb.db.executeQuery<{ last_seen: Date }>(
      "SELECT last_seen FROM consumers WHERE principal_id = :id",
      { id: base.serviceId },
    );
    await new ConsumerRepository(testDb.db).touchConsumer(testDb.db, base.serviceId, "degraded");
    const after = await testDb.db.executeQuery<{ last_seen: Date; state: string }>(
      "SELECT last_seen, state FROM consumers WHERE principal_id = :id",
      { id: base.serviceId },
    );
    expect(after.records[0]?.last_seen.getTime()).toBeGreaterThan(
      before.records[0]?.last_seen.getTime() ?? 0,
    );
    expect(after.records[0]?.state).toBe("degraded");
  });

  it("should still read a 64 KiB secret after the configured limit is lowered", async () => {
    const name = secretName("lowered-limit");
    const value = "a".repeat(65_536);
    await secrets.create(actors.orgAdmin, "foundation", { name, value });
    const core = createAuditCore({ database: testDb.db, keyring, now: clock });
    const policy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: core.policyAudit,
      now: clock,
    });
    const narrowed = new SecretService({
      database: testDb.db,
      keyring,
      policy,
      audit: core.writer,
      projectRepository: new ProjectRepository(testDb.db),
      repository: new SecretRepository(),
      secretMaxBytes: 1_024,
      softDeleteDays: 30,
      now: clock,
    });
    const read = await narrowed.read(actors.orgAdmin, "foundation", name, {});
    expect(read.value).toBe(value);
  }, 60_000);

  it("should fail a read with 503 and no value when the audit writer is down", async () => {
    const name = secretName("audit-down");
    await createSecret(name);
    class FailingReadWriter extends AuditWriter {
      public override async record(
        input: Parameters<AuditWriter["record"]>[0],
        tx?: Parameters<AuditWriter["record"]>[1],
        options?: Parameters<AuditWriter["record"]>[2],
      ): ReturnType<AuditWriter["record"]> {
        if (input.action === "secret.read") {
          throw new Error("audit unavailable");
        }
        return super.record(input, tx, options);
      }
    }
    const failingWriter = new FailingReadWriter({ database: testDb.db, keyring, now: clock });
    const policy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: new PersistentPolicyAudit({
        writer: failingWriter,
        database: testDb.db,
        now: clock,
      }),
      now: clock,
    });
    const failing = new SecretService({
      database: testDb.db,
      keyring,
      policy,
      audit: failingWriter,
      projectRepository: new ProjectRepository(testDb.db),
      repository: new SecretRepository(),
      secretMaxBytes: 65_536,
      softDeleteDays: 30,
      now: clock,
    });
    await expect(failing.read(actors.orgAdmin, "foundation", name, {})).rejects.toBeInstanceOf(
      PolicyUnavailableError,
    );
  });
});

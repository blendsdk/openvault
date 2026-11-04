import { newUlid } from "@openvault/core";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { AuditInputError, AuditUnavailableError } from "../../src/audit/errors.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import type { AuditEventInput } from "../../src/audit/types.js";
import { parseDatabaseUrl } from "../../src/db/url.js";
import { AssignmentService } from "../../src/rbac/assignment-service.js";
import type { PolicyDecisionEvent } from "../../src/rbac/audit.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const AUDIT_TRIGGERS = [
  ["audit_events", "audit_events_no_update"],
  ["audit_events", "audit_events_no_delete"],
  ["audit_events", "audit_events_no_truncate"],
  ["audit_checkpoints", "audit_checkpoints_no_update"],
  ["audit_checkpoints", "audit_checkpoints_no_delete"],
  ["audit_checkpoints", "audit_checkpoints_no_truncate"],
] as const;

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let writer: AuditWriter;
let currentTime = Date.parse("2026-04-01T00:00:00.000Z");

const clock = (): number => currentTime;

async function resetAudit(): Promise<void> {
  for (const [table, trigger] of AUDIT_TRIGGERS) {
    await testDb.db.executeQuery(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }
  try {
    await testDb.db.executeQuery(
      "TRUNCATE audit_events, audit_checkpoints, audit_keys RESTART IDENTITY",
    );
  } finally {
    for (const [table, trigger] of AUDIT_TRIGGERS) {
      await testDb.db.executeQuery(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }
}

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    eventId: newUlid(),
    ts: new Date(currentTime),
    projectId: base.projectId,
    requestId: "request-impl",
    actorId: base.userId,
    actorKind: "user",
    action: "project.read",
    scopeType: "project",
    scopeId: base.projectId,
    objectType: "project",
    objectId: base.projectId,
    result: "allow",
    sourceIp: null,
    userAgent: null,
    details: { reason: "allowed" },
    ...overrides,
  };
}

function decision(overrides: Partial<PolicyDecisionEvent> = {}): PolicyDecisionEvent {
  return {
    actorId: base.userId,
    actorKind: "user",
    action: "project.read",
    scopeType: "project",
    scopeId: base.projectId,
    projectId: base.projectId,
    objectType: "project",
    objectId: base.projectId,
    result: "allow",
    reason: "allowed",
    policyVersion: 3,
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  writer = new AuditWriter({ database: testDb.db, keyring, now: clock });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-04-01T00:00:00.000Z");
  await resetAudit();
  writer = new AuditWriter({ database: testDb.db, keyring, now: clock });
});

describe("audit chain implementation", () => {
  it("should keep one unbroken chain under ten concurrent writers", async () => {
    const records = await Promise.all(Array.from({ length: 10 }, () => writer.record(input())));
    expect(new Set(records.map((record) => record.eventId)).size).toBe(10);

    const rows = await testDb.db.executeQuery<{ prev_hash: Buffer; hash: Buffer }>(
      "SELECT prev_hash, hash FROM audit_events ORDER BY id ASC",
    );
    expect(rows.records).toHaveLength(10);
    for (let index = 1; index < rows.records.length; index += 1) {
      expect(rows.records[index]?.prev_hash.toString("hex")).toBe(
        rows.records[index - 1]?.hash.toString("hex"),
      );
    }
  }, 60_000);

  it("should keep the chain valid across a rolled-back sequence gap", async () => {
    const first = await writer.record(input());
    await expect(
      testDb.db.withTransaction(async (tx) => {
        await writer.record(input(), tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const second = await writer.record(input());

    expect(BigInt(second.sequenceId)).toBeGreaterThan(BigInt(first.sequenceId) + 1n);
    expect(second.prevHash.toString("hex")).toBe(first.hash.toString("hex"));
  });

  it("should preserve millisecond timestamps through the database", async () => {
    const ts = new Date("2026-04-01T12:34:56.789Z");
    const record = await writer.record(input({ ts }));
    expect(record.ts.toISOString()).toBe("2026-04-01T12:34:56.789Z");

    const rows = await testDb.db.executeQuery<{ ts: Date }>(
      "SELECT ts FROM audit_events WHERE event_id = :eventId",
      { eventId: record.eventId },
    );
    expect(rows.records[0]?.ts.toISOString()).toBe("2026-04-01T12:34:56.789Z");
  });

  it("should checkpoint at the configured count boundary", async () => {
    writer = new AuditWriter({
      database: testDb.db,
      keyring,
      now: clock,
      checkpointEvery: 3,
    });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push((await writer.record(input())).sequenceId);
    }

    const checkpoints = await testDb.db.executeQuery<{ last_event_id: string }>(
      "SELECT last_event_id FROM audit_checkpoints ORDER BY last_event_id ASC",
    );
    expect(checkpoints.records.map((row) => row.last_event_id)).toEqual([ids[0], ids[3]]);
  });

  it("should keep an event written inside a committed caller transaction", async () => {
    const record = await testDb.db.withTransaction(async (tx) => writer.record(input(), tx));
    const rows = await testDb.db.executeQuery<{ event_id: string }>(
      "SELECT event_id FROM audit_events",
    );
    expect(rows.records[0]?.event_id).toBe(record.eventId);
  });

  it("should return undefined when ensureCheckpoint runs on an empty chain", async () => {
    await expect(writer.ensureCheckpoint()).resolves.toBeUndefined();
  });

  it("should keep an allowed decision when its caller transaction rolls back", async () => {
    const independent = new PostgreSQLDatabase(parseDatabaseUrl(testDb.url));
    try {
      const independentWriter = new AuditWriter({
        database: testDb.db,
        independentDatabase: independent,
        keyring,
        now: clock,
      });
      const adapter = new PersistentPolicyAudit({
        writer: independentWriter,
        database: testDb.db,
        now: clock,
      });

      await expect(
        testDb.db.withTransaction(async (tx) => {
          await adapter.recordDecision(decision({ result: "allow" }), tx);
          throw new Error("assignment failed");
        }),
      ).rejects.toThrow("assignment failed");

      const rows = await testDb.db.executeQuery<{ result: string; action: string }>(
        "SELECT result, action FROM audit_events",
      );
      expect(rows.records).toEqual([{ result: "allow", action: "project.read" }]);
    } finally {
      await independent.disconnect();
    }
  });

  it("should reject a checkpoint anchored at an event that is not stored", async () => {
    const record = await writer.record(input());
    const forged = { ...record, hash: Buffer.alloc(32, 7) };
    await expect(writer.checkpointAt(forged)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("should return the existing checkpoint when checkpointAt is repeated", async () => {
    const record = await writer.record(input());
    const first = await writer.checkpointAt(record);
    const second = await writer.checkpointAt(record);
    expect(second.id).toBe(first.id);
  });

  it("should truncate a user agent without splitting a surrogate pair", async () => {
    const userAgent = `${"a".repeat(511)}😀`;
    const record = await writer.record(input({ userAgent }));
    expect(record.userAgent?.length).toBeLessThanOrEqual(512);
    const last = record.userAgent?.charCodeAt((record.userAgent?.length ?? 0) - 1) ?? 0;
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("should reject an unknown action, invalid timestamp, and invalid source address", async () => {
    await expect(
      writer.record(input({ action: "unknown.action" as never })),
    ).rejects.toBeInstanceOf(AuditInputError);
    await expect(writer.record(input({ ts: new Date(Number.NaN) }))).rejects.toBeInstanceOf(
      AuditInputError,
    );
    await expect(writer.record(input({ sourceIp: "not-an-ip" }))).rejects.toBeInstanceOf(
      AuditInputError,
    );
  });

  it("should keep one decision event when a duplicate assignment is rejected", async () => {
    const independent = new PostgreSQLDatabase(parseDatabaseUrl(testDb.url));
    try {
      const independentWriter = new AuditWriter({
        database: testDb.db,
        independentDatabase: independent,
        keyring,
        now: clock,
      });
      const adapter = new PersistentPolicyAudit({
        writer: independentWriter,
        database: testDb.db,
        now: clock,
      });
      const repository = new PolicyRepository(testDb.db);
      const policy = new PolicyService({ repository, audit: adapter });
      const assignments = new AssignmentService({
        database: testDb.db,
        repository,
        policy,
        audit: adapter,
        now: clock,
      });

      await testDb.db.executeQuery(
        `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
         VALUES (:id, :principalId, 'org.admin', 'org', 'org', :grantedBy)`,
        { id: newUlid(), principalId: base.userId, grantedBy: base.userId },
      );

      const request = {
        principalId: base.serviceId,
        role: "secrets.reader" as const,
        scopeType: "project" as const,
        scopeId: base.projectId,
      };
      await assignments.create(base.userId, request);
      await expect(assignments.create(base.userId, request)).rejects.toMatchObject({
        statusCode: 409,
      });

      const rows = await testDb.db.executeQuery<{ action: string; result: string }>(
        "SELECT action, result FROM audit_events ORDER BY id ASC",
      );
      expect(rows.records.filter((row) => row.action === "assignment.write")).toHaveLength(2);
      expect(rows.records.filter((row) => row.action === "assignment.grant")).toHaveLength(1);
      expect(rows.records.every((row) => row.result === "allow")).toBe(true);
    } finally {
      await independent.disconnect();
    }
  }, 60_000);
});

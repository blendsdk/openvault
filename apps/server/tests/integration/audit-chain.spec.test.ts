import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAuditKey, withAuditKey } from "../../src/audit/audit-key-store.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { canonicalJson } from "../../src/audit/canonical-json.js";
import { AuditInputError, AuditKeyUnavailableError } from "../../src/audit/errors.js";
import {
  canonicalEventForHash,
  computeEventHash,
  computeEventHmac,
} from "../../src/audit/hashing.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import type { AuditEventInput } from "../../src/audit/types.js";
import type { PolicyDecisionEvent, PolicyMutationEvent } from "../../src/rbac/audit.js";
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
let adapter: PersistentPolicyAudit;
let currentTime = Date.parse("2026-03-01T00:00:00.000Z");

const clock = (): number => currentTime;

/** Empties the audit tables without weakening the append-only contract for the application. */
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

/** Builds a complete project-scoped event input. */
function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    eventId: newUlid(),
    ts: new Date(currentTime),
    projectId: base.projectId,
    requestId: "request-1",
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

/** Builds a policy decision event. */
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

/** Builds an assignment mutation event. */
function mutation(overrides: Partial<PolicyMutationEvent> = {}): PolicyMutationEvent {
  return {
    actorId: base.userId,
    actorKind: "user",
    action: "assignment.grant",
    assignmentId: newUlid(),
    targetPrincipalId: base.serviceId,
    role: "secrets.reader",
    scopeType: "object",
    scopeId: base.secretId,
    projectId: base.projectId,
    result: "allow",
    reason: "allowed",
    policyVersion: 4,
    ...overrides,
  };
}

/** Returns the number of rows in one audit table. */
async function count(table: "audit_events" | "audit_checkpoints" | "audit_keys"): Promise<number> {
  const result = await testDb.db.executeQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.records[0]?.count ?? 0;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  writer = new AuditWriter({ database: testDb.db, keyring, now: clock });
  adapter = new PersistentPolicyAudit({ writer, database: testDb.db, now: clock });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-03-01T00:00:00.000Z");
  await resetAudit();
});

describe("audit chain writer", () => {
  it("should write a zero previous hash and one key and checkpoint for the first event", async () => {
    const record = await writer.record(input());

    const row = await testDb.db.executeQuery<{
      id: string;
      prev_hash: Buffer;
      hash: Buffer;
      hmac: Buffer;
    }>(`SELECT id, prev_hash, hash, hmac FROM audit_events WHERE event_id = :eventId`, {
      eventId: record.eventId,
    });
    const stored = row.records[0];
    expect(stored).toBeDefined();
    expect(stored?.prev_hash.toString("hex")).toBe("0".repeat(64));
    expect(record.hash).toHaveLength(32);
    expect(record.hmac).toHaveLength(32);
    await expect(count("audit_keys")).resolves.toBe(1);
    await expect(count("audit_checkpoints")).resolves.toBe(1);

    const checkpoint = await testDb.db.executeQuery<{ last_event_id: string }>(
      "SELECT last_event_id FROM audit_checkpoints",
    );
    expect(checkpoint.records[0]?.last_event_id).toBe(record.sequenceId);
  });

  it("should link the second event to the first hash and keep both hashes valid", async () => {
    const first = await writer.record(input());
    currentTime += 1_000;
    const second = await writer.record(input());

    expect(second.prevHash.toString("hex")).toBe(first.hash.toString("hex"));

    const key = await loadAuditKey(testDb.db, second.auditKeyId);
    expect(key).toBeDefined();
    if (key === undefined) {
      throw new Error("audit key fixture is missing");
    }
    const canonical = canonicalJson(
      canonicalEventForHash(second, second.prevHash, second.auditKeyId),
    );
    expect(computeEventHash(canonical, second.prevHash).toString("hex")).toBe(
      second.hash.toString("hex"),
    );
    const hmac = withAuditKey(keyring, key, (material) => computeEventHmac(material, second.hash));
    expect(hmac.toString("hex")).toBe(second.hmac.toString("hex"));
  });

  it("should serialize concurrent records into one chain", async () => {
    const [left, right] = await Promise.all([writer.record(input()), writer.record(input())]);
    expect(left.eventId).not.toBe(right.eventId);

    const rows = await testDb.db.executeQuery<{
      event_id: string;
      prev_hash: Buffer;
      hash: Buffer;
    }>("SELECT event_id, prev_hash, hash FROM audit_events ORDER BY id ASC");
    expect(rows.records).toHaveLength(2);
    expect(rows.records[1]?.prev_hash.toString("hex")).toBe(rows.records[0]?.hash.toString("hex"));
  });

  it("should produce different identity, time, and hashes for identical business fields", async () => {
    const first = await writer.record(input());
    currentTime += 1_000;
    const second = await writer.record(input());

    expect(second.eventId).not.toBe(first.eventId);
    expect(second.ts.toISOString()).not.toBe(first.ts.toISOString());
    expect(second.hash.toString("hex")).not.toBe(first.hash.toString("hex"));
    expect(second.hmac.toString("hex")).not.toBe(first.hmac.toString("hex"));
    await expect(count("audit_events")).resolves.toBe(2);
  });

  it("should reuse the existing audit key", async () => {
    const first = await writer.record(input());
    const second = await writer.record(input());

    expect(second.auditKeyId).toBe(first.auditKeyId);
    await expect(count("audit_keys")).resolves.toBe(1);
  });

  it("should fail without an event when the keyring cannot unwrap the stored key", async () => {
    await writer.record(input());

    const directory = mkdtempSync(join(tmpdir(), "openvault-audit-keys-"));
    const path = join(directory, "keyring.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        current: "k2",
        keys: { k2: Buffer.alloc(32, 9).toString("base64") },
      }),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);

    const replacement = await KeyringProvider.load(path);
    try {
      const altWriter = new AuditWriter({ database: testDb.db, keyring: replacement, now: clock });
      await expect(altWriter.record(input())).rejects.toBeInstanceOf(AuditKeyUnavailableError);
      await expect(count("audit_events")).resolves.toBe(1);
    } finally {
      replacement.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should checkpoint the first event and the 1,001st event", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 1_001; index += 1) {
      const record = await writer.record(input());
      ids.push(record.sequenceId);
    }

    const checkpoints = await testDb.db.executeQuery<{ last_event_id: string }>(
      "SELECT last_event_id FROM audit_checkpoints ORDER BY last_event_id ASC",
    );
    const checkpointIds = checkpoints.records.map((row) => row.last_event_id);
    expect(checkpointIds).toContain(ids[0]);
    expect(checkpointIds).toContain(ids[1_000]);
    expect(checkpointIds).not.toContain(ids[999]);
  }, 180_000);

  it("should checkpoint after a day without a checkpoint", async () => {
    const first = await writer.record(input());
    currentTime += 24 * 60 * 60_000;
    const second = await writer.record(input());

    const checkpoints = await testDb.db.executeQuery<{ last_event_id: string }>(
      "SELECT last_event_id FROM audit_checkpoints ORDER BY last_event_id ASC",
    );
    const checkpointIds = checkpoints.records.map((row) => row.last_event_id);
    expect(checkpointIds).toContain(first.sequenceId);
    expect(checkpointIds).toContain(second.sequenceId);
  });

  it("should reject an unknown details key without writing a row", async () => {
    await expect(writer.record(input({ details: { token: "sentinel" } }))).rejects.toBeInstanceOf(
      AuditInputError,
    );
    await expect(count("audit_events")).resolves.toBe(0);
  });

  it("should reject details above the encoded size bound without writing a row", async () => {
    const changed = Array.from({ length: 17 }, () => "x".repeat(1_024));
    await expect(
      writer.record(input({ action: "consumer.update", details: { changed } })),
    ).rejects.toBeInstanceOf(AuditInputError);
    await expect(count("audit_events")).resolves.toBe(0);
  });

  it("should roll back a mutation event with its caller transaction", async () => {
    await expect(
      testDb.db.withTransaction(async (tx) => {
        await writer.record(input(), tx);
        throw new Error("assignment failed");
      }),
    ).rejects.toThrow("assignment failed");

    await expect(count("audit_events")).resolves.toBe(0);
  });

  it("should keep a denied decision after the assignment transaction rolls back", async () => {
    await adapter.recordDecision(
      decision({ result: "deny", reason: "no_assignment", policyVersion: 7 }),
    );

    await expect(
      testDb.db.withTransaction(async () => {
        throw new Error("assignment failed");
      }),
    ).rejects.toThrow("assignment failed");

    const rows = await testDb.db.executeQuery<{
      result: string;
      details: { policyVersion: number };
    }>("SELECT result, details FROM audit_events");
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]?.result).toBe("deny");
    expect(rows.records[0]?.details.policyVersion).toBe(7);
  });

  it("should store a system decision with null scope and project", async () => {
    await adapter.recordDecision(
      decision({
        scopeType: "system",
        scopeId: null,
        projectId: null,
        objectType: null,
        objectId: null,
        result: "deny",
        reason: "no_assignment",
      }),
    );

    const rows = await testDb.db.executeQuery<{
      scope_type: string;
      scope_id: string | null;
      project_id: string | null;
      result: string;
    }>("SELECT scope_type, scope_id, project_id, result FROM audit_events");
    expect(rows.records[0]).toMatchObject({
      scope_type: "system",
      scope_id: null,
      project_id: null,
      result: "deny",
    });
  });

  it("should store a decision about an unknown project at system scope", async () => {
    const unknown = newUlid();
    await adapter.recordDecision(
      decision({
        projectId: unknown,
        scopeType: "project",
        scopeId: unknown,
        objectType: "project",
        objectId: unknown,
      }),
    );

    const rows = await testDb.db.executeQuery<{
      scope_type: string;
      scope_id: string | null;
      project_id: string | null;
      object_id: string | null;
    }>("SELECT scope_type, scope_id, project_id, object_id FROM audit_events");
    expect(rows.records[0]).toEqual({
      scope_type: "system",
      scope_id: null,
      project_id: null,
      object_id: unknown,
    });
  });

  it("should store the owning project on an object-scoped mutation", async () => {
    const event = mutation();
    await adapter.recordMutation(event);

    const rows = await testDb.db.executeQuery<{
      project_id: string | null;
      object_type: string | null;
      object_id: string | null;
    }>("SELECT project_id, object_type, object_id FROM audit_events");
    expect(rows.records[0]).toEqual({
      project_id: base.projectId,
      object_type: "assignment",
      object_id: event.assignmentId,
    });
  });

  it("should normalize an IPv6 source address and hash the canonical form", async () => {
    const record = await writer.record(input({ sourceIp: "2001:0db8::1" }));
    expect(record.sourceIp).toBe("2001:db8::1");

    const rows = await testDb.db.executeQuery<{ source_ip: string }>(
      "SELECT host(source_ip) AS source_ip FROM audit_events WHERE event_id = :eventId",
      { eventId: record.eventId },
    );
    expect(rows.records[0]?.source_ip).toBe("2001:db8::1");

    const key = await loadAuditKey(testDb.db, record.auditKeyId);
    const canonical = canonicalJson(
      canonicalEventForHash(record, record.prevHash, record.auditKeyId),
    );
    expect(computeEventHash(canonical, record.prevHash).toString("hex")).toBe(
      record.hash.toString("hex"),
    );
    expect(key).toBeDefined();
  });
});

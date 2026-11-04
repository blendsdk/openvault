import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditVerifier } from "../../src/audit/audit-verify.js";
import { AuditAccessDeniedError } from "../../src/audit/errors.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditActors,
  type AuditHarness,
  createAuditHarness,
  recordEvent,
  resetAuditTables,
  seedAuditActors,
} from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let harness: AuditHarness;
let actors: AuditActors;
let currentTime = Date.parse("2026-06-01T00:00:00.000Z");

const clock = (): number => currentTime;

async function withTriggerDisabled(
  table: "audit_events" | "audit_checkpoints",
  trigger: string,
  action: () => Promise<void>,
): Promise<void> {
  await testDb.db.executeQuery(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await action();
  } finally {
    await testDb.db.executeQuery(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

async function eventRowId(eventId: string): Promise<string> {
  const rows = await testDb.db.executeQuery<{ id: string }>(
    "SELECT id FROM audit_events WHERE event_id = :eventId",
    { eventId },
  );
  const id = rows.records[0]?.id;
  if (id === undefined) {
    throw new Error("event not found");
  }
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  harness = createAuditHarness(testDb, keyring, clock);
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-06-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("audit chain verification", () => {
  it("should verify a clean chain and cover the full range", async () => {
    const records = [];
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      records.push(await recordEvent(harness, base));
    }
    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-1" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.checkedRange?.fromEventId).toBe(records[0]?.eventId);
    const beforeVerify = await testDb.db.executeQuery<{ event_id: string }>(
      "SELECT event_id FROM audit_events WHERE action <> 'audit.verify' ORDER BY id DESC LIMIT 1",
    );
    expect(result.checkedRange?.toEventId).toBe(beforeVerify.records[0]?.event_id);
    expect(result.firstBrokenEventId).toBeNull();
  });

  it("should detect an edited first retained event even when its checkpoint exists", async () => {
    const first = await recordEvent(harness, base);
    currentTime += 1_000;
    await recordEvent(harness, base);
    const id = await eventRowId(first.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_update", async () => {
      await testDb.db.executeQuery("UPDATE audit_events SET result = 'deny' WHERE id = :id", {
        id,
      });
    });

    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-2" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
    expect(result.firstBrokenEventId).toBe(first.eventId);
    const verifyRows = await testDb.db.executeQuery<{ result: string }>(
      "SELECT result FROM audit_events WHERE action = 'audit.verify'",
    );
    expect(verifyRows.records[0]?.result).toBe("error");
  });

  it("should detect an edited details value and an edited hash", async () => {
    const first = await recordEvent(harness, base);
    const id = await eventRowId(first.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_update", async () => {
      await testDb.db.executeQuery(
        `UPDATE audit_events SET details = '{"reason":"changed"}'::jsonb WHERE id = :id`,
        { id },
      );
    });
    let result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-3" });
    expect(result.reason).toBe("hash_mismatch");
    expect(result.firstBrokenEventId).toBe(first.eventId);

    await resetAuditTables(testDb.db);
    const second = await recordEvent(harness, base);
    const secondId = await eventRowId(second.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_update", async () => {
      await testDb.db.executeQuery("UPDATE audit_events SET hash = :hash WHERE id = :id", {
        id: secondId,
        hash: Buffer.alloc(32, 7),
      });
    });
    result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-4" });
    expect(result.reason).toBe("hash_mismatch");
    expect(result.firstBrokenEventId).toBe(second.eventId);
  });

  it("should detect a deleted middle event at the next retained row", async () => {
    const first = await recordEvent(harness, base);
    currentTime += 1_000;
    const middle = await recordEvent(harness, base);
    currentTime += 1_000;
    const last = await recordEvent(harness, base);
    const middleId = await eventRowId(middle.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_delete", async () => {
      await testDb.db.executeQuery("DELETE FROM audit_events WHERE id = :id", { id: middleId });
    });

    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-5" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("prev_hash_mismatch");
    expect(result.firstBrokenEventId).toBe(last.eventId);
    expect(result.checkedRange?.fromEventId).toBe(first.eventId);
  });

  it("should detect a deleted tail even when a newer checkpoint exists", async () => {
    const records = [];
    for (let index = 0; index < 1_001; index += 1) {
      currentTime += 1_000;
      records.push(await recordEvent(harness, base));
    }
    const last = records[1_000];
    if (last === undefined) {
      throw new Error("missing tail event");
    }
    const lastId = await eventRowId(last.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_delete", async () => {
      await testDb.db.executeQuery("DELETE FROM audit_events WHERE id = :id", { id: lastId });
    });
    currentTime += 1_000;
    const replacement = await recordEvent(harness, base);
    await harness.writer.checkpointAt(replacement);

    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-6" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tail_truncated");
    expect(result.firstBrokenEventId).toBeNull();
  }, 180_000);

  it("should report a missing anchor when the genesis event and checkpoints are gone", async () => {
    const first = await recordEvent(harness, base);
    currentTime += 1_000;
    await recordEvent(harness, base);
    const firstId = await eventRowId(first.eventId);
    await withTriggerDisabled("audit_events", "audit_events_no_delete", async () => {
      await testDb.db.executeQuery("DELETE FROM audit_events WHERE id = :id", { id: firstId });
    });
    await withTriggerDisabled("audit_checkpoints", "audit_checkpoints_no_truncate", async () => {
      await testDb.db.executeQuery("TRUNCATE audit_checkpoints");
    });

    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-7" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_checkpoint");
    expect(result.firstBrokenEventId).not.toBeNull();
  });

  it("should verify an empty chain with no checkpoints", async () => {
    const result = await harness.verifier.verify();
    expect(result).toEqual({
      ok: true,
      checkedRange: null,
      firstBrokenEventId: null,
      reason: "empty_chain",
    });
  });

  it("should deny verification to a project auditor and allow an org auditor", async () => {
    await expect(
      harness.service.verify(actors.projectAuditor, { requestId: "verify-9" }),
    ).rejects.toBeInstanceOf(AuditAccessDeniedError);

    await recordEvent(harness, base);
    const result = await harness.service.verify(actors.orgAdmin, { requestId: "verify-10" });
    expect(result.ok).toBe(true);

    const rows = await testDb.db.executeQuery<{ action: string; result: string }>(
      "SELECT action, result FROM audit_events WHERE action IN ('audit.read', 'audit.verify')",
    );
    expect(
      rows.records.filter((row) => row.action === "audit.read" && row.result === "allow"),
    ).toHaveLength(1);
    expect(rows.records.filter((row) => row.action === "audit.verify")).toHaveLength(1);
  });

  it("should report an unavailable key", async () => {
    await recordEvent(harness, base);
    const directory = mkdtempSync(join(tmpdir(), "openvault-audit-verify-"));
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
    const replacement = await KeyringProvider.load(path);
    try {
      const verifier = new AuditVerifier({ database: testDb.db, keyring: replacement });
      const result = await verifier.verify();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("key_unavailable");
    } finally {
      replacement.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should report an empty table with a surviving checkpoint as tail truncation", async () => {
    await recordEvent(harness, base);
    await withTriggerDisabled("audit_events", "audit_events_no_truncate", async () => {
      await testDb.db.executeQuery("TRUNCATE audit_events");
    });
    const result = await harness.verifier.verify();
    expect(result).toEqual({
      ok: false,
      checkedRange: null,
      firstBrokenEventId: null,
      reason: "tail_truncated",
    });
  });
});

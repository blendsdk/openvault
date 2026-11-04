import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditHarness,
  createAuditHarness,
  recordEvent,
  resetAuditTables,
} from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let harness: AuditHarness;
let currentTime = Date.parse("2026-09-01T00:00:00.000Z");

const clock = (): number => currentTime;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
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
  currentTime = Date.parse("2026-09-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("audit verification internals", () => {
  it("should verify across the 1,000-row batch boundary", async () => {
    const records = [];
    for (let index = 0; index < 1_001; index += 1) {
      currentTime += 1_000;
      records.push(await recordEvent(harness, base));
    }
    const result = await harness.verifier.verify();
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.checkedRange?.fromEventId).toBe(records[0]?.eventId);
    expect(result.checkedRange?.toEventId).toBe(records[1_000]?.eventId);
  }, 180_000);

  it("should report a tampered event in the second batch", async () => {
    const records = [];
    for (let index = 0; index < 1_001; index += 1) {
      currentTime += 1_000;
      records.push(await recordEvent(harness, base));
    }
    const target = records[1_000];
    if (target === undefined) {
      throw new Error("missing event");
    }
    const id = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM audit_events WHERE event_id = :eventId",
      { eventId: target.eventId },
    );
    await testDb.db.executeQuery("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update");
    try {
      await testDb.db.executeQuery("UPDATE audit_events SET result = 'deny' WHERE id = :id", {
        id: id.records[0]?.id,
      });
    } finally {
      await testDb.db.executeQuery(
        "ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update",
      );
    }
    const result = await harness.verifier.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
    expect(result.firstBrokenEventId).toBe(target.eventId);
  }, 180_000);

  it("should report a chain with no retained rows and no checkpoints as empty", async () => {
    const result = await harness.verifier.verify();
    expect(result.reason).toBe("empty_chain");
  });
});

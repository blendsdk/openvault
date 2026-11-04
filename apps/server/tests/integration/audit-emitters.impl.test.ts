import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditActors,
  type AuditHarness,
  createAuditHarness,
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

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  harness = createAuditHarness(testDb, keyring, () => Date.now());
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

describe("policy emitter internals", () => {
  it("should skip evidence for a non-auditing visibility check", async () => {
    await harness.policy.hasAny(actors.orgAdmin, "identity.read", undefined, { audit: false });
    expect((await testDb.db.executeQuery("SELECT 1 FROM audit_events")).records).toHaveLength(0);
  });

  it("should record exactly one event for an audited check", async () => {
    await harness.policy.hasAny(actors.orgAdmin, "identity.read");
    const rows = await testDb.db.executeQuery<{ action: string }>(
      "SELECT action FROM audit_events",
    );
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]?.action).toBe("identity.read");
  });
});

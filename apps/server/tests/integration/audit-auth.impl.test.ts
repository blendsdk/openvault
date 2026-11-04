import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditRequestContext, recordLocalLoginFailure } from "../../src/audit/http.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditHarness,
  createAuditHarness,
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

const context = { requestId: "auth-impl", sourceIp: "203.0.113.5", userAgent: "vitest" };

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
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

describe("authentication emitter internals", () => {
  it("should write only a login deny when the failure did not lock the account", async () => {
    await recordLocalLoginFailure(
      harness.service,
      { ok: false, reason: "unknown_credentials" },
      context,
      "browser",
    );
    const rows = await testDb.db.executeQuery<{
      action: string;
      actor_kind: string;
      details: Record<string, unknown>;
    }>("SELECT action, actor_kind, details FROM audit_events ORDER BY id ASC");
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]).toMatchObject({
      action: "auth.login",
      actor_kind: "system",
      details: { method: "local", client: "browser", reason: "unknown_credentials" },
    });
  });

  it("should write a login deny and one lockout when the failure created a lock", async () => {
    await recordLocalLoginFailure(
      harness.service,
      {
        ok: false,
        reason: "invalid_credentials",
        principalId: base.userId,
        lockedUntil: new Date(Date.now() + 900_000),
      },
      context,
      "cli",
    );
    const rows = await testDb.db.executeQuery<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM audit_events ORDER BY id ASC",
    );
    expect(rows.records.map((row) => row.action)).toEqual(["auth.login", "auth.lockout"]);
    expect(rows.records[1]?.details).toMatchObject({ lockSeconds: 900, client: "cli" });
  });

  it("should read request metadata without dropping the request id", () => {
    const request = {
      id: "request-1",
      ip: "203.0.113.9",
      headers: { "user-agent": "vitest-agent" },
    };
    expect(auditRequestContext(request)).toEqual({
      requestId: "request-1",
      sourceIp: "203.0.113.9",
      userAgent: "vitest-agent",
    });
  });
});

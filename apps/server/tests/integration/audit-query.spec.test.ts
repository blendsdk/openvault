import { type AuditQuery, auditQuerySchema } from "@openvault/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditAccessDeniedError, AuditQueryError } from "../../src/audit/errors.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditActors,
  type AuditHarness,
  auditDraft,
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
let currentTime = Date.parse("2026-05-01T00:00:00.000Z");

const clock = (): number => currentTime;

/** Parses a query so the contract defaults and checks apply. */
function query(filters: Record<string, unknown>): AuditQuery {
  return auditQuerySchema.parse(filters);
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
  currentTime = Date.parse("2026-05-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("audit event query", () => {
  it("should return events in descending order with no cursor when the page is short", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const page = await harness.service.query(actors.orgAdmin, query({ action: "project.read" }), {
      requestId: "query-1",
    });
    expect(page.events).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    const ids = page.events.map((event) => event.eventId);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("should return a signed cursor and continue with the remaining events", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const first = await harness.service.query(
      actors.orgAdmin,
      query({ action: "project.read", limit: 2 }),
      { requestId: "query-2" },
    );
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await harness.service.query(
      actors.orgAdmin,
      query({ action: "project.read", limit: 2, cursor: first.nextCursor }),
      { requestId: "query-3" },
    );
    expect(second.events).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.events[0]?.eventId).not.toBe(first.events[0]?.eventId);
  });

  it("should filter by result, action, time, and object identity", async () => {
    currentTime += 1_000;
    const allow = await recordEvent(harness, base);
    currentTime += 1_000;
    const deny = await recordEvent(harness, base, {
      result: "deny",
      details: { reason: "no_assignment" },
    });
    currentTime += 1_000;
    const other = await recordEvent(harness, base, {
      action: "identity.create",
      objectType: "identity",
      objectId: base.serviceId,
    });

    const denied = await harness.service.query(
      actors.orgAdmin,
      query({ action: "project.read", result: "deny" }),
      { requestId: "query-4" },
    );
    expect(denied.events.map((event) => event.eventId)).toEqual([deny.eventId]);

    const identity = await harness.service.query(
      actors.orgAdmin,
      query({ action: "identity.create" }),
      { requestId: "query-5" },
    );
    expect(identity.events.map((event) => event.eventId)).toEqual([other.eventId]);

    const byTime = await harness.service.query(
      actors.orgAdmin,
      query({
        action: "project.read",
        from: allow.ts.toISOString(),
        to: allow.ts.toISOString(),
      }),
      { requestId: "query-6" },
    );
    expect(byTime.events.map((event) => event.eventId)).toEqual([allow.eventId]);

    const combined = await harness.service.query(
      actors.orgAdmin,
      query({
        action: "project.read",
        actorId: base.userId,
        objectType: "project",
        objectId: base.projectId,
      }),
      { requestId: "query-7" },
    );
    expect(combined.events.map((event) => event.eventId).sort()).toEqual(
      [allow.eventId, deny.eventId].sort(),
    );
  });

  it("should reject a cursor bound to different filters", async () => {
    for (let index = 0; index < 2; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const first = await harness.service.query(
      actors.orgAdmin,
      query({ action: "project.read", limit: 1 }),
      { requestId: "query-8" },
    );
    expect(first.nextCursor).not.toBeNull();
    await expect(
      harness.service.query(
        actors.orgAdmin,
        query({ action: "identity.create", limit: 1, cursor: first.nextCursor }),
        { requestId: "query-9" },
      ),
    ).rejects.toBeInstanceOf(AuditQueryError);
  });

  it("should reject a tampered cursor", async () => {
    currentTime += 1_000;
    await recordEvent(harness, base);
    const first = await harness.service.query(
      actors.orgAdmin,
      query({ action: "project.read", limit: 1 }),
      { requestId: "query-10" },
    );
    const cursor = first.nextCursor ?? "";
    const tampered = `${cursor.slice(0, 5)}${cursor[5] === "A" ? "B" : "A"}${cursor.slice(6)}`;
    await expect(
      harness.service.query(
        actors.orgAdmin,
        query({ action: "project.read", limit: 1, cursor: tampered }),
        { requestId: "query-11" },
      ),
    ).rejects.toBeInstanceOf(AuditQueryError);
  });

  it("should reject invalid limits and an object id without its type", () => {
    expect(auditQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ objectId: base.projectId }).success).toBe(false);
  });

  it("should restrict a project auditor to granted projects", async () => {
    currentTime += 1_000;
    const own = await recordEvent(harness, base);
    currentTime += 1_000;
    await recordEvent(
      harness,
      base,
      auditDraft(base, {
        projectId: actors.projectB,
        scopeType: "project",
        scopeId: actors.projectB,
        objectId: actors.projectB,
      }),
    );
    currentTime += 1_000;
    await recordEvent(
      harness,
      base,
      auditDraft(base, {
        projectId: null,
        scopeType: "system",
        scopeId: null,
        objectType: null,
        objectId: null,
      }),
    );

    const page = await harness.service.query(
      actors.projectAuditor,
      query({ action: "project.read" }),
      { requestId: "query-12" },
    );
    expect(page.events.map((event) => event.eventId)).toEqual([own.eventId]);
    expect(page.events.every((event) => event.projectId === base.projectId)).toBe(true);
  });

  it("should deny a project auditor outside the grant", async () => {
    await expect(
      harness.service.query(actors.projectAuditor, query({ projectId: actors.projectB }), {
        requestId: "query-13",
      }),
    ).rejects.toBeInstanceOf(AuditAccessDeniedError);
  });

  it("should deny a caller without audit.read", async () => {
    await expect(
      harness.service.query(actors.noAccess, query({ action: "project.read" }), {
        requestId: "query-14",
      }),
    ).rejects.toBeInstanceOf(AuditAccessDeniedError);
  });
});

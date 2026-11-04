import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEventQuery } from "../../src/audit/audit-query.js";
import { AuditKeyUnavailableError, AuditQueryError } from "../../src/audit/errors.js";
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
let currentTime = Date.parse("2026-08-01T00:00:00.000Z");

const clock = (): number => currentTime;

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
  currentTime = Date.parse("2026-08-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("audit query internals", () => {
  it("should return an empty page when nothing matches", async () => {
    const page = await harness.service.query(
      actors.orgAdmin,
      { action: "identity.create", limit: 100 },
      { requestId: "impl-query-1" },
    );
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("should keep a cursor valid when only the page size changes", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const first = await harness.service.query(
      actors.orgAdmin,
      { action: "project.read", limit: 1 },
      { requestId: "impl-query-2" },
    );
    const second = await harness.service.query(
      actors.orgAdmin,
      { action: "project.read", limit: 2, cursor: first.nextCursor ?? undefined },
      { requestId: "impl-query-3" },
    );
    expect(second.events).toHaveLength(2);
  });

  it("should reject a cursor after visibility changes", async () => {
    currentTime += 1_000;
    await recordEvent(harness, base);
    const first = await harness.service.query(
      actors.orgAdmin,
      { action: "project.read", limit: 1 },
      { requestId: "impl-query-4" },
    );
    await expect(
      harness.service.query(
        actors.projectAuditor,
        { action: "project.read", limit: 1, cursor: first.nextCursor ?? undefined },
        { requestId: "impl-query-5" },
      ),
    ).rejects.toBeInstanceOf(AuditQueryError);
  });

  it("should reject a cursor signed by an unavailable key", async () => {
    for (let index = 0; index < 2; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const first = await harness.service.query(
      actors.orgAdmin,
      { action: "project.read", limit: 1 },
      { requestId: "impl-query-key-1" },
    );
    const cursor = first.nextCursor;
    if (cursor === null) {
      throw new Error("cursor missing");
    }
    const directory = mkdtempSync(join(tmpdir(), "openvault-audit-cursor-"));
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
      const query = new AuditEventQuery({ database: testDb.db, keyring: replacement });
      await expect(
        query.page({ action: "project.read", limit: 1, cursor }, { kind: "all" }),
      ).rejects.toBeInstanceOf(AuditKeyUnavailableError);
    } finally {
      replacement.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should allow a project filter inside the caller grant", async () => {
    currentTime += 1_000;
    const record = await recordEvent(harness, base);
    const page = await harness.service.query(
      actors.projectAuditor,
      { projectId: base.projectId, action: "project.read", limit: 100 },
      { requestId: "impl-query-6" },
    );
    expect(page.events.map((event) => event.eventId)).toEqual([record.eventId]);
  });
});

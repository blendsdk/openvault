import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditExportQuery,
  auditEventSchema,
  auditExportQuerySchema,
} from "@openvault/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditExporter } from "../../src/audit/audit-export.js";
import { AuditEventQuery } from "../../src/audit/audit-query.js";
import { AuditService } from "../../src/audit/audit-service.js";
import { AuditVerifier } from "../../src/audit/audit-verify.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
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
let currentTime = Date.parse("2026-07-01T00:00:00.000Z");

const clock = (): number => currentTime;

function exportFilters(value: Record<string, unknown> = {}): AuditExportQuery {
  return auditExportQuerySchema.parse(value);
}

async function collectExport(
  filters: AuditExportQuery,
): Promise<{ readonly lines: string[]; readonly started: boolean }> {
  const lines: string[] = [];
  let started = false;
  await harness.service.export(
    actors.orgAdmin,
    filters,
    { requestId: "export-1" },
    () => {
      started = true;
    },
    async (line) => {
      lines.push(line);
    },
  );
  return { lines, started };
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
  currentTime = Date.parse("2026-07-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

describe("audit export", () => {
  it("should stream three valid NDJSON lines before the response starts", async () => {
    const records = [];
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      records.push(await recordEvent(harness, base));
    }
    const { lines, started } = await collectExport(exportFilters({ action: "project.read" }));
    expect(started).toBe(true);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => auditEventSchema.parse(JSON.parse(line)));
    expect(parsed.map((event) => event.eventId)).toEqual(records.map((record) => record.eventId));
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
  });

  it("should export the same rows as the list query in ascending order", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const list = await harness.service.query(
      actors.orgAdmin,
      {
        action: "project.read",
        limit: 100,
      },
      { requestId: "export-2" },
    );
    const { lines } = await collectExport(exportFilters({ action: "project.read" }));
    const exported = lines.map((line) => auditEventSchema.parse(JSON.parse(line)).eventId);
    expect(exported).toEqual(list.events.map((event) => event.eventId).reverse());
  });

  it("should record exactly one export attempt event with the normalized filters", async () => {
    currentTime += 1_000;
    await recordEvent(harness, base);
    await collectExport(exportFilters({ action: "project.read" }));

    const rows = await testDb.db.executeQuery<{
      details: { format: string; filters: Record<string, string> };
    }>("SELECT details FROM audit_events WHERE action = 'audit.export'");
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]?.details).toEqual({
      format: "ndjson",
      filters: { action: "project.read" },
    });
  });

  it("should fail before headers when the export attempt cannot be written", async () => {
    currentTime += 1_000;
    await recordEvent(harness, base);
    const directory = mkdtempSync(join(tmpdir(), "openvault-audit-export-"));
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
      const writer = new AuditWriter({ database: testDb.db, keyring: replacement, now: clock });
      const adapter = new PersistentPolicyAudit({
        writer,
        database: testDb.db,
        now: clock,
      });
      const repository = new PolicyRepository(testDb.db);
      const policy = new PolicyService({ repository, audit: adapter });
      const service = new AuditService({
        writer,
        query: new AuditEventQuery({ database: testDb.db, keyring: replacement }),
        verifier: new AuditVerifier({ database: testDb.db, keyring: replacement }),
        exporter: new AuditExporter({ database: testDb.db, keyring: replacement }),
        policy,
        now: clock,
      });
      let started = false;
      await expect(
        service.export(
          actors.orgAdmin,
          exportFilters({ action: "project.read" }),
          { requestId: "export-3" },
          () => {
            started = true;
          },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(PolicyUnavailableError);
      expect(started).toBe(false);
    } finally {
      replacement.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should stream 600 events in batches", async () => {
    for (let index = 0; index < 600; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const { lines } = await collectExport(exportFilters({ action: "project.read" }));
    expect(lines).toHaveLength(600);
  }, 180_000);
});

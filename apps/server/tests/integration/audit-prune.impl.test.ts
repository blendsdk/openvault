import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditPruner } from "../../src/audit/audit-prune.js";
import { AuditEventQuery } from "../../src/audit/audit-query.js";
import { AuditVerifier } from "../../src/audit/audit-verify.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { AuditPruneConfigError } from "../../src/audit/errors.js";
import { createPruneAuthorization } from "../../src/audit/prune-authorization.js";
import { createPruneConnection, type PruneConnection } from "../../src/audit/prune-connection.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { auditDraft, resetAuditTables } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { ensurePrunerRole } from "./helpers/pruner.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const DAY_MS = 86_400_000;
const now = Date.parse("2026-11-04T12:00:00.000Z");

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let writer: AuditWriter;
let query: AuditEventQuery;
let verifier: AuditVerifier;
let prune: PruneConnection | undefined;
let directory: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  writer = new AuditWriter({ database: testDb.db, keyring, now: () => now });
  query = new AuditEventQuery({ database: testDb.db, keyring });
  verifier = new AuditVerifier({ database: testDb.db, keyring });
  const pruneUrl = await ensurePrunerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  prune = pruneUrl === undefined ? undefined : await createPruneConnection(pruneUrl);
  directory = mkdtempSync(join(tmpdir(), "openvault-prune-impl-"));
}, 60_000);

afterAll(async () => {
  await prune?.close();
  keyring.destroy();
  environment.cleanup();
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

function pruner(): AuditPruner {
  return new AuditPruner({
    database: testDb.db,
    writer,
    query,
    verifier,
    databaseName: testDb.name,
    authorizePrune: (input) => createPruneAuthorization(testDb.db, input),
    deletePrefix: (authorizationId) => {
      if (prune === undefined) {
        throw new Error("pruner is unavailable");
      }
      return prune.deletePrefix(authorizationId);
    },
    retentionDays: 180,
    now: () => now,
  });
}

describe("prune implementation", () => {
  it("should reject the application role as the prune session", async () => {
    await expect(createPruneConnection(process.env.TEST_DATABASE_URL)).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
  });

  it("should leave no file when the output directory does not exist", async () => {
    await writer.record({
      ...auditDraft(base),
      eventId: newUlid(),
      ts: new Date(now - 200 * DAY_MS),
    });
    const output = join(directory, "missing", "prefix.ndjson");
    await expect(pruner().prune({ outputPath: output })).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
    expect(existsSync(output)).toBe(false);
  });

  it("should not create an output file when there is nothing to prune", async () => {
    await writer.record({
      ...auditDraft(base),
      eventId: newUlid(),
      ts: new Date(now - DAY_MS),
    });
    const output = join(directory, "noop.ndjson");
    await pruner().prune({ outputPath: output });
    expect(existsSync(output)).toBe(false);
  });
});

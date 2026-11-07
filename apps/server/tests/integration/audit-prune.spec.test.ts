import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@openvault/core";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditPruner } from "../../src/audit/audit-prune.js";
import { AuditEventQuery } from "../../src/audit/audit-query.js";
import { AuditVerifier } from "../../src/audit/audit-verify.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { exportLatestCheckpoint } from "../../src/audit/checkpoint-cli.js";
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
let pruneUrl: string | undefined;
let directory: string;

function oldDate(days: number): Date {
  return new Date(now - days * DAY_MS);
}

async function recordAt(date: Date): Promise<void> {
  await writer.record({ ...auditDraft(base), eventId: newUlid(), ts: date });
}

function pruner(): AuditPruner {
  if (prune === undefined) {
    throw new Error("pruner is unavailable");
  }
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

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  writer = new AuditWriter({ database: testDb.db, keyring, now: () => now });
  query = new AuditEventQuery({ database: testDb.db, keyring });
  verifier = new AuditVerifier({ database: testDb.db, keyring });
  pruneUrl = await ensurePrunerRole(process.env.TEST_DATABASE_URL ?? "", testDb.name);
  prune = pruneUrl === undefined ? undefined : await createPruneConnection(pruneUrl);
  directory = mkdtempSync(join(tmpdir(), "openvault-prune-"));
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

describe("audit prune", () => {
  it("should export, checkpoint, delete the prefix, and leave a verifiable suffix", async () => {
    await recordAt(oldDate(200));
    await recordAt(oldDate(190));
    await recordAt(oldDate(1));
    const output = join(directory, "prefix.ndjson");
    const result = await pruner().prune({ outputPath: output });
    expect(result.exportedCount).toBe(2);
    expect(result.deletedCount).toBe(2);
    expect(result.checkpointId).not.toBeNull();
    expect(result.authorizationId).not.toBeNull();
    expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(2);
    const exportDigest = createHash("sha256").update(readFileSync(output)).digest("hex");
    expect(result.exportSha256).toBe(exportDigest);
    const retained = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events",
    );
    expect(retained.records[0]?.count).toBe(2);
    await expect(verifier.verify()).resolves.toMatchObject({ ok: true });
    const receipt = await testDb.db.executeQuery<{
      readonly authorization_id: string;
      readonly deleted_count: number;
      readonly export_sha256: Buffer;
      readonly last_event_id: string;
    }>(
      "SELECT authorization_id, deleted_count, export_sha256, last_event_id FROM audit_prune_receipts",
    );
    expect(receipt.records).toHaveLength(1);
    expect(receipt.records[0]?.authorization_id).toBe(result.authorizationId);
    expect(receipt.records[0]?.deleted_count).toBe(2);
    expect(receipt.records[0]?.export_sha256.toString("hex")).toBe(exportDigest);
    const pruneEvent = await testDb.db.executeQuery<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_events WHERE action = 'audit.prune'",
    );
    expect(pruneEvent.records[0]?.details).toMatchObject({
      exportedCount: 2,
      deletedCount: 2,
      authorizationId: result.authorizationId,
      exportSha256: exportDigest,
      dryRun: false,
    });
  });

  it("should export and checkpoint without deleting in dry-run mode", async () => {
    await recordAt(oldDate(200));
    await recordAt(oldDate(1));
    const output = join(directory, "dry-run.ndjson");
    const result = await pruner().prune({ outputPath: output, dryRun: true });
    expect(result.deletedCount).toBe(0);
    expect(result.exportedCount).toBe(1);
    expect(result.authorizationId).toBeNull();
    expect(result.exportSha256).toBe(
      createHash("sha256").update(readFileSync(output)).digest("hex"),
    );
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events",
    );
    expect(rows.records[0]?.count).toBe(3);
    const pruneEvent = await testDb.db.executeQuery<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_events WHERE action = 'audit.prune'",
    );
    expect(pruneEvent.records[0]?.details).toMatchObject({ dryRun: true, deletedCount: 0 });
  });

  it("should record a zero-count prune when nothing is old enough", async () => {
    await recordAt(oldDate(1));
    const output = join(directory, "noop.ndjson");
    const result = await pruner().prune({ outputPath: output });
    expect(result).toEqual({
      cutoff: new Date(now - 180 * DAY_MS),
      exportedCount: 0,
      deletedCount: 0,
      checkpointId: null,
      authorizationId: null,
      exportSha256: null,
      dryRun: false,
    });
    const pruneEvent = await testDb.db.executeQuery<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_events WHERE action = 'audit.prune'",
    );
    expect(pruneEvent.records[0]?.details).toMatchObject({ exportedCount: 0, deletedCount: 0 });
  });

  it("should reject a relative or existing output path", async () => {
    await expect(pruner().prune({ outputPath: "relative.ndjson" })).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
    const existing = join(directory, "existing.ndjson");
    writeFileSync(existing, "keep", { mode: 0o600 });
    await expect(pruner().prune({ outputPath: existing })).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
    expect(readFileSync(existing, "utf8")).toBe("keep");
  });

  it("should deny direct pruner table authority", async () => {
    if (pruneUrl === undefined) {
      return;
    }
    const client = new Client({ connectionString: pruneUrl });
    await client.connect();
    try {
      await expect(client.query("SELECT count(*) FROM audit_events")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(client.query("DELETE FROM audit_events WHERE false")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        client.query(
          `INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id)
           VALUES (1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'x')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });

  it("should reject an absent or expired authorization without deleting", async () => {
    if (prune === undefined) {
      return;
    }
    await expect(prune.deletePrefix(newUlid())).rejects.toBeInstanceOf(AuditPruneConfigError);

    await recordAt(oldDate(200));
    const boundary = await testDb.db.executeQuery<{ readonly id: string; readonly hash: Buffer }>(
      "SELECT id, hash FROM audit_events ORDER BY id LIMIT 1",
    );
    const row = boundary.records[0];
    if (row === undefined) {
      throw new Error("expected an audit event");
    }
    const authorizationId = await createPruneAuthorization(testDb.db, {
      database: testDb.name,
      lastEventId: row.id,
      lastHash: row.hash,
      count: 1,
      exportSha256: createHash("sha256").update("export").digest(),
      cutoff: new Date(now),
    });
    await testDb.db.executeQuery(
      "UPDATE audit_prune_authorizations SET expires_at = now() - interval '1 minute' WHERE id = :id",
      { id: authorizationId },
    );
    await expect(prune.deletePrefix(authorizationId)).rejects.toBeInstanceOf(AuditPruneConfigError);
    const count = await testDb.db.executeQuery<{ readonly count: number }>(
      "SELECT count(*)::int AS count FROM audit_events",
    );
    expect(count.records[0]?.count).toBe(1);
  });

  it("should reject a replayed authorization", async () => {
    if (prune === undefined) {
      return;
    }
    await recordAt(oldDate(200));
    const result = await pruner().prune({ outputPath: join(directory, "replay.ndjson") });
    expect(result.authorizationId).not.toBeNull();
    await expect(prune.deletePrefix(result.authorizationId ?? "")).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
  });

  it("should require the pruner role and permit its delete", async () => {
    await expect(createPruneConnection(undefined)).rejects.toBeInstanceOf(AuditPruneConfigError);
    await recordAt(oldDate(200));
    const row = await testDb.db.executeQuery<{ id: string }>("SELECT id FROM audit_events LIMIT 1");
    await expect(
      testDb.db.executeQuery("DELETE FROM audit_events WHERE id = :id", {
        id: row.records[0]?.id,
      }),
    ).rejects.toThrow(/append-only/i);
    const output = join(directory, "role.ndjson");
    const result = await pruner().prune({ outputPath: output });
    expect(result.deletedCount).toBe(1);
  });

  it("should export the newest checkpoint as a mode-0600 JSON file", async () => {
    await recordAt(oldDate(1));
    const output = join(directory, "checkpoint.json");
    const exported = await exportLatestCheckpoint(testDb.db, output);
    expect(exported.lastEventId).toMatch(/^\d+$/);
    expect(exported.lastHash).toMatch(/^[0-9a-f]{64}$/);
    expect(exported.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      id: exported.id,
      lastEventId: exported.lastEventId,
    });
    await expect(exportLatestCheckpoint(testDb.db, output)).rejects.toBeInstanceOf(
      AuditPruneConfigError,
    );
  });

  it("should abort before export when a boundary checkpoint has a bad HMAC", async () => {
    await recordAt(oldDate(200));
    await recordAt(oldDate(190));
    await recordAt(oldDate(180));
    await recordAt(oldDate(1));
    const boundary = await testDb.db.executeQuery<{
      id: string;
      hash: Buffer;
      audit_key_id: string;
    }>(
      "SELECT id, hash, audit_key_id FROM audit_events WHERE ts < :cutoff ORDER BY id DESC LIMIT 1",
      { cutoff: new Date(now - 180 * DAY_MS) },
    );
    const row = boundary.records[0];
    if (row === undefined) {
      throw new Error("boundary missing");
    }
    await testDb.db.executeQuery(
      `INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id)
       VALUES (:id, :hash, :hmac, :keyId)`,
      { id: row.id, hash: row.hash, hmac: Buffer.alloc(32, 9), keyId: row.audit_key_id },
    );
    const output = join(directory, "bad-checkpoint.ndjson");
    await expect(pruner().prune({ outputPath: output })).rejects.toThrow(/verification/i);
    expect(existsSync(output)).toBe(false);
  });

  it("should abort before export when a prefix event was tampered", async () => {
    await recordAt(oldDate(200));
    await recordAt(oldDate(190));
    await recordAt(oldDate(1));
    const target = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM audit_events ORDER BY id ASC LIMIT 1",
    );
    await testDb.db.executeQuery("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update");
    try {
      await testDb.db.executeQuery("UPDATE audit_events SET result = 'deny' WHERE id = :id", {
        id: target.records[0]?.id,
      });
    } finally {
      await testDb.db.executeQuery(
        "ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update",
      );
    }
    const output = join(directory, "tampered.ndjson");
    await expect(pruner().prune({ outputPath: output })).rejects.toThrow(/verification/i);
    expect(existsSync(output)).toBe(false);
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events",
    );
    expect(rows.records[0]?.count).toBe(3);
  });

  it("should reject checkpoint export when no checkpoint exists", async () => {
    await expect(
      exportLatestCheckpoint(testDb.db, join(directory, "missing-checkpoint.json")),
    ).rejects.toBeInstanceOf(AuditPruneConfigError);
  });

  it("should keep the chain continuable after a full prune", async () => {
    await recordAt(oldDate(200));
    await recordAt(oldDate(190));
    const output = join(directory, "full.ndjson");
    const result = await pruner().prune({ outputPath: output });
    expect(result.deletedCount).toBe(2);
    await recordAt(oldDate(1));
    await expect(verifier.verify()).resolves.toMatchObject({ ok: true });
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events",
    );
    expect(rows.records[0]?.count).toBe(2);
  });
});

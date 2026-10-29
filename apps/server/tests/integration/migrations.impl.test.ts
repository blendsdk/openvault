import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import {
  createTestDatabase,
  migrationsDirectory,
  type TestDatabase,
} from "./helpers/test-database.js";

const temporaryDirectories: string[] = [];

function makeMigrationDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-impl-migrations-"));
  temporaryDirectories.push(directory);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, name), sql);
  }
  return directory;
}

async function tableExists(testDb: TestDatabase, table: string): Promise<boolean> {
  const result = await testDb.db.executeQuery<{ present: boolean }>(
    "SELECT to_regclass(:name) IS NOT NULL AS present",
    { name: `public.${table}` },
  );
  return result.records[0]?.present ?? false;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration implementation edges", () => {
  let testDb: TestDatabase;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("should report only new pending migrations in dry-run after an initial apply", async () => {
    const initial = makeMigrationDirectory({
      "0001_initial.sql": "CREATE TABLE initial_table (id int);",
    });
    await migrate(testDb.db, initial);
    writeFileSync(join(initial, "0002_next.sql"), "CREATE TABLE next_table (id int);");

    const result = await migrate(testDb.db, initial, { dryRun: true });

    expect(result.pending).toEqual(["0002_next.sql"]);
    expect(result.applied).toEqual([]);
    expect(await tableExists(testDb, "next_table")).toBe(false);
  });

  it("should return stable SHA-256 checksums for every file", async () => {
    const sql = "CREATE TABLE checksum_table (id int);";
    const directory = makeMigrationDirectory({ "0001_initial.sql": sql });
    const result = await migrate(testDb.db, directory, { dryRun: true });

    expect(result.checksums["0001_initial.sql"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.checksums["0001_initial.sql"]).toBe(
      createHash("sha256").update(sql).digest("hex"),
    );
  });

  it("should reject a missing migration directory before touching the database", async () => {
    const missing = join(tmpdir(), `openvault-missing-${Date.now()}`);
    await expect(migrate(testDb.db, missing)).rejects.toThrow();
    expect(await tableExists(testDb, "schema_migrations")).toBe(false);
  });

  it("should reject an invalid lock timeout before opening a transaction", async () => {
    await expect(migrate(testDb.db, migrationsDirectory, { lockTimeoutMs: 0 })).rejects.toThrow(
      /positive integer/i,
    );
  });
});

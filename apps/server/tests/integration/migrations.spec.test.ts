import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import {
  createTestDatabase,
  migrationsDirectory,
  resolveTestDatabaseSettings,
  type TestDatabase,
  TestDatabaseGuardError,
} from "./helpers/test-database.js";

const temporaryDirectories: string[] = [];

function makeMigrationDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-migrations-"));
  temporaryDirectories.push(directory);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, name), sql);
  }
  return directory;
}

function singleMigration(name: string, sql: string): string {
  return makeMigrationDirectory({ [name]: sql });
}

async function tableExists(db: PostgreSQLDatabase, table: string): Promise<boolean> {
  const result = await db.executeQuery<{ present: boolean }>(
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

describe("test database guard", () => {
  it("should require the explicit opt-in flag", () => {
    expect(() =>
      resolveTestDatabaseSettings({ TEST_DATABASE_URL: "postgres://u:p@localhost/db_test" }),
    ).toThrow(TestDatabaseGuardError);
  });

  it("should require a test database URL", () => {
    expect(() => resolveTestDatabaseSettings({ OPENVAULT_TEST_DB: "1" })).toThrow(
      TestDatabaseGuardError,
    );
  });

  it("should reject a database name that does not end with _test", () => {
    expect(() =>
      resolveTestDatabaseSettings({
        OPENVAULT_TEST_DB: "1",
        TEST_DATABASE_URL: "postgres://u:p@localhost:5432/openvault",
      }),
    ).toThrow(TestDatabaseGuardError);
  });

  it("should reject a non-local host", () => {
    expect(() =>
      resolveTestDatabaseSettings({
        OPENVAULT_TEST_DB: "1",
        TEST_DATABASE_URL: "postgres://u:p@db.example.com:5432/openvault_test",
      }),
    ).toThrow(TestDatabaseGuardError);
  });

  it("should reject a non-postgres protocol", () => {
    expect(() =>
      resolveTestDatabaseSettings({
        OPENVAULT_TEST_DB: "1",
        TEST_DATABASE_URL: "mysql://u:p@localhost:5432/openvault_test",
      }),
    ).toThrow(TestDatabaseGuardError);
  });
});

describe("migration runner", () => {
  let testDb: TestDatabase;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("should apply the full migration set on the connected PostgreSQL version", async () => {
    const result = await migrate(testDb.db, migrationsDirectory);

    expect(result.applied).toHaveLength(8);
    expect(result.pending).toHaveLength(8);
    const tables = await testDb.db.executeQuery<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM information_schema.tables
        WHERE table_schema = 'public'`,
    );
    expect(tables.records[0]?.count).toBe(19);
  });

  it("should be a no-op when the same migrations run twice", async () => {
    await migrate(testDb.db, migrationsDirectory);
    const second = await migrate(testDb.db, migrationsDirectory);

    expect(second.applied).toEqual([]);
    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    expect(rows.records[0]?.count).toBe(8);
  });

  it("should reject a changed applied migration without changing the schema", async () => {
    const directory = singleMigration("0001_initial.sql", "CREATE TABLE first_table (id int);");
    await migrate(testDb.db, directory);
    appendFileSync(join(directory, "0001_initial.sql"), "\n-- changed\n");

    await expect(migrate(testDb.db, directory)).rejects.toThrow(/checksum mismatch/i);
    expect(await tableExists(testDb.db, "first_table")).toBe(true);
  });

  it("should reject a deleted applied migration", async () => {
    const directory = singleMigration("0001_initial.sql", "CREATE TABLE first_table (id int);");
    await migrate(testDb.db, directory);
    unlinkSync(join(directory, "0001_initial.sql"));

    await expect(migrate(testDb.db, directory)).rejects.toThrow(/applied migration missing/i);
  });

  it("should reject a new migration that sorts before the latest applied migration", async () => {
    const directory = singleMigration("0002_second.sql", "CREATE TABLE second_table (id int);");
    await migrate(testDb.db, directory);
    writeFileSync(join(directory, "0001_first.sql"), "CREATE TABLE first_table (id int);");

    await expect(migrate(testDb.db, directory)).rejects.toThrow(/sorts before/i);
    expect(await tableExists(testDb.db, "first_table")).toBe(false);
  });

  it("should reject an empty migration directory", async () => {
    const directory = makeMigrationDirectory({});
    await expect(migrate(testDb.db, directory)).rejects.toThrow(/no migrations/i);
  });

  it("should reject top-level transaction control but accept PL/pgSQL blocks", async () => {
    const controlDirectory = singleMigration(
      "0001_control.sql",
      "BEGIN; CREATE TABLE control_table (id int); COMMIT;",
    );
    await expect(migrate(testDb.db, controlDirectory)).rejects.toThrow(/transaction control/i);

    const triggerDirectory = singleMigration(
      "0001_trigger.sql",
      `CREATE TABLE trigger_table (id int);
       CREATE FUNCTION reject_trigger_table() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'trigger_table is read-only';
       END;
       $$;
       CREATE TRIGGER trigger_table_no_update BEFORE UPDATE ON trigger_table
         FOR EACH ROW EXECUTE FUNCTION reject_trigger_table();`,
    );
    await migrate(testDb.db, triggerDirectory);
    await testDb.db.executeQuery("INSERT INTO trigger_table (id) VALUES (1)");
    await expect(testDb.db.executeQuery("UPDATE trigger_table SET id = 2")).rejects.toThrow(
      /read-only/,
    );
  });

  it("should roll back the whole run when a later migration contains invalid SQL", async () => {
    const directory = makeMigrationDirectory({
      "0001_good.sql": "CREATE TABLE good_table (id int);",
      "0002_bad.sql": "CREATE TABLE bad_table (",
    });

    await expect(migrate(testDb.db, directory)).rejects.toThrow();
    expect(await tableExists(testDb.db, "good_table")).toBe(false);
    expect(await tableExists(testDb.db, "schema_migrations")).toBe(false);
  });

  it("should serialize two migrators using the advisory lock", async () => {
    const directory = singleMigration(
      "0001_concurrent.sql",
      "CREATE TABLE concurrent_table (id int);",
    );
    const settings = resolveTestDatabaseSettings();
    const second = new PostgreSQLDatabase({
      host: settings.host,
      port: settings.port,
      database: testDb.name,
      user: settings.user,
      pass: settings.password,
    });

    try {
      const [firstResult, secondResult] = await Promise.all([
        migrate(testDb.db, directory),
        migrate(second, directory),
      ]);
      expect(firstResult.applied.length + secondResult.applied.length).toBe(1);
      const rows = await testDb.db.executeQuery<{ count: number }>(
        "SELECT count(*)::int AS count FROM schema_migrations",
      );
      expect(rows.records[0]?.count).toBe(1);
    } finally {
      await second.disconnect();
    }
  });

  it("should fail quickly when another session holds the migration lock", async () => {
    const directory = singleMigration("0001_locked.sql", "CREATE TABLE locked_table (id int);");
    const holder = new Client({ connectionString: testDb.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('openvault_migrations'))");
      await expect(migrate(testDb.db, directory, { lockTimeoutMs: 200 })).rejects.toThrow(
        /lock timeout|canceling statement/i,
      );
      expect(await tableExists(testDb.db, "locked_table")).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("should list pending migrations in dry-run mode without creating tables", async () => {
    const directory = singleMigration("0001_dry.sql", "CREATE TABLE dry_table (id int);");
    const result = await migrate(testDb.db, directory, { dryRun: true });

    expect(result.pending).toEqual(["0001_dry.sql"]);
    expect(await tableExists(testDb.db, "dry_table")).toBe(false);
    expect(await tableExists(testDb.db, "schema_migrations")).toBe(false);
  });

  it("should refuse server startup when an applied migration is missing", async () => {
    await migrate(testDb.db, migrationsDirectory);
    await testDb.db.executeQuery(
      "INSERT INTO schema_migrations (id, checksum) VALUES ('9999_missing.sql', 'deadbeef')",
    );

    const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: serverRoot,
      encoding: "utf8",
      env: { ...process.env, OPENVAULT_DB_URL: testDb.url, PORT: "45999" },
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/applied migration missing|migration/i);
  }, 20_000);

  it("should create and drop only its own disposable database", async () => {
    const disposable = await createTestDatabase();
    const current = await disposable.db.executeQuery<{ name: string }>(
      "SELECT current_database() AS name",
    );
    expect(current.records[0]?.name).toBe(disposable.name);

    const url = disposable.url;
    await disposable.cleanup();

    const client = new Client({ connectionString: url });
    try {
      await expect(client.connect()).rejects.toThrow();
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});

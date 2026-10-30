import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMigrationStatus, runMigrations, validateMigrations } from "blendsdk/codegen";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerEnvironment } from "./helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  migrationConfigPath,
  resolveTestDatabaseSettings,
  type TestDatabase,
  TestDatabaseGuardError,
  withTestDatabaseUrl,
} from "./helpers/test-database.js";

async function tableExists(testDb: TestDatabase, table: string): Promise<boolean> {
  const result = await testDb.db.executeQuery<{ present: boolean }>(
    "SELECT to_regclass(:name) IS NOT NULL AS present",
    { name: `public.${table}` },
  );
  return result.records[0]?.present ?? false;
}

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

describe("codegen migration integration", () => {
  let testDb: TestDatabase;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("should apply the generated baseline and manual trigger migration", async () => {
    const result = await applyMigrations(testDb);

    expect(result.status).toBe("UP_TO_DATE");
    expect(result.migrations).toHaveLength(2);
    const tables = await testDb.db.executeQuery<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM information_schema.tables
        WHERE table_schema = 'public'`,
    );
    expect(tables.records[0]?.count).toBe(19);
    const ledger = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM blendsdk_migrations",
    );
    expect(ledger.records[0]?.count).toBe(2);
    const org = await testDb.db.executeQuery<{ id: number; name: string }>(
      "SELECT id, name FROM org",
    );
    expect(org.records).toEqual([{ id: 1, name: "OpenVault" }]);
  });

  it("should be a no-op when the migration history is applied twice", async () => {
    await applyMigrations(testDb);
    const second = await applyMigrations(testDb);

    expect(second.status).toBe("UP_TO_DATE");
    const ledger = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM blendsdk_migrations",
    );
    expect(ledger.records[0]?.count).toBe(2);
  });

  it("should report status and validate the applied history", async () => {
    await applyMigrations(testDb);

    const status = await withTestDatabaseUrl(testDb, () =>
      getMigrationStatus({ configPath: migrationConfigPath }),
    );
    expect(status.status).toBe("UP_TO_DATE");

    const validation = await withTestDatabaseUrl(testDb, () =>
      validateMigrations({ configPath: migrationConfigPath }),
    );
    expect(validation.status).toBe("UP_TO_DATE");
  });

  it("should report pending migrations in dry-run without creating tables", async () => {
    const result = await withTestDatabaseUrl(testDb, () =>
      runMigrations({
        command: "up",
        configPath: migrationConfigPath,
        dryRun: true,
      }),
    );

    expect(result.status).toBe("PENDING");
    expect(result.migrations).toHaveLength(2);
    expect(await tableExists(testDb, "org")).toBe(false);
    expect(await tableExists(testDb, "blendsdk_migrations")).toBe(false);
  });

  it("should refuse server startup when the database URL is missing", () => {
    const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
    const environment = createServerEnvironment();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ...environment.env };
      delete env.OPENVAULT_DB_URL;

      const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: serverRoot,
        encoding: "utf8",
        env,
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("OPENVAULT_DB_URL");
    } finally {
      environment.cleanup();
    }
  }, 20_000);

  it("should reject tampered migration history and refuse startup", async () => {
    await applyMigrations(testDb);
    await testDb.db.executeQuery(
      "UPDATE blendsdk_migrations SET checksum = 'tampered' WHERE id LIKE '%_initial'",
    );

    const validation = await withTestDatabaseUrl(testDb, () =>
      validateMigrations({ configPath: migrationConfigPath }),
    );
    expect(validation.status).toBe("INVALID_HISTORY");

    const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
    const environment = createServerEnvironment({ OPENVAULT_DB_URL: testDb.url });
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: serverRoot,
        encoding: "utf8",
        env: { ...process.env, ...environment.env },
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/migration|invalid|tampered/i);
    } finally {
      environment.cleanup();
    }

    const cli = spawnSync(process.execPath, ["--import", "tsx", "src/db/cli.ts", "--validate"], {
      cwd: serverRoot,
      encoding: "utf8",
      env: { ...process.env, OPENVAULT_DB_URL: testDb.url },
      timeout: 15_000,
    });
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(1);
  }, 20_000);

  it("should preserve earlier migrations when a later migration fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openvault-partial-"));
    try {
      const sourceMigrations = fileURLToPath(new URL("../../migrations/", import.meta.url));
      for (const file of readdirSync(sourceMigrations)) {
        copyFileSync(join(sourceMigrations, file), join(directory, file));
      }
      const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
      symlinkSync(join(serverRoot, "node_modules"), join(directory, "node_modules"), "dir");
      const schemaPath = fileURLToPath(new URL("../../src/database/schema.ts", import.meta.url));
      const configPath = join(directory, "blendsdk.migrations.ts");
      writeFileSync(
        configPath,
        `import { defineMigrationConfig } from "blendsdk/codegen";\nexport default defineMigrationConfig({ schema: ${JSON.stringify(schemaPath)}, migrationsDir: ${JSON.stringify(directory)}, databaseUrlEnv: "OPENVAULT_DB_URL" });\n`,
      );
      writeFileSync(
        join(directory, "20261030094300_bad.up.sql"),
        "-- blendsdk-migration: 1\n-- id: 20261030094300_bad\n-- transaction: true\n-- from-snapshot: none\n-- to-snapshot: none\nCREATE TABLE partial_probe (id int);\nINSERT INTO missing_table VALUES (1);\n",
      );

      await expect(
        withTestDatabaseUrl(testDb, () => runMigrations({ command: "up", configPath })),
      ).rejects.toThrow();

      expect(await tableExists(testDb, "org")).toBe(true);
      expect(await tableExists(testDb, "partial_probe")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("should reject a locally modified migration file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openvault-history-"));
    try {
      const sourceMigrations = fileURLToPath(new URL("../../migrations/", import.meta.url));
      for (const file of readdirSync(sourceMigrations)) {
        copyFileSync(join(sourceMigrations, file), join(directory, file));
      }
      const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
      symlinkSync(join(serverRoot, "node_modules"), join(directory, "node_modules"), "dir");

      const schemaPath = fileURLToPath(new URL("../../src/database/schema.ts", import.meta.url));
      const configPath = join(directory, "blendsdk.migrations.ts");
      writeFileSync(
        configPath,
        `import { defineMigrationConfig } from "blendsdk/codegen";\nexport default defineMigrationConfig({ schema: ${JSON.stringify(schemaPath)}, migrationsDir: ${JSON.stringify(directory)}, databaseUrlEnv: "OPENVAULT_DB_URL" });\n`,
      );

      const applied = await withTestDatabaseUrl(testDb, () =>
        runMigrations({ command: "up", configPath }),
      );
      expect(applied.status).toBe("UP_TO_DATE");

      const baseline = readdirSync(directory).find((file) => file.includes("_initial.up.sql"));
      if (!baseline) {
        throw new Error("Baseline migration not found");
      }
      appendFileSync(join(directory, baseline), "\n-- tampered\n");

      const validation = await withTestDatabaseUrl(testDb, () =>
        validateMigrations({ configPath }),
      );
      expect(validation.status).toBe("INVALID_HISTORY");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

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

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type MigrationCommandResult, runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { Client } from "pg";

/** Raised when the integration-test environment is not safe to use. */
export class TestDatabaseGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TestDatabaseGuardError";
  }
}

/** Parsed, validated settings for the maintenance test database. */
export interface TestDatabaseSettings {
  readonly maintenanceUrl: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/** A disposable database created for one integration test run. */
export interface TestDatabase {
  readonly db: PostgreSQLDatabase;
  readonly name: string;
  readonly url: string;
  cleanup(): Promise<void>;
}

/** Absolute path to the BlendSDK migration configuration. */
export const migrationConfigPath = fileURLToPath(
  new URL("../../../blendsdk.migrations.ts", import.meta.url),
);

/**
 * Runs an action with `OPENVAULT_DB_URL` pointed at a disposable database.
 *
 * The previous value is restored so tests cannot leak a database target into another
 * suite.
 *
 * @param testDb - Disposable test database.
 * @param action - Codegen action to run.
 * @returns The action result.
 */
export async function withTestDatabaseUrl<T>(
  testDb: TestDatabase,
  action: () => Promise<T>,
): Promise<T> {
  const previous = process.env.OPENVAULT_DB_URL;
  process.env.OPENVAULT_DB_URL = testDb.url;
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENVAULT_DB_URL;
    } else {
      process.env.OPENVAULT_DB_URL = previous;
    }
  }
}

/**
 * Applies the configured BlendSDK migrations to a disposable database.
 *
 * @param testDb - Disposable test database.
 * @returns Migration command result.
 */
export async function applyMigrations(testDb: TestDatabase): Promise<MigrationCommandResult> {
  return withTestDatabaseUrl(testDb, () =>
    runMigrations({
      command: "up",
      configPath: migrationConfigPath,
    }),
  );
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Validates the integration-test environment.
 *
 * The guard is deliberately strict: a mistaken `TEST_DATABASE_URL` must never point the
 * suite at a shared or staging database. The database is only used as a maintenance
 * connection; each test run creates a new database from it.
 *
 * @param env - Environment to read. Defaults to the process environment.
 * @returns Validated maintenance settings.
 * @throws {TestDatabaseGuardError} When the opt-in, URL, host, or database name is unsafe.
 */
export function resolveTestDatabaseSettings(
  env: NodeJS.ProcessEnv = process.env,
): TestDatabaseSettings {
  if (env.OPENVAULT_TEST_DB !== "1") {
    throw new TestDatabaseGuardError(
      "Set OPENVAULT_TEST_DB=1 to confirm integration tests may create databases.",
    );
  }

  const rawUrl = env.TEST_DATABASE_URL;
  if (!rawUrl) {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL is required and must point at a local maintenance database.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL is not a valid URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL must use the postgres protocol.");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL must use localhost, 127.0.0.1, or ::1.");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_]+_test$/.test(database)) {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL database name must end with _test.");
  }

  const user = decodeURIComponent(parsed.username);
  if (!user) {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL must include a database user.");
  }

  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TestDatabaseGuardError("TEST_DATABASE_URL has an invalid port.");
  }

  return {
    maintenanceUrl: parsed.toString(),
    host,
    port,
    database,
    user,
    password: decodeURIComponent(parsed.password),
  };
}

/**
 * Quotes a PostgreSQL identifier so a generated name cannot become SQL.
 *
 * @param identifier - Identifier to quote.
 * @returns Double-quoted identifier with embedded quotes escaped.
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Waits until PostgreSQL no longer lists a database in `pg_stat_activity`.
 *
 * Pool shutdown resolves when its client list is empty, but the backend socket can
 * remain visible for a short time. Dropping the database in that window terminates
 * the closing socket and can surface as an unhandled `57P01` error in the test run.
 *
 * @param admin - Maintenance connection used to inspect activity.
 * @param name - Disposable database name.
 */
async function waitForDatabaseIdle(admin: Client, name: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
      [name],
    );
    if ((result.rows[0]?.count ?? 0) === 0) {
      return;
    }
    await delay(25);
  }
}

/**
 * Creates a unique, disposable database for one integration run.
 *
 * The maintenance database is only used to create and drop the unique database. Its schema
 * is never touched.
 *
 * @param settings - Validated maintenance settings. Defaults to reading the environment.
 * @returns The connected test database and its cleanup function.
 */
export async function createTestDatabase(
  settings: TestDatabaseSettings = resolveTestDatabaseSettings(),
): Promise<TestDatabase> {
  const name = `openvault_test_${randomBytes(13).toString("hex").toUpperCase()}`;
  if (!/^openvault_test_[0-9A-F]{26}$/.test(name)) {
    throw new Error("Generated test database name is invalid.");
  }

  const admin = new Client({ connectionString: settings.maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }

  const url = new URL(settings.maintenanceUrl);
  url.pathname = `/${name}`;
  const db = new PostgreSQLDatabase({
    host: settings.host,
    port: settings.port,
    database: name,
    user: settings.user,
    pass: settings.password,
  });

  let cleaned = false;
  return {
    db,
    name,
    url: url.toString(),
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        await db.disconnect();
      } catch (error) {
        // The application shutdown path may have disposed the same pool first.
        // A second `pg-pool` end is benign for a disposable test database.
        if (
          !(error instanceof Error) ||
          !error.message.includes("Called end on pool more than once")
        ) {
          throw error;
        }
      } finally {
        const dropAdmin = new Client({ connectionString: settings.maintenanceUrl });
        await dropAdmin.connect();
        try {
          await waitForDatabaseIdle(dropAdmin, name);
          await dropAdmin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
        } finally {
          await dropAdmin.end();
        }
      }
    },
  };
}

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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

/** Absolute path to the ordered SQL migrations shipped with the server. */
export const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

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
      } finally {
        const dropAdmin = new Client({ connectionString: settings.maintenanceUrl });
        await dropAdmin.connect();
        try {
          await dropAdmin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
        } finally {
          await dropAdmin.end();
        }
      }
    },
  };
}

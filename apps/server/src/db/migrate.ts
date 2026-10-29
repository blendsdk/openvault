import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";

/** Options that control one migration run. */
export interface MigrationOptions {
  /** How long to wait for the advisory lock. Defaults to 30 seconds. */
  readonly lockTimeoutMs?: number;
  /** Report pending migrations without creating or changing anything. */
  readonly dryRun?: boolean;
}

/** Outcome of one migration run. */
export interface MigrationResult {
  /** Migration ids applied during this call. */
  readonly applied: string[];
  /** Migration ids that were pending before this call. */
  readonly pending: string[];
  /** SHA-256 checksums for every SQL file on disk. */
  readonly checksums: Record<string, string>;
}

interface LoadedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly sql: string;
}

interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
}

/** Ordered SQL migrations shipped with the server. */
export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

const LOCK_TIMEOUT_DEFAULT_MS = 30_000;
const STATEMENT_TIMEOUT = "5min";
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\s*;/im;

/**
 * Removes SQL comments, quoted strings, and dollar-quoted bodies before checking for
 * top-level transaction control.
 *
 * PL/pgSQL function bodies contain `BEGIN` and `END`, but they live inside dollar quotes.
 * They must not be mistaken for a migration that tries to manage its own transaction.
 *
 * @param sql - Raw migration text.
 * @returns SQL with comments and quoted bodies replaced by whitespace, preserving newlines.
 */
export function stripCommentsStringsAndDollarQuotes(sql: string): string {
  let output = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
          continue;
        }
        if (sql[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      continue;
    }

    if (character === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (sql[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      continue;
    }

    if (character === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (match) {
        const delimiter = match[0];
        index += delimiter.length;
        while (index < sql.length) {
          if (sql.startsWith(delimiter, index)) {
            index += delimiter.length;
            break;
          }
          if (sql[index] === "\n") {
            output += "\n";
          }
          index += 1;
        }
        continue;
      }
    }

    output += character;
    index += 1;
  }

  return output;
}

/**
 * Reads and validates every ordered SQL migration in a directory.
 *
 * @param directory - Directory containing `*.sql` files.
 * @returns Loaded migrations in filename order.
 * @throws {Error} When the directory is empty, a file cannot be read, or a file contains
 * top-level transaction control.
 */
async function loadMigrations(directory: string): Promise<LoadedMigration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: LoadedMigration[] = [];
  for (const id of names) {
    const sql = await readFile(join(directory, id), "utf8");
    if (TRANSACTION_CONTROL.test(stripCommentsStringsAndDollarQuotes(sql))) {
      throw new Error(`Migration ${id} must not contain top-level transaction control`);
    }
    migrations.push({
      id,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    });
  }
  return migrations;
}

/**
 * Validates applied rows and returns migrations that still need to run.
 *
 * @param migrations - Migrations found on disk.
 * @param applied - Rows currently recorded in `schema_migrations`.
 * @returns Pending migrations in filename order.
 * @throws {Error} When an applied migration is missing, changed, or ordering is unsafe.
 */
function pendingMigrations(
  migrations: LoadedMigration[],
  applied: AppliedMigration[],
): LoadedMigration[] {
  const onDisk = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set(applied.map((row) => row.id));

  for (const row of applied) {
    if (!onDisk.has(row.id)) {
      throw new Error(`Applied migration missing: ${row.id}`);
    }
    if (onDisk.get(row.id)?.checksum !== row.checksum) {
      throw new Error(`Migration checksum mismatch: ${row.id}`);
    }
  }

  const maxApplied = applied.at(-1)?.id;
  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
  for (const migration of pending) {
    if (maxApplied && migration.id < maxApplied) {
      throw new Error(`New migration ${migration.id} sorts before the latest applied migration`);
    }
  }
  return pending;
}

/**
 * Applies pending SQL migrations in one transaction.
 *
 * The complete run is guarded by a transaction-scoped advisory lock and is atomic: either
 * every pending migration is applied, or the database is left unchanged. Dry-run mode reads
 * the applied set, validates it, and reports pending ids without creating tables.
 *
 * @param db - Connected PostgreSQL database.
 * @param directory - Directory containing ordered `*.sql` migrations.
 * @param options - Lock timeout and dry-run controls.
 * @returns Applied and pending migration ids plus their checksums.
 *
 * @example
 * ```ts
 * const result = await migrate(db, defaultMigrationsDirectory);
 * console.log(result.applied);
 * ```
 */
export async function migrate(
  db: PostgreSQLDatabase,
  directory: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const checksums = Object.fromEntries(
    migrations.map((migration) => [migration.id, migration.checksum]),
  );
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error("lockTimeoutMs must be a positive integer");
  }

  return db.withTransaction(async (tx) => {
    if (options.dryRun) {
      const table = await tx.executeQuery<{ present: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
      );
      const applied = table.records[0]?.present
        ? await tx.executeQuery<AppliedMigration>(
            "SELECT id, checksum FROM schema_migrations ORDER BY id",
          )
        : { records: [], rowCount: 0 };
      if (migrations.length === 0 && applied.records.length === 0) {
        throw new Error("No migrations found");
      }
      const pending = pendingMigrations(migrations, applied.records);
      return {
        applied: [],
        pending: pending.map((migration) => migration.id),
        checksums,
      };
    }

    await tx.executeQuery(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await tx.executeQuery(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await tx.executeQuery("SELECT pg_advisory_xact_lock(hashtext('openvault_migrations'))");

    const table = await tx.executeQuery<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    const tablePresent = table.records[0]?.present ?? false;
    if (!tablePresent && migrations.length === 0) {
      throw new Error("No migrations found");
    }

    await tx.executeQuery(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const applied = await tx.executeQuery<AppliedMigration>(
      "SELECT id, checksum FROM schema_migrations ORDER BY id",
    );
    if (migrations.length === 0 && applied.records.length === 0) {
      throw new Error("No migrations found");
    }
    const pending = pendingMigrations(migrations, applied.records);

    for (const migration of pending) {
      await tx.executeQuery(migration.sql);
      await tx.executeQuery(
        "INSERT INTO schema_migrations (id, checksum) VALUES (:id, :checksum)",
        { id: migration.id, checksum: migration.checksum },
      );
    }

    return {
      applied: pending.map((migration) => migration.id),
      pending: pending.map((migration) => migration.id),
      checksums,
    };
  });
}

import { Client } from "pg";
import { OpsError } from "./errors.js";

/** One logical database dump. */
export interface DatabaseDump {
  /** Dump shape version. */
  readonly formatVersion: 1;
  /** Rows keyed by table name. */
  readonly tables: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
}

/** Options for one restore. */
export interface RestoreDatabaseOptions {
  /** Replace a non-empty target. */
  readonly force: boolean;
}

/** Result of one restore. */
export interface RestoreDatabaseResult {
  /** Number of restored rows. */
  readonly objectCount: number;
  /** Tables restored, in deterministic order. */
  readonly tables: readonly string[];
}

const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_TABLE = "blendsdk_migrations";

/** Tables seeded by migrations; their rows do not make a target "non-empty". */
const SEED_TABLES = new Set(["org", "policy_state"]);

/** Tables that must be present in every archive. */
const REQUIRED_TABLES = new Set(["org", "policy_state", "projects", "principals"]);

/**
 * FK-safe insertion order. The three cyclic columns are inserted NULL and
 * updated after both sides of the cycle exist.
 */
const INSERTION_ORDER = [
  "projects",
  "principals",
  "org",
  "policy_state",
  "local_credentials",
  "oidc_identities",
  "cli_sessions",
  "role_assignments",
  "idempotency_keys",
  "workload_certs",
  "secrets",
  "secret_versions",
  "certificates",
  "certificate_versions",
  "certificate_expiry_notifications",
  "consumers",
  "join_tokens",
  "audit_keys",
  "audit_checkpoints",
  "audit_events",
  "signing_keys",
  "ca_keys",
] as const;

/** Nullable FK columns that participate in an insertion cycle. */
const CYCLIC_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  secrets: ["current_version_id"],
  certificates: ["current_version_id"],
};

/** Quotes one validated PostgreSQL identifier. */
function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Quotes one public relation. */
function relation(value: string): string {
  return `public.${quoteIdent(value)}`;
}

/** Validates one table name. */
function assertTable(value: string): void {
  if (!TABLE_PATTERN.test(value) || value === MIGRATION_TABLE) {
    throw new OpsError("restore_archive_invalid", "The backup contains an invalid table name");
  }
}

/** Validates one column name. */
function assertColumn(value: string): void {
  if (!COLUMN_PATTERN.test(value)) {
    throw new OpsError("restore_archive_invalid", "The backup contains an invalid column name");
  }
}

/** Opens one database connection and pins the public search path. */
export async function openDatabaseClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET search_path = pg_catalog, public");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new OpsError("ops_configuration", "The operations database could not connect", {
      cause: error,
    });
  }
  return client;
}

/** Lists the logical data tables that belong in a backup. */
export async function listDataTables(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> $1
      ORDER BY table_name`,
    [MIGRATION_TABLE],
  );
  return result.rows.map((row) => row.table_name).filter((name) => TABLE_PATTERN.test(name));
}

/**
 * Captures every logical data table in one repeatable-read snapshot.
 *
 * A single read-only transaction prevents a parent row and its versions from
 * being captured from different committed states.
 */
export async function dumpDatabase(client: Client): Promise<DatabaseDump> {
  const tables: Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>> = {};
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    for (const table of await listDataTables(client)) {
      assertTable(table);
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${relation(table)}`,
      );
      tables[table] = result.rows;
    }
    await client.query("COMMIT");
    return { formatVersion: 1, tables };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Validates one parsed dump without cloning it. */
export function validateDump(value: unknown): DatabaseDump {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError("restore_archive_invalid", "The database dump is not an object");
  }
  if (Reflect.get(value, "formatVersion") !== 1) {
    throw new OpsError("restore_archive_invalid", "The database dump version is unsupported");
  }
  const tables = Reflect.get(value, "tables");
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    throw new OpsError("restore_archive_invalid", "The database dump tables are missing");
  }
  for (const [table, rows] of Object.entries(tables as Record<string, unknown>)) {
    assertTable(table);
    if (!Array.isArray(rows)) {
      throw new OpsError("restore_archive_invalid", "The database dump rows are invalid");
    }
    for (const row of rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new OpsError("restore_archive_invalid", "The database dump row is invalid");
      }
      for (const column of Object.keys(row)) {
        assertColumn(column);
      }
    }
  }
  return value as DatabaseDump;
}

/** Revives one JSON value, including bytea buffers and JSONB arrays. */
export function reviveValue(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "type") === "Buffer" &&
    Array.isArray(Reflect.get(value, "data"))
  ) {
    return Buffer.from(Reflect.get(value, "data") as number[]);
  }
  if (Array.isArray(value)) {
    // node-postgres encodes JS arrays as PostgreSQL array literals. JSONB
    // columns such as certificate SANs need a JSON text parameter instead.
    return JSON.stringify(value);
  }
  return value;
}

/** Counts rows in one table. */
async function countRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${relation(table)}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** Returns true when a non-seed data table has rows. */
export async function hasUserData(client: Client): Promise<boolean> {
  for (const table of await listDataTables(client)) {
    if (SEED_TABLES.has(table)) {
      continue;
    }
    if ((await countRows(client, table)) > 0) {
      return true;
    }
  }
  return false;
}

/** Advances every serial/identity sequence transactionally. */
async function resetSequences(client: Client, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_default LIKE 'nextval(%'`,
      [table],
    );
    for (const column of columns.rows) {
      assertColumn(column.column_name);
      const sequence = await client.query<{ sequence: string | null }>(
        "SELECT pg_get_serial_sequence($1, $2) AS sequence",
        [`public.${table}`, column.column_name],
      );
      const sequenceName = sequence.rows[0]?.sequence;
      if (sequenceName === null || sequenceName === undefined) {
        continue;
      }
      const max = await client.query<{ max: string }>(
        `SELECT COALESCE(max(${quoteIdent(column.column_name)}), 0)::text AS max
           FROM ${relation(table)}`,
      );
      const next = BigInt(max.rows[0]?.max ?? "0") + 1n;
      const quoted = sequenceName.split(".").map(quoteIdent).join(".");
      await client.query(`ALTER SEQUENCE ${quoted} RESTART WITH ${next.toString()}`);
    }
  }
}

/** Ensures every row in one table has the same columns as the first row. */
function columnsFor(
  table: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string[] {
  const first = rows[0];
  if (first === undefined) {
    return [];
  }
  const columns = Object.keys(first).sort();
  if (columns.length === 0) {
    throw new OpsError("restore_archive_invalid", `The ${table} rows have no columns`);
  }
  for (const row of rows) {
    const candidate = Object.keys(row).sort();
    if (
      candidate.length !== columns.length ||
      candidate.some((column, index) => column !== columns[index])
    ) {
      throw new OpsError("restore_archive_invalid", `The ${table} rows have inconsistent columns`);
    }
  }
  return columns;
}

/**
 * Restores one validated dump into a migrated target.
 *
 * All changes run in one transaction. Foreign-key triggers stay enabled so an
 * inconsistent archive cannot create dangling references; only user triggers
 * (append-only and version immutability) are disabled, which a table owner may
 * do. Cyclic current-version/owner columns are inserted NULL and updated after
 * both sides exist. A non-empty target is refused unless `force` is set.
 *
 * @param client - Connected restore client.
 * @param dump - Validated dump.
 * @param options - Replacement policy.
 * @returns Row and table counts.
 */
export async function restoreDatabase(
  client: Client,
  dump: DatabaseDump,
  options: RestoreDatabaseOptions,
): Promise<RestoreDatabaseResult> {
  // Serialize restores on the target database. The session lock is released
  // when the caller closes this client, including on every error path.
  await client.query("SELECT pg_advisory_lock(hashtext('openvault:restore:v1'))");
  const dumpTables = Object.keys(dump.tables).sort();
  if (dumpTables.length === 0) {
    throw new OpsError("restore_archive_invalid", "The database dump has no tables");
  }
  for (const required of REQUIRED_TABLES) {
    if (!dumpTables.includes(required)) {
      throw new OpsError(
        "restore_archive_invalid",
        `The database dump is missing the required ${required} table`,
      );
    }
  }
  const targetTables = await listDataTables(client);
  const targetSet = new Set(targetTables);
  for (const table of dumpTables) {
    if (!targetSet.has(table)) {
      throw new OpsError(
        "restore_archive_invalid",
        `The target schema is missing the ${table} table; run migrations first`,
      );
    }
  }
  if (!options.force) {
    for (const table of targetTables) {
      if (SEED_TABLES.has(table)) {
        continue;
      }
      if ((await countRows(client, table)) > 0) {
        throw new OpsError(
          "restore_target_not_empty",
          "The restore target is not empty; use --force to replace it",
        );
      }
    }
  }

  const ordered = [
    ...INSERTION_ORDER.filter((table) => dumpTables.includes(table)),
    ...dumpTables.filter((table) => !(INSERTION_ORDER as readonly string[]).includes(table)),
  ];
  let objectCount = 0;
  try {
    await client.query("BEGIN");
    try {
      for (const table of targetTables) {
        await client.query(`ALTER TABLE ${relation(table)} DISABLE TRIGGER USER`);
      }
    } catch (error) {
      throw new OpsError(
        "restore_requires_owner",
        "The restore role must own the tables to disable their user triggers",
        { cause: error },
      );
    }
    await client.query(
      `TRUNCATE ${targetTables.map((table) => relation(table)).join(", ")} RESTART IDENTITY CASCADE`,
    );

    const cycleUpdates: Array<{
      readonly table: string;
      readonly column: string;
      readonly id: unknown;
      readonly value: unknown;
    }> = [];
    for (const table of ordered) {
      const sourceRows = dump.tables[table] ?? [];
      if (sourceRows.length === 0) {
        continue;
      }
      const columns = columnsFor(table, sourceRows);
      const cyclic = new Set(CYCLIC_COLUMNS[table] ?? []);
      const insertColumns = columns.filter((column) => !cyclic.has(column));
      const columnSql = insertColumns.map((column) => quoteIdent(column)).join(", ");
      const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(", ");
      const insert = `INSERT INTO ${relation(table)} (${columnSql}) VALUES (${placeholders})`;
      for (const row of sourceRows) {
        await client.query(
          insert,
          insertColumns.map((column) => reviveValue(row[column])),
        );
        for (const column of cyclic) {
          if (row[column] !== null && row[column] !== undefined) {
            cycleUpdates.push({ table, column, id: row.id, value: row[column] });
          }
        }
        objectCount += 1;
      }
    }
    for (const update of cycleUpdates) {
      await client.query(
        `UPDATE ${relation(update.table)} SET ${quoteIdent(update.column)} = $1 WHERE id = $2`,
        [reviveValue(update.value), reviveValue(update.id)],
      );
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await resetSequences(client, targetTables);
    for (const table of targetTables) {
      await client.query(`ALTER TABLE ${relation(table)} ENABLE TRIGGER USER`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError("restore_failed", "The database restore failed", { cause: error });
  }

  return { objectCount, tables: dumpTables };
}

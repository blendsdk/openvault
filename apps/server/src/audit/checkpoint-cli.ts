import { closeSync, existsSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { loadConfig } from "../config/index.js";
import { AuditPruneConfigError } from "./errors.js";

/** One exported checkpoint. */
export interface ExportedCheckpoint {
  readonly id: string;
  readonly lastEventId: string;
  readonly lastHash: string;
  readonly hmac: string;
  readonly auditKeyId: string;
  readonly createdAt: string;
}

interface CheckpointRow {
  readonly id: string;
  readonly last_event_id: string;
  readonly last_hash: Buffer;
  readonly hmac: Buffer;
  readonly audit_key_id: string;
  readonly created_at: Date;
}

/**
 * Writes the newest checkpoint as one JSON file.
 *
 * @param database - Application database.
 * @param outputPath - Absolute path that must not exist.
 * @returns The exported checkpoint.
 * @throws {AuditPruneConfigError} When there is no checkpoint or the path is invalid.
 */
export async function exportLatestCheckpoint(
  database: PostgreSQLDatabase,
  outputPath: string,
): Promise<ExportedCheckpoint> {
  if (!isAbsolute(outputPath)) {
    throw new AuditPruneConfigError("Output path must be absolute");
  }
  if (existsSync(outputPath)) {
    throw new AuditPruneConfigError("Output path already exists");
  }
  const result = await database.executeQuery<CheckpointRow>(
    `SELECT id, last_event_id, last_hash, hmac, audit_key_id, created_at
       FROM audit_checkpoints
      ORDER BY last_event_id DESC
      LIMIT 1`,
  );
  const row = result.records[0];
  if (row === undefined) {
    throw new AuditPruneConfigError("No audit checkpoint exists");
  }
  const exported: ExportedCheckpoint = {
    id: String(row.id),
    lastEventId: String(row.last_event_id),
    lastHash: row.last_hash.toString("hex"),
    hmac: row.hmac.toString("hex"),
    auditKeyId: row.audit_key_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
  const descriptor = openSync(outputPath, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(exported, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(outputPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  return exported;
}

const USAGE = "Usage: audit:checkpoint --out <absolute-path>";

/** Runs the checkpoint export command. */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--out" || argv[1] === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const outputPath = argv[1];
  if (!isAbsolute(outputPath)) {
    process.stderr.write("--out must be an absolute path\n");
    return 2;
  }
  if (existsSync(outputPath)) {
    process.stderr.write("--out already exists\n");
    return 2;
  }

  let database: PostgreSQLDatabase | undefined;
  try {
    const config = loadConfig(process.env);
    database = new PostgreSQLDatabase({
      ...config.database,
      enableGracefulShutdown: false,
    });
    const exported = await exportLatestCheckpoint(database, outputPath);
    process.stdout.write(`checkpoint=${exported.id} lastEventId=${exported.lastEventId}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Checkpoint export failed"}\n`,
    );
    return 1;
  } finally {
    if (database !== undefined) {
      await database.disconnect().catch(() => undefined);
    }
  }
}

if (process.argv[1]?.endsWith("checkpoint-cli.js") === true) {
  const code = await main();
  process.exitCode = code;
}

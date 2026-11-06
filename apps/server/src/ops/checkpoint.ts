import { resolve } from "node:path";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { exportLatestCheckpoint } from "../audit/checkpoint-cli.js";
import { parseDatabaseUrl } from "../db/url.js";

/** Options for one checkpoint export. */
export interface CheckpointExportOptions {
  /** Application database URL. */
  readonly databaseUrl: string;
  /** Absolute output path; the file must not exist. */
  readonly outPath: string;
}

/** Result of one checkpoint export. */
export interface CheckpointExportResult {
  /** Output path. */
  readonly outPath: string;
  /** Checkpoint identifier. */
  readonly id: string;
  /** Last event covered by the checkpoint. */
  readonly lastEventId: string;
  /** Creation timestamp. */
  readonly createdAt: string;
}

/**
 * Exports the newest audit checkpoint as one JSON file.
 *
 * The checkpoint is the off-box anchor for the audit chain. The command needs
 * only the application database role because it reads and never modifies the
 * chain.
 *
 * @param options - Database URL and output path.
 * @returns Exported checkpoint metadata.
 */
export async function runCheckpointExport(
  options: CheckpointExportOptions,
): Promise<CheckpointExportResult> {
  const database = new PostgreSQLDatabase({
    ...parseDatabaseUrl(options.databaseUrl),
    poolConfig: { max: 1, connectionTimeoutMillis: 3_000 },
    enableGracefulShutdown: false,
  });
  try {
    const exported = await exportLatestCheckpoint(database, resolve(options.outPath));
    return {
      outPath: resolve(options.outPath),
      id: exported.id,
      lastEventId: exported.lastEventId,
      createdAt: exported.createdAt,
    };
  } finally {
    await database.disconnect();
  }
}

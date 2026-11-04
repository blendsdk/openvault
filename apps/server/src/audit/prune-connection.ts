import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { AuditPruneConfigError } from "./errors.js";

/** Expected boundary values that must match before a destructive delete. */
export interface PruneDeleteExpectation {
  /** Database name that was verified and exported. */
  readonly database: string;
  /** Hash of the boundary event. */
  readonly lastHash: Buffer;
  /** Number of exported rows. */
  readonly count: number;
}

/** A short-lived pruner-session connection. */
export interface PruneConnection {
  /** Deletes every event through one sequence id and returns the row count. */
  deletePrefix(lastEventId: string, expected: PruneDeleteExpectation): Promise<number>;
  /** Closes the underlying pool. */
  close(): Promise<void>;
}

/**
 * Opens a short-lived connection that satisfies the append-only trigger.
 *
 * The session user must be `openvault_pruner`; the server process never reads
 * this URL.
 *
 * @param rawUrl - `OPENVAULT_PRUNE_DB_URL`.
 * @returns The guarded delete handle.
 * @throws {AuditPruneConfigError} When the URL is missing or the session user is wrong.
 */
export async function createPruneConnection(rawUrl: string | undefined): Promise<PruneConnection> {
  if (rawUrl === undefined || rawUrl.trim() === "") {
    throw new AuditPruneConfigError("OPENVAULT_PRUNE_DB_URL is required");
  }
  let database: PostgreSQLDatabase;
  try {
    database = new PostgreSQLDatabase(parseDatabaseUrl(rawUrl));
  } catch {
    throw new AuditPruneConfigError("OPENVAULT_PRUNE_DB_URL is invalid");
  }

  try {
    const session = await database.executeQuery<{ session_user: string }>("SELECT session_user");
    if (session.records[0]?.session_user !== "openvault_pruner") {
      throw new AuditPruneConfigError(
        "The prune connection must use the openvault_pruner session user",
      );
    }
  } catch (error) {
    await database.disconnect();
    if (error instanceof AuditPruneConfigError) {
      throw error;
    }
    throw new AuditPruneConfigError("The prune connection could not be opened");
  }

  return {
    async deletePrefix(lastEventId: string, expected: PruneDeleteExpectation): Promise<number> {
      let deleted = 0;
      await database.withTransaction(async (tx) => {
        const identity = await tx.executeQuery<{ database: string }>(
          "SELECT current_database() AS database",
        );
        if (identity.records[0]?.database !== expected.database) {
          throw new AuditPruneConfigError("The prune connection targets a different database");
        }
        const boundary = await tx.executeQuery<{ hash: Buffer }>(
          "SELECT hash FROM audit_events WHERE id = CAST(:lastEventId AS bigint)",
          { lastEventId },
        );
        if (!boundary.records[0]?.hash.equals(expected.lastHash)) {
          throw new AuditPruneConfigError("The prune boundary no longer matches");
        }
        const prefix = await tx.executeQuery<{ count: number }>(
          "SELECT count(*)::int AS count FROM audit_events WHERE id <= CAST(:lastEventId AS bigint)",
          { lastEventId },
        );
        if ((prefix.records[0]?.count ?? 0) !== expected.count) {
          throw new AuditPruneConfigError("The prune prefix changed after export");
        }
        await tx.executeQuery("SET LOCAL openvault.allow_audit_prune = 'on'");
        const result = await tx.executeQuery(
          "DELETE FROM audit_events WHERE id <= CAST(:lastEventId AS bigint)",
          { lastEventId },
        );
        if ((result.rowCount ?? 0) !== expected.count) {
          throw new AuditPruneConfigError("The prune delete count did not match the export");
        }
        deleted = result.rowCount ?? 0;
      });
      return deleted;
    },
    async close(): Promise<void> {
      await database.disconnect();
    },
  };
}

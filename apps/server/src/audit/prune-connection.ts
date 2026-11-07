import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { AuditPruneConfigError } from "./errors.js";

/** A short-lived pruner-session connection. */
export interface PruneConnection {
  /** Deletes the prefix named by one authorization and returns the row count. */
  deletePrefix(authorizationId: string): Promise<number>;
  /** Closes the underlying pool. */
  close(): Promise<void>;
}

/**
 * Opens a short-lived connection that can execute the prune procedure.
 *
 * The session user must be `openvault_pruner`; the server process never reads
 * this URL. The role has no direct table authority, so the procedure is the
 * only destructive path.
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
    async deletePrefix(authorizationId: string): Promise<number> {
      try {
        const result = await database.executeQuery<{ deleted: number }>(
          "SELECT public.openvault_prune_audit_prefix(:authorizationId) AS deleted",
          { authorizationId },
        );
        return result.records[0]?.deleted ?? 0;
      } catch (error) {
        if (error instanceof AuditPruneConfigError) {
          throw error;
        }
        throw new AuditPruneConfigError("The prune authorization was rejected");
      }
    },
    async close(): Promise<void> {
      await database.disconnect();
    },
  };
}

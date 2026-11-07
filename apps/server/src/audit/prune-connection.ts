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
    const session = await database.executeQuery<{
      readonly session_user: string;
      readonly is_migrator: boolean;
      readonly is_auth: boolean;
      readonly is_app: boolean;
      readonly is_backup: boolean;
      readonly is_purger: boolean;
      readonly rolsuper: boolean;
      readonly rolcreaterole: boolean;
      readonly rolcreatedb: boolean;
      readonly rolbypassrls: boolean;
      readonly rolreplication: boolean;
      readonly can_delete: boolean;
      readonly can_checkpoint: boolean;
      readonly can_execute: boolean;
    }>(
      `SELECT session_user,
              r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
              COALESCE(pg_has_role(current_user, to_regrole('openvault_migrator'), 'MEMBER'), false)
                AS is_migrator,
              COALESCE(pg_has_role(current_user, to_regrole('openvault_auth'), 'MEMBER'), false)
                AS is_auth,
              COALESCE(pg_has_role(current_user, to_regrole('openvault_app'), 'MEMBER'), false)
                AS is_app,
              COALESCE(pg_has_role(current_user, to_regrole('openvault_backup'), 'MEMBER'), false)
                AS is_backup,
              COALESCE(pg_has_role(current_user, to_regrole('openvault_purger'), 'MEMBER'), false)
                AS is_purger,
              has_table_privilege(current_user, 'audit_events', 'DELETE') AS can_delete,
              has_table_privilege(current_user, 'audit_checkpoints', 'INSERT') AS can_checkpoint,
              has_function_privilege(
                current_user,
                'public.openvault_prune_audit_prefix(text)',
                'EXECUTE'
              ) AS can_execute
         FROM pg_roles r
        WHERE r.rolname = current_user`,
    );
    const role = session.records[0];
    if (role?.session_user !== "openvault_pruner") {
      throw new AuditPruneConfigError(
        "The prune connection must use the openvault_pruner session user",
      );
    }
    if (
      role.is_migrator ||
      role.is_auth ||
      role.is_app ||
      role.is_backup ||
      role.is_purger ||
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolbypassrls ||
      role.rolreplication ||
      role.can_delete ||
      role.can_checkpoint ||
      !role.can_execute
    ) {
      throw new AuditPruneConfigError(
        "The prune role still has direct audit authority; apply deploy/postgres/grants.sql",
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

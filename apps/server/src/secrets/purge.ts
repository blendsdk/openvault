import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { PostgreSQLDatabase as Database } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { SecretServiceError } from "./errors.js";

const PURGER_USER_NAME = "openvault_purger";

/** Options for {@link SecretPurger}. */
export interface SecretPurgerOptions {
  /** Dedicated purge URL, or undefined when unavailable. */
  readonly url?: string;
  /** Application database name that must match the purge connection. */
  readonly appDatabase: string;
}

interface PurgerIdentityRow {
  readonly session_user: string;
  readonly database: string;
  readonly rolsuper: boolean;
  readonly member_secrets_owner: boolean;
  readonly member_versions_owner: boolean;
  readonly super_member: boolean;
}

/**
 * Executes the trigger-guarded secret purge on a dedicated session.
 *
 * The connection is created lazily so an invalid URL leaves the server
 * bootable and only the purge operation fails. The role, database, ownership,
 * and membership checks run on every delete; they are not cached.
 */
export class SecretPurger {
  readonly #url: string | undefined;
  readonly #appDatabase: string;
  #database: PostgreSQLDatabase | undefined;

  /**
   * @param options - Purge URL and expected database.
   */
  public constructor(options: SecretPurgerOptions) {
    this.#url = options.url;
    this.#appDatabase = options.appDatabase;
  }

  /**
   * Deletes one secret and its versions inside the guarded transaction.
   *
   * @param secretId - Secret identifier.
   * @param projectId - Active project identifier.
   * @param name - Secret name used for the lifecycle advisory lock.
   * @returns The number of deleted version rows.
   */
  public async delete(secretId: string, projectId: string, name: string): Promise<number> {
    const database = this.#connection();
    let deleted = 0;
    try {
      await database.withTransaction(async (tx) => {
        const identity = await tx.executeQuery<PurgerIdentityRow>(
          `SELECT current_user AS session_user,
                  current_database() AS database,
                  r.rolsuper,
                  pg_has_role(current_user, sc.relowner, 'MEMBER') AS member_secrets_owner,
                  pg_has_role(current_user, sv.relowner, 'MEMBER') AS member_versions_owner,
                  EXISTS (
                    SELECT 1 FROM pg_roles sr
                     WHERE sr.rolsuper
                       AND pg_has_role(current_user, sr.oid, 'MEMBER')
                  ) AS super_member
             FROM pg_roles r, pg_class sc, pg_class sv
            WHERE r.rolname = current_user
              AND sc.oid = 'secrets'::regclass
              AND sv.oid = 'secret_versions'::regclass`,
        );
        const row = identity.records[0];
        if (
          row === undefined ||
          row.session_user !== PURGER_USER_NAME ||
          row.database !== this.#appDatabase ||
          row.rolsuper ||
          row.member_secrets_owner ||
          row.member_versions_owner ||
          row.super_member
        ) {
          throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
        }

        await tx.executeQuery("SELECT pg_advisory_xact_lock(hashtext(:key)::bigint)", {
          key: `${projectId}:${name}`,
        });
        // Serialize with application state changes, which all take the audit
        // chain lock first. This avoids requiring UPDATE on projects solely to
        // take a row lock.
        await tx.executeQuery("SELECT pg_advisory_xact_lock(:lockId)", {
          lockId: 780_217_001,
        });
        const project = await tx.executeQuery<{ id: string }>(
          "SELECT id FROM projects WHERE id = :projectId AND deleted_at IS NULL",
          { projectId },
        );
        if (project.records.length !== 1) {
          throw new SecretServiceError(404, "project_not_found", "Project not found");
        }

        const versions = await tx.executeQuery<{ count: number }>(
          "SELECT count(*)::int AS count FROM secret_versions WHERE secret_id = :secretId",
          { secretId },
        );
        const expected = versions.records[0]?.count ?? 0;
        await tx.executeQuery("SET LOCAL openvault.allow_purge = 'on'");
        const versionDelete = await tx.executeQuery(
          "DELETE FROM secret_versions WHERE secret_id = :secretId",
          { secretId },
        );
        if ((versionDelete.rowCount ?? 0) !== expected) {
          throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
        }
        const parentDelete = await tx.executeQuery("DELETE FROM secrets WHERE id = :secretId", {
          secretId,
        });
        if ((parentDelete.rowCount ?? 0) !== 1) {
          throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
        }
        deleted = expected;
      });
      return deleted;
    } catch (error) {
      if (error instanceof SecretServiceError) {
        throw error;
      }
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
  }

  /** Closes the lazily created pool. */
  public async close(): Promise<void> {
    if (this.#database !== undefined) {
      await this.#database.disconnect();
      this.#database = undefined;
    }
  }

  /** Opens or returns the dedicated purge pool. */
  #connection(): PostgreSQLDatabase {
    if (this.#database !== undefined) {
      return this.#database;
    }
    if (this.#url === undefined || this.#url.trim() === "") {
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
    let database: PostgreSQLDatabase;
    try {
      database = new Database({
        ...parseDatabaseUrl(this.#url),
        poolConfig: { max: 1, idleTimeoutMillis: 100 },
        enableGracefulShutdown: false,
      });
    } catch {
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
    this.#database = database;
    return database;
  }
}

import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { PostgreSQLDatabase as Database } from "blendsdk/postgresql";
import { AUDIT_CHAIN_LOCK_ID } from "../audit/audit-writer.js";
import { parseDatabaseUrl } from "../db/url.js";
import { VaultPurgerError } from "./errors.js";

const PURGER_USER_NAME = "openvault_purger";

/** Options for {@link VaultPurger}. */
export interface VaultPurgerOptions {
  /** Dedicated purge URL, or undefined when unavailable. */
  readonly url?: string;
  /** Application database name that must match the purge connection. */
  readonly appDatabase: string;
}

interface PurgerIdentityRow {
  readonly session_user: string;
  readonly current_user: string;
  readonly database: string;
  readonly rolsuper: boolean;
  readonly member_secrets_owner: boolean;
  readonly member_secret_versions_owner: boolean;
  readonly member_certificates_owner: boolean;
  readonly member_certificate_versions_owner: boolean;
  readonly member_notifications_owner: boolean;
  readonly super_member: boolean;
}

type PurgeTarget =
  | {
      readonly family: "secret";
      readonly parentTable: "secrets";
      readonly versionTable: "secret_versions";
      readonly foreignKey: "secret_id";
    }
  | {
      readonly family: "certificate";
      readonly parentTable: "certificates";
      readonly versionTable: "certificate_versions";
      readonly foreignKey: "certificate_id";
    };

/**
 * Executes trigger-guarded secret and certificate purges on one dedicated session.
 *
 * The pool is created lazily so an invalid URL leaves the server bootable and only purge
 * fails. Database, session user, superuser status, ownership, and role memberships are
 * re-checked on every call; they are not cached.
 */
export class VaultPurger {
  readonly #url: string | undefined;
  readonly #appDatabase: string;
  #database: PostgreSQLDatabase | undefined;

  /**
   * @param options - Purge URL and expected database.
   */
  public constructor(options: VaultPurgerOptions) {
    this.#url = options.url;
    this.#appDatabase = options.appDatabase;
  }

  /**
   * Deletes one secret and its versions.
   *
   * @param secretId - Secret identifier.
   * @param projectId - Active project identifier.
   * @param name - Secret name for the advisory lock.
   * @returns Deleted version count.
   */
  public async deleteSecret(secretId: string, projectId: string, name: string): Promise<number> {
    return this.#purge(
      {
        family: "secret",
        parentTable: "secrets",
        versionTable: "secret_versions",
        foreignKey: "secret_id",
      },
      secretId,
      projectId,
      name,
    );
  }

  /**
   * Deletes one certificate, its notification rows, and its versions.
   *
   * @param certificateId - Certificate identifier.
   * @param projectId - Active project identifier.
   * @param name - Certificate name for the advisory lock.
   * @returns Deleted version count.
   */
  public async deleteCertificate(
    certificateId: string,
    projectId: string,
    name: string,
  ): Promise<number> {
    return this.#purge(
      {
        family: "certificate",
        parentTable: "certificates",
        versionTable: "certificate_versions",
        foreignKey: "certificate_id",
      },
      certificateId,
      projectId,
      name,
    );
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
      throw new VaultPurgerError("service_unavailable");
    }
    let database: PostgreSQLDatabase;
    try {
      database = new Database({
        ...parseDatabaseUrl(this.#url),
        poolConfig: { max: 1, idleTimeoutMillis: 100 },
        enableGracefulShutdown: false,
      });
    } catch {
      throw new VaultPurgerError("service_unavailable");
    }
    this.#database = database;
    return database;
  }

  /** Runs one guarded purge transaction. */
  async #purge(target: PurgeTarget, id: string, projectId: string, name: string): Promise<number> {
    const database = this.#connection();
    try {
      let deleted = 0;
      await database.withTransaction(async (tx) => {
        const identity = await tx.executeQuery<PurgerIdentityRow>(
          `SELECT session_user, current_user,
                  current_database() AS database,
                  r.rolsuper,
                  pg_has_role(session_user, sp.relowner, 'MEMBER') AS member_secrets_owner,
                  pg_has_role(session_user, sv.relowner, 'MEMBER') AS member_secret_versions_owner,
                  pg_has_role(session_user, cp.relowner, 'MEMBER') AS member_certificates_owner,
                  pg_has_role(session_user, cv.relowner, 'MEMBER') AS member_certificate_versions_owner,
                  pg_has_role(session_user, np.relowner, 'MEMBER') AS member_notifications_owner,
                  EXISTS (
                    SELECT 1 FROM pg_roles sr
                     WHERE sr.rolsuper
                       AND pg_has_role(session_user, sr.oid, 'MEMBER')
                  ) AS super_member
             FROM pg_roles r, pg_class sp, pg_class sv, pg_class cp, pg_class cv, pg_class np
            WHERE r.rolname = current_user
              AND sp.oid = 'secrets'::regclass
              AND sv.oid = 'secret_versions'::regclass
              AND cp.oid = 'certificates'::regclass
              AND cv.oid = 'certificate_versions'::regclass
              AND np.oid = 'certificate_expiry_notifications'::regclass`,
        );
        const row = identity.records[0];
        if (
          row === undefined ||
          row.session_user !== PURGER_USER_NAME ||
          row.current_user !== PURGER_USER_NAME ||
          row.database !== this.#appDatabase ||
          row.rolsuper ||
          row.member_secrets_owner ||
          row.member_secret_versions_owner ||
          row.member_certificates_owner ||
          row.member_certificate_versions_owner ||
          row.member_notifications_owner ||
          row.super_member
        ) {
          throw new VaultPurgerError("service_unavailable");
        }

        // Match the application lock order: audit chain first, then the per-name lock.
        await tx.executeQuery("SELECT pg_advisory_xact_lock(:lockId)", {
          lockId: AUDIT_CHAIN_LOCK_ID,
        });
        await tx.executeQuery("SELECT pg_advisory_xact_lock(hashtext(:key)::bigint)", {
          key: `${projectId}:${name}`,
        });
        const project = await tx.executeQuery<{ id: string }>(
          "SELECT id FROM projects WHERE id = :projectId AND deleted_at IS NULL",
          { projectId },
        );
        if (project.records.length !== 1) {
          throw new VaultPurgerError("project_not_found");
        }
        const parent = await tx.executeQuery<{ id: string }>(
          `SELECT id FROM ${target.parentTable}
            WHERE id = :id AND project_id = :projectId AND name = :name`,
          { id, projectId, name },
        );
        if (parent.records.length !== 1) {
          throw new VaultPurgerError("target_not_found");
        }

        if (target.family === "certificate") {
          await tx.executeQuery(
            "DELETE FROM certificate_expiry_notifications WHERE certificate_id = :id",
            { id },
          );
        }
        const versions = await tx.executeQuery<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${target.versionTable}
            WHERE ${target.foreignKey} = :id`,
          { id },
        );
        const expected = versions.records[0]?.count ?? 0;
        await tx.executeQuery("SET LOCAL openvault.allow_purge = 'on'");
        const versionDelete = await tx.executeQuery(
          `DELETE FROM ${target.versionTable} WHERE ${target.foreignKey} = :id`,
          { id },
        );
        if ((versionDelete.rowCount ?? 0) !== expected) {
          throw new VaultPurgerError("service_unavailable");
        }
        const parentDelete = await tx.executeQuery(
          `DELETE FROM ${target.parentTable}
            WHERE id = :id AND project_id = :projectId AND name = :name`,
          { id, projectId, name },
        );
        if ((parentDelete.rowCount ?? 0) !== 1) {
          throw new VaultPurgerError("service_unavailable");
        }
        deleted = expected;
      });
      return deleted;
    } catch (error) {
      if (error instanceof VaultPurgerError) {
        throw error;
      }
      throw new VaultPurgerError("service_unavailable");
    }
  }
}

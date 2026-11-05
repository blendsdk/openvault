import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { hashPassword, validateNewPassword } from "../auth/password.js";
import { InitError } from "./errors.js";

/** Options for {@link ensureOrganizationAndAdmin}. */
export interface EnsureAdminOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Organization display name. */
  readonly orgName: string;
  /** Administrator display name. */
  readonly adminName: string;
  /** Administrator email. */
  readonly adminEmail: string;
  /** Validated password. */
  readonly password: string;
  /** Must-change flag. */
  readonly mustChange: boolean;
}

/** Creates or renames the organization row. */
export async function ensureOrganization(
  database: PostgreSQLDatabase,
  orgName: string,
): Promise<boolean> {
  try {
    return await database.withTransaction(async (tx) => {
      const org = await tx.executeQuery<{ id: number; name: string }>(
        "SELECT id, name FROM org WHERE id = 1 LIMIT 1",
      );
      if (org.records.length === 0) {
        await tx.executeQuery("INSERT INTO org (id, name) VALUES (1, :name)", { name: orgName });
        return true;
      }
      if (org.records[0]?.name !== orgName) {
        await tx.executeQuery("UPDATE org SET name = :name WHERE id = 1", { name: orgName });
      }
      return false;
    });
  } catch (error) {
    throw new InitError("init_database", "The organization could not be created", { cause: error });
  }
}

/** Result of the admin bootstrap. */
export interface EnsureAdminResult {
  /** True when this run created the administrator. */
  readonly adminCreated: boolean;
  /** True when this run created the organization row. */
  readonly orgCreated: boolean;
}

/**
 * Creates or reuses the organization and bootstrap administrator.
 *
 * The password is validated and hashed before the transaction. The admin
 * assignment and policy-version bump commit together, so a running server sees
 * the bootstrap grant.
 *
 * @param options - Database, names, and password.
 * @returns Creation flags.
 */
export async function ensureOrganizationAndAdmin(
  options: EnsureAdminOptions,
): Promise<EnsureAdminResult> {
  try {
    validateNewPassword(options.password);
  } catch (error) {
    throw new InitError("init_password", "The bootstrap password must be 12-1024 characters", {
      cause: error,
    });
  }
  const passwordHash = await hashPassword(options.password);
  let orgCreated = false;
  try {
    return await options.database.withTransaction(async (tx) => {
      const org = await tx.executeQuery<{ id: number; name: string }>(
        "SELECT id, name FROM org WHERE id = 1 LIMIT 1",
      );
      if (org.records.length === 0) {
        await tx.executeQuery("INSERT INTO org (id, name) VALUES (1, :name)", {
          name: options.orgName,
        });
        orgCreated = true;
      } else if (org.records[0]?.name !== options.orgName) {
        await tx.executeQuery("UPDATE org SET name = :name WHERE id = 1", {
          name: options.orgName,
        });
      }

      const existing = await tx.executeQuery<{ id: string }>(
        `SELECT id FROM principals
          WHERE kind = 'user' AND lower(email) = lower(:email)
          LIMIT 1`,
        { email: options.adminEmail },
      );
      if (existing.records[0] !== undefined) {
        return { adminCreated: false, orgCreated };
      }

      const adminId = newUlid();
      await tx.executeQuery(
        `INSERT INTO principals (id, kind, name, email, status)
         VALUES (:id, 'user', :name, :email, 'active')`,
        { id: adminId, name: options.adminName, email: options.adminEmail },
      );
      await tx.executeQuery(
        `INSERT INTO local_credentials (principal_id, password_hash, must_change)
         VALUES (:principalId, :passwordHash, :mustChange)`,
        { principalId: adminId, passwordHash, mustChange: options.mustChange },
      );
      await tx.executeQuery(
        `INSERT INTO role_assignments
           (id, principal_id, role, scope_type, scope_id, granted_by)
         VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
        { id: newUlid(), principalId: adminId },
      );
      await tx.executeQuery(
        "UPDATE policy_state SET version = version + 1, updated_at = now() WHERE id = 1",
      );
      return { adminCreated: true, orgCreated };
    });
  } catch (error) {
    if (error instanceof InitError) {
      throw error;
    }
    throw new InitError("init_database", "The bootstrap administrator could not be created", {
      cause: error,
    });
  }
}

/** Returns true when an administrator with the email already exists. */
export async function adminExists(database: PostgreSQLDatabase, email: string): Promise<boolean> {
  const result = await database.executeQuery<{ id: string }>(
    `SELECT id FROM principals
      WHERE kind = 'user' AND lower(email) = lower(:email)
      LIMIT 1`,
    { email },
  );
  return result.records.length > 0;
}

import { createHash, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";

const REFRESH_TOKEN_BYTES = 32;
const MAX_USER_AGENT_LENGTH = 512;

/** Login context stored on a CLI refresh row. */
export interface CliRequestContext {
  /** Client address observed through the trusted proxy chain. */
  readonly ip: string | null;
  /** Truncated user-agent header. */
  readonly userAgent: string | null;
}

/** One stored CLI refresh row, projected with camelCase fields. */
export interface CliRefreshRow {
  /** Row identifier; never returned to a client. */
  readonly rowId: string;
  /** Owner principal. */
  readonly principalId: string;
  /** Public family identifier used as the JWT `sid`. */
  readonly familyId: string;
  /** Absolute family expiry. */
  readonly expiresAt: Date;
  /** Rotation or revocation time. */
  readonly revokedAt: Date | null;
  /** Row creation time. */
  readonly createdAt: Date;
  /** Login address. */
  readonly ip: string | null;
  /** Login user agent. */
  readonly userAgent: string | null;
}

/** A newly created refresh family and its raw token. */
export interface CreatedCliFamily {
  /** The inserted row. */
  readonly row: CliRefreshRow;
  /** 43-character base64url refresh token. */
  readonly refreshToken: string;
}

/** Result of creating a family under the per-principal login lock. */
export type CreateFamilyResult =
  | { readonly kind: "created"; readonly family: CreatedCliFamily }
  | { readonly kind: "credential_changed" };

/** One live CLI family in the caller's list. */
export interface CliFamilyEntry {
  /** Public family identifier. */
  readonly familyId: string;
  /** Original login time. */
  readonly createdAt: Date;
  /** Absolute family expiry. */
  readonly expiresAt: Date;
}

/** A principal loaded for bearer or rotation handling. */
export interface CliPrincipal {
  /** Principal identifier. */
  readonly principalId: string;
  /** Display name. */
  readonly name: string;
  /** Email address, or null. */
  readonly email: string | null;
  /** Whether the principal may authenticate. */
  readonly status: "active" | "disabled";
  /** True while a password change is required. */
  readonly mustChange: boolean;
}

/** Result of one refresh rotation attempt. */
export type RotateResult =
  | {
      readonly kind: "rotated";
      readonly row: CliRefreshRow;
      readonly principal: CliPrincipal;
      readonly refreshToken: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "expired" }
  | { readonly kind: "reuse" }
  | { readonly kind: "disabled" };

interface CliRefreshDbRow {
  readonly id: string;
  readonly principal_id: string;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

interface CliRefreshLockDbRow extends CliRefreshDbRow {
  readonly expired: boolean;
}

interface CliQuery {
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}

/**
 * Normalizes a user-agent header for storage.
 *
 * @param value - Raw header, if present.
 * @returns A trimmed value of at most 512 characters, or null.
 */
export function normalizeUserAgent(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_USER_AGENT_LENGTH);
}

/**
 * Hashes a refresh token with SHA-256.
 *
 * The raw token is never persisted. The canonical ASCII token is hashed as-is,
 * so a client that changes encoding cannot create a second lookup path.
 *
 * @param raw - 43-character base64url token.
 * @returns 32-byte digest for the `refresh_hash` column.
 */
export function hashRefreshToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Generates one opaque refresh token.
 *
 * @returns 32 random bytes encoded as unpadded base64url.
 */
function newRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

interface CliPrincipalDbRow {
  readonly principal_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
  readonly must_change: boolean;
}

function toRefreshRow(row: CliRefreshDbRow): CliRefreshRow {
  return {
    rowId: row.id,
    principalId: row.principal_id,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

function toPrincipal(row: CliPrincipalDbRow): CliPrincipal {
  return {
    principalId: row.principal_id,
    name: row.name,
    email: row.email,
    status: row.status === "active" ? "active" : "disabled",
    mustChange: row.must_change,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

/**
 * Stores and manages CLI refresh families.
 *
 * The repository owns the SQL and transaction boundaries. A login family is
 * inserted while holding the `principals` row lock and rechecking the verified
 * password hash, so any writer that must serialize with login has to take the
 * same lock.
 */
export class CliSessionRepository {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param database - Connected PostgreSQL database.
   */
  public constructor(database: PostgreSQLDatabase) {
    this.#database = database;
  }

  /**
   * Creates a refresh family after rechecking the verified password hash.
   *
   * @param principalId - Principal that authenticated.
   * @param expectedHash - Hash verified by the shared local-login service.
   * @param context - Login address and user agent.
   * @returns The new family/token, or a credential-changed result.
   */
  public async createFamilyForLogin(
    principalId: string,
    expectedHash: string,
    context: CliRequestContext,
  ): Promise<CreateFamilyResult> {
    return this.#database.withTransaction(async (tx) => {
      const principal = await tx.executeQuery<{ readonly id: string }>(
        "SELECT id FROM principals WHERE id = :principalId FOR UPDATE",
        { principalId },
      );
      if (principal.records[0] === undefined) {
        return { kind: "credential_changed" };
      }

      const credential = await tx.executeQuery<{ readonly password_hash: string }>(
        "SELECT password_hash FROM local_credentials WHERE principal_id = :principalId",
        { principalId },
      );
      if (credential.records[0]?.password_hash !== expectedHash) {
        return { kind: "credential_changed" };
      }

      const refreshToken = newRefreshToken();
      const rowId = newUlid();
      const familyId = newUlid();
      const result = await tx.executeQuery<CliRefreshDbRow>(
        `INSERT INTO cli_sessions
           (id, principal_id, refresh_hash, family_id, expires_at, ip, user_agent)
         VALUES
           (:rowId, :principalId, :refreshHash, :familyId,
            now() + interval '12 hours', :ip, :userAgent)
         RETURNING id, principal_id, family_id, expires_at, revoked_at, created_at,
                   ip, user_agent`,
        {
          rowId,
          principalId,
          refreshHash: hashRefreshToken(refreshToken),
          familyId,
          ip: context.ip,
          userAgent: context.userAgent,
        },
      );
      const row = result.records[0];
      if (row === undefined) {
        throw new Error("CLI family insert did not return a row");
      }

      return {
        kind: "created",
        family: { row: toRefreshRow(row), refreshToken },
      };
    });
  }

  /**
   * Looks up a family by refresh-token hash without taking a lock.
   *
   * The lookup is used for the post-lookup family rate limit and to discover
   * the owner before the rotation transaction takes the principal lock.
   *
   * @param refreshHash - SHA-256 of the canonical refresh token.
   * @returns The live or retained row, or undefined.
   */
  public async findFamilyByHash(refreshHash: Buffer): Promise<CliRefreshRow | undefined> {
    const result = await this.#database.executeQuery<CliRefreshDbRow>(
      `SELECT id, principal_id, family_id, expires_at, revoked_at, created_at, ip, user_agent
         FROM cli_sessions
        WHERE refresh_hash = :refreshHash`,
      { refreshHash },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toRefreshRow(row);
  }

  /**
   * Loads the principal and family state for one bearer request.
   *
   * The single query requires an active principal and a non-revoked, unexpired
   * family row. It is the authoritative liveness check for every CLI request.
   *
   * @param principalId - JWT `sub`.
   * @param familyId - JWT `sid`.
   * @returns The active principal, or undefined.
   */
  public async findActiveContext(
    principalId: string,
    familyId: string,
  ): Promise<CliPrincipal | undefined> {
    const result = await this.#database.executeQuery<CliPrincipalDbRow>(
      `SELECT p.id AS principal_id, p.name, p.email, p.status,
              COALESCE(c.must_change, false) AS must_change
         FROM principals p
         JOIN cli_sessions s
           ON s.principal_id = p.id AND s.family_id = :familyId
         LEFT JOIN local_credentials c ON c.principal_id = p.id
        WHERE p.id = :principalId
          AND p.status = 'active'
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        LIMIT 1`,
      { principalId, familyId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toPrincipal(row);
  }

  /**
   * Rotates one refresh token inside the principal and row locks.
   *
   * A revoked row is reuse: every live row in the family is revoked and the
   * caller receives 401. An expired family returns expired without extending
   * its life. A disabled principal revokes the family. The replacement row
   * inherits the family's original absolute expiry.
   *
   * @param refreshHash - SHA-256 of the presented token.
   * @param principalId - Owner discovered by the non-locking lookup.
   * @param familyId - Family discovered by the non-locking lookup.
   * @param context - Current request address and user agent.
   * @returns A discriminated rotation result.
   */
  public async rotateRefresh(
    refreshHash: Buffer,
    principalId: string,
    familyId: string,
    context: CliRequestContext,
  ): Promise<RotateResult> {
    try {
      return await this.#database.withTransaction(async (tx) => {
        const principalResult = await tx.executeQuery<CliPrincipalDbRow>(
          `SELECT p.id AS principal_id, p.name, p.email, p.status,
                  COALESCE(c.must_change, false) AS must_change
             FROM principals p
             LEFT JOIN local_credentials c ON c.principal_id = p.id
            WHERE p.id = :principalId
            FOR UPDATE OF p`,
          { principalId },
        );
        const principalRow = principalResult.records[0];
        if (principalRow === undefined) {
          return { kind: "invalid" };
        }

        const rowResult = await tx.executeQuery<CliRefreshLockDbRow>(
          `SELECT id, principal_id, family_id, expires_at, revoked_at, created_at,
                  ip, user_agent, expires_at <= now() AS expired
             FROM cli_sessions
            WHERE refresh_hash = :refreshHash
            FOR UPDATE`,
          { refreshHash },
        );
        const row = rowResult.records[0];
        if (row === undefined || row.principal_id !== principalId || row.family_id !== familyId) {
          return { kind: "invalid" };
        }
        if (row.revoked_at !== null) {
          await this.#revokeFamilyInTransaction(tx, familyId, principalId);
          return { kind: "reuse" };
        }
        if (row.expired) {
          return { kind: "expired" };
        }
        if (principalRow.status !== "active") {
          await this.#revokeFamilyInTransaction(tx, familyId, principalId);
          return { kind: "disabled" };
        }

        const refreshToken = newRefreshToken();
        const newRowId = newUlid();
        await tx.executeQuery(
          `UPDATE cli_sessions
              SET revoked_at = now()
            WHERE id = :rowId AND revoked_at IS NULL`,
          { rowId: row.id },
        );
        const inserted = await tx.executeQuery<CliRefreshDbRow>(
          `INSERT INTO cli_sessions
             (id, principal_id, refresh_hash, family_id, expires_at, ip, user_agent)
           VALUES
             (:rowId, :principalId, :refreshHash, :familyId, :expiresAt, :ip, :userAgent)
           RETURNING id, principal_id, family_id, expires_at, revoked_at, created_at,
                     ip, user_agent`,
          {
            rowId: newRowId,
            principalId,
            refreshHash: hashRefreshToken(refreshToken),
            familyId,
            expiresAt: row.expires_at,
            ip: context.ip,
            userAgent: context.userAgent,
          },
        );
        const newRow = inserted.records[0];
        if (newRow === undefined) {
          throw new Error("CLI refresh insert did not return a row");
        }

        return {
          kind: "rotated",
          row: toRefreshRow(newRow),
          principal: toPrincipal(principalRow),
          refreshToken,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.revokeFamily(familyId, principalId);
        return { kind: "reuse" };
      }
      throw error;
    }
  }

  /**
   * Revokes the family for a known refresh-token hash.
   *
   * An unknown or already-cleaned token is a no-op. The principal lock
   * serializes logout with an in-flight refresh so no replacement row can be
   * inserted after the logout update.
   *
   * @param refreshHash - SHA-256 of the presented token.
   */
  public async logoutByHash(refreshHash: Buffer): Promise<void> {
    const family = await this.findFamilyByHash(refreshHash);
    if (family === undefined) {
      return;
    }

    await this.#database.withTransaction(async (tx) => {
      await tx.executeQuery("SELECT id FROM principals WHERE id = :principalId FOR UPDATE", {
        principalId: family.principalId,
      });
      await this.#revokeFamilyInTransaction(tx, family.familyId, family.principalId);
    });
  }

  /**
   * Lists the principal's live CLI families, newest first.
   *
   * `createdAt` is the earliest row time in the family, so it stays stable
   * across refresh rotations. Expired and fully revoked families are omitted.
   *
   * @param principalId - Owner principal.
   * @returns One entry per live family.
   */
  public async listFamilies(principalId: string): Promise<CliFamilyEntry[]> {
    const result = await this.#database.executeQuery<{
      readonly family_id: string;
      readonly created_at: Date;
      readonly expires_at: Date;
    }>(
      `SELECT family_id,
              MIN(created_at) AS created_at,
              MIN(expires_at) AS expires_at
         FROM cli_sessions
        WHERE principal_id = :principalId
          AND family_id IN (
            SELECT family_id
              FROM cli_sessions
             WHERE principal_id = :principalId
               AND revoked_at IS NULL
               AND expires_at > now()
          )
        GROUP BY family_id
        ORDER BY MIN(created_at) DESC`,
      { principalId },
    );

    return result.records.map((row) => ({
      familyId: row.family_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  /**
   * Revokes the unexpired live rows of one owned family and reports whether
   * anything changed.
   *
   * The principal lock serializes this with rotation and login. A family that
   * is unknown, foreign, expired, or already revoked returns false and is not
   * disclosed. Expired rows are left for the retention cleanup.
   *
   * @param familyId - Public family identifier.
   * @param principalId - Owner principal.
   * @returns True when at least one live row was revoked.
   */
  public async revokeOwnedFamily(familyId: string, principalId: string): Promise<boolean> {
    return this.#database.withTransaction(async (tx) => {
      await tx.executeQuery("SELECT id FROM principals WHERE id = :principalId FOR UPDATE", {
        principalId,
      });
      const result = await tx.executeQuery<{ readonly id: string }>(
        `UPDATE cli_sessions
            SET revoked_at = now()
          WHERE family_id = :familyId
            AND principal_id = :principalId
            AND revoked_at IS NULL
            AND expires_at > now()
          RETURNING id`,
        { familyId, principalId },
      );
      return result.records.length > 0;
    });
  }

  /**
   * Revokes every live family for one principal inside an existing transaction.
   *
   * The caller must already hold the principal lock. Password change uses this
   * so the password update and family revocation commit together.
   *
   * @param database - Transaction handle that holds the principal lock.
   * @param principalId - Owner principal.
   */
  public async revokeAllForPrincipal(database: CliQuery, principalId: string): Promise<void> {
    await database.executeQuery(
      `UPDATE cli_sessions
          SET revoked_at = now()
        WHERE principal_id = :principalId
          AND revoked_at IS NULL
          AND expires_at > now()`,
      { principalId },
    );
  }

  /**
   * Deletes one bounded batch of rows past the retention window.
   *
   * A row is eligible only when the later of its expiry and revocation is more
   * than 30 days old. The batch is capped so a large backlog cannot hold a long
   * delete lock.
   *
   * @param batchSize - Maximum rows to delete.
   * @returns Number of deleted rows.
   */
  public async cleanup(batchSize: number): Promise<number> {
    const limit = Math.max(1, Math.min(10_000, Math.trunc(batchSize)));
    const result = await this.#database.executeQuery<{ readonly id: string }>(
      `DELETE FROM cli_sessions
        WHERE id IN (
          SELECT id
            FROM cli_sessions
           WHERE GREATEST(expires_at, COALESCE(revoked_at, expires_at))
                 < now() - interval '30 days'
           ORDER BY GREATEST(expires_at, COALESCE(revoked_at, expires_at))
           LIMIT :limit
        )
          AND GREATEST(expires_at, COALESCE(revoked_at, expires_at))
              < now() - interval '30 days'
        RETURNING id`,
      { limit },
    );
    return result.records.length;
  }

  /**
   * Compensates a failed issuance by revoking every unrevoked, unexpired row in
   * one family.
   *
   * This is the internal compensation and unique-race backstop, not the
   * management-route revocation. It does not report whether anything changed;
   * expired rows are left for retention cleanup. The principal lock makes the
   * revocation safe if a competing rotation is active.
   *
   * @param familyId - Public family identifier.
   * @param principalId - Owner principal.
   */
  public async revokeFamily(familyId: string, principalId: string): Promise<void> {
    await this.#database.withTransaction(async (tx) => {
      await tx.executeQuery("SELECT id FROM principals WHERE id = :principalId FOR UPDATE", {
        principalId,
      });
      await this.#revokeFamilyInTransaction(tx, familyId, principalId);
    });
  }

  async #revokeFamilyInTransaction(
    database: CliQuery,
    familyId: string,
    principalId: string,
  ): Promise<void> {
    await database.executeQuery(
      `UPDATE cli_sessions
          SET revoked_at = now()
        WHERE family_id = :familyId
          AND principal_id = :principalId
          AND revoked_at IS NULL
          AND expires_at > now()`,
      { familyId, principalId },
    );
  }
}

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

/**
 * Stores and manages CLI refresh families.
 *
 * The repository owns the SQL and transaction boundaries. A login family is
 * inserted while holding the same per-principal row lock that password change
 * takes, so a password change cannot commit between the hash recheck and the
 * insert.
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
   * Revokes every live row in one owned family.
   *
   * Used when token issuance fails after the family was inserted. The
   * operation is idempotent and does not reveal whether the family existed.
   *
   * @param familyId - Public family identifier.
   * @param principalId - Owner principal.
   */
  public async revokeFamily(familyId: string, principalId: string): Promise<void> {
    await this.#database.executeQuery(
      `UPDATE cli_sessions
          SET revoked_at = now()
        WHERE family_id = :familyId
          AND principal_id = :principalId
          AND revoked_at IS NULL`,
      { familyId, principalId },
    );
  }
}

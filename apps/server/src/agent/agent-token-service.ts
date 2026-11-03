import { createHash, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { OpenVaultConfig } from "../config/index.js";
import { IdentityServiceError } from "../identity/errors.js";
import type { QueryExecutor } from "../identity/identity-repository.js";

const TOKEN_BYTES = 32;
const MAX_TTL_SECONDS = 86_400;

/** Identity fields needed to issue a token. */
export interface TokenIdentity {
  /** Service principal identifier. */
  readonly id: string;
  /** Owner project identifier. */
  readonly projectId: string;
}

/** One issued join token. */
export interface IssuedJoinToken {
  /** Token row identifier. */
  readonly id: string;
  /** Raw 43-character base64url token, returned exactly once. */
  readonly token: string;
  /** Absolute expiry. */
  readonly expiresAt: Date;
}

/** One token row loaded by hash, including its lifecycle state. */
export interface JoinTokenRecord {
  /** Token row identifier. */
  readonly id: string;
  /** Bound service principal. */
  readonly principalId: string;
  /** Bound owner project. */
  readonly projectId: string;
  /** Absolute expiry. */
  readonly expiresAt: Date;
  /** Consumption time, or null. */
  readonly usedAt: Date | null;
  /** Revocation time, or null. */
  readonly revokedAt: Date | null;
}

/** One successfully claimed token. */
export interface ClaimedJoinToken {
  /** Token row identifier. */
  readonly id: string;
  /** Bound service principal. */
  readonly principalId: string;
  /** Bound owner project. */
  readonly projectId: string;
}

interface TokenRow {
  readonly id: string;
  readonly principal_id: string;
  readonly project_id: string;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly revoked_at: Date | null;
}

interface ClaimedTokenRow {
  readonly id: string;
  readonly principal_id: string;
  readonly project_id: string;
}

interface LockedTokenIdentity {
  readonly status: string;
  readonly owner_project_id: string;
}

interface LockedProject {
  readonly deleted_at: Date | null;
}

/**
 * Instantiates the one-time join token and owns its persistence.
 *
 * Token issuance locks the principal before checking its state, matching the
 * lock order used by join, renewal, and revocation. Only the SHA-256 digest is
 * stored; the raw token is returned once and never read back.
 */
export class AgentTokenService {
  readonly #database: PostgreSQLDatabase;
  readonly #config: Pick<OpenVaultConfig, "joinTokenTtlMs">;

  /**
   * @param options - Database and token-lifetime configuration.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly config: Pick<OpenVaultConfig, "joinTokenTtlMs">;
  }) {
    this.#database = options.database;
    this.#config = options.config;
  }

  /**
   * Issues a join token for an active service identity.
   *
   * @param identity - Principal and owner project.
   * @param ttlSeconds - Optional explicit lifetime in seconds.
   * @param createdBy - Authenticated admin principal.
   * @returns The raw token and its persisted expiry.
   * @throws {IdentityServiceError} 422 for an invalid TTL, 409 for an inactive target.
   */
  public async issue(
    identity: TokenIdentity,
    ttlSeconds: number | undefined,
    createdBy: string,
  ): Promise<IssuedJoinToken> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS)
    ) {
      throw new IdentityServiceError(422, "validation_error", "Validation failed");
    }

    const lifetimeMs = ttlSeconds === undefined ? this.#config.joinTokenTtlMs : ttlSeconds * 1_000;
    const expiresAt = new Date(Date.now() + lifetimeMs);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest();
    const id = newUlid();

    await this.#database.withTransaction(async (tx) => {
      const locked = await tx.executeQuery<LockedTokenIdentity>(
        `SELECT p.status, p.owner_project_id
           FROM principals p
          WHERE p.id = :id AND p.kind = 'service'
          FOR UPDATE OF p`,
        { id: identity.id },
      );
      const row = locked.records[0];
      if (row === undefined) {
        throw new IdentityServiceError(404, "identity_not_found", "Identity not found");
      }

      const project = await tx.executeQuery<LockedProject>(
        "SELECT deleted_at FROM projects WHERE id = :projectId FOR SHARE",
        { projectId: row.owner_project_id },
      );
      const projectRow = project.records[0];

      if (row.status !== "active" || projectRow === undefined || projectRow.deleted_at !== null) {
        throw new IdentityServiceError(409, "identity_inactive", "Identity is inactive");
      }

      await tx.executeQuery(
        `INSERT INTO join_tokens
           (id, token_hash, principal_id, project_id, expires_at, created_by)
         VALUES
           (:id, :tokenHash, :principalId, :projectId, :expiresAt, :createdBy)`,
        {
          id,
          tokenHash,
          principalId: identity.id,
          projectId: row.owner_project_id,
          expiresAt,
          createdBy,
        },
      );
    });

    return { id, token, expiresAt };
  }

  /**
   * Loads one token by its SHA-256 hash.
   *
   * Lifecycle fields are returned so the join service can make the same
   * generic decision for expired, used, and revoked tokens. The claim remains
   * the authoritative conditional check.
   *
   * @param tokenHash - 32-byte SHA-256 digest.
   * @returns The token row, or undefined.
   */
  public async findByHash(tokenHash: Buffer): Promise<JoinTokenRecord | undefined> {
    const result = await this.#database.executeQuery<TokenRow>(
      `SELECT id, principal_id, project_id, expires_at, used_at, revoked_at
         FROM join_tokens
        WHERE token_hash = :tokenHash`,
      { tokenHash },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          principalId: row.principal_id,
          projectId: row.project_id,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
          revokedAt: row.revoked_at,
        };
  }

  /**
   * Claims one unused, unexpired, unrevoked token inside a transaction.
   *
   * The conditional update is the atomic gate: only one concurrent join can
   * observe a returned row. A transaction rollback releases the claim.
   *
   * @param tx - Join transaction.
   * @param tokenHash - 32-byte SHA-256 digest.
   * @returns Claimed binding fields, or undefined.
   */
  public async claim(tx: QueryExecutor, tokenHash: Buffer): Promise<ClaimedJoinToken | undefined> {
    const result = await tx.executeQuery<ClaimedTokenRow>(
      `UPDATE join_tokens
          SET used_at = now()
        WHERE token_hash = :tokenHash
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id, principal_id, project_id`,
      { tokenHash },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : { id: row.id, principalId: row.principal_id, projectId: row.project_id };
  }

  /**
   * Revokes every unused token for a principal inside a caller transaction.
   *
   * @param tx - Revocation transaction.
   * @param principalId - Service principal identifier.
   */
  public async revokeUnused(tx: QueryExecutor, principalId: string): Promise<void> {
    await tx.executeQuery(
      `UPDATE join_tokens
          SET revoked_at = now()
        WHERE principal_id = :principalId
          AND used_at IS NULL
          AND revoked_at IS NULL`,
      { principalId },
    );
  }
}

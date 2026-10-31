import type { PrincipalStatus } from "./types.js";

/** Minimal database surface used by the credentials repository. */
export interface QueryDatabase {
  /** Executes a parameterized query and returns its records. */
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}

/** One local credential joined with its principal. */
export interface LocalCredential {
  /** Principal identifier. */
  readonly principalId: string;
  /** Display name. */
  readonly name: string;
  /** Email address, or null when absent. */
  readonly email: string | null;
  /** Whether the principal may authenticate. */
  readonly status: "active" | "disabled";
  /** Stored Argon2id PHC hash. */
  readonly passwordHash: string;
  /** True when the password must be changed before other actions. */
  readonly mustChange: boolean;
  /** Consecutive failure count. */
  readonly failedCount: number;
  /** Lock expiry, or null when not locked. */
  readonly lockedUntil: Date | null;
  /** Last credential update time. */
  readonly updatedAt: Date;
}

interface CredentialRow {
  readonly principal_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
  readonly password_hash: string;
  readonly must_change: boolean;
  readonly failed_count: number;
  readonly locked_until: Date | null;
  readonly updated_at: Date;
}

interface StatusRow {
  readonly status: string;
  readonly name: string;
  readonly email: string | null;
  readonly must_change: boolean;
}

interface FailureRow {
  readonly failed_count: number;
  readonly locked_until: Date | null;
}

function toStatus(value: string): "active" | "disabled" {
  return value === "active" ? "active" : "disabled";
}

function toCredential(row: CredentialRow): LocalCredential {
  return {
    principalId: row.principal_id,
    name: row.name,
    email: row.email,
    status: toStatus(row.status),
    passwordHash: row.password_hash,
    mustChange: row.must_change,
    failedCount: row.failed_count,
    lockedUntil: row.locked_until,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads and updates local credential state in PostgreSQL.
 *
 * The repository keeps the auth SQL in one place so the login, session, and
 * password paths share the same status and failure-counter semantics.
 */
export class CredentialsRepository {
  readonly #database: QueryDatabase;

  /**
   * @param database - Database that executes the auth queries.
   */
  public constructor(database: QueryDatabase) {
    this.#database = database;
  }

  /**
   * Loads a local credential by normalized email.
   *
   * @param identifier - Trimmed, lowercase email address.
   * @returns The credential, or `undefined`.
   */
  public async findByIdentifier(identifier: string): Promise<LocalCredential | undefined> {
    return this.#queryCredential(
      `SELECT p.id AS principal_id, p.name, p.email, p.status,
              c.password_hash, c.must_change, c.failed_count, c.locked_until, c.updated_at
         FROM principals p
         JOIN local_credentials c ON c.principal_id = p.id
        WHERE p.kind = 'user' AND lower(p.email) = :identifier`,
      { identifier },
    );
  }

  /**
   * Loads a local credential by principal id.
   *
   * @param principalId - Principal identifier.
   * @returns The credential, or `undefined`.
   */
  public async findByPrincipalId(principalId: string): Promise<LocalCredential | undefined> {
    return this.#queryCredential(
      `SELECT p.id AS principal_id, p.name, p.email, p.status,
              c.password_hash, c.must_change, c.failed_count, c.locked_until, c.updated_at
         FROM principals p
         JOIN local_credentials c ON c.principal_id = p.id
        WHERE p.id = :principalId`,
      { principalId },
    );
  }

  /**
   * Loads the status, display fields, and forced-change flag for a principal.
   *
   * @param principalId - Principal identifier.
   * @returns The principal status, or `undefined`.
   */
  public async findStatus(principalId: string): Promise<PrincipalStatus | undefined> {
    const result = await this.#database.executeQuery<StatusRow>(
      `SELECT p.status, p.name, p.email, COALESCE(c.must_change, false) AS must_change
         FROM principals p
         LEFT JOIN local_credentials c ON c.principal_id = p.id
        WHERE p.id = :principalId`,
      { principalId },
    );

    const row = result.records[0];
    if (row === undefined) {
      return undefined;
    }

    return {
      status: toStatus(row.status),
      name: row.name,
      email: row.email,
      mustChange: row.must_change,
    };
  }

  /**
   * Records one failed login atomically.
   *
   * The update resets a window older than 15 minutes, increments otherwise, and
   * sets a 15-minute lock when the new count reaches five. The statement is a
   * single atomic `UPDATE … RETURNING`, so concurrent failures cannot lose an
   * increment.
   *
   * The update is a compare-and-swap on the verified hash and is skipped while
   * the row is locked. A skipped update returns `{ failedCount: 0,
   * lockedUntil: null }`; callers only use the result for diagnostics.
   *
   * @param principalId - Principal identifier.
   * @param expectedHash - Hash that was verified for this login.
   * @returns The new failure count and lock expiry.
   */
  public async recordFailure(
    principalId: string,
    expectedHash: string,
  ): Promise<{ failedCount: number; lockedUntil: Date | null }> {
    const result = await this.#database.executeQuery<FailureRow>(
      `UPDATE local_credentials
          SET failed_count = CASE
                WHEN updated_at < now() - interval '15 minutes' THEN 1
                ELSE failed_count + 1
              END,
              locked_until = CASE
                WHEN updated_at < now() - interval '15 minutes' THEN NULL
                WHEN failed_count + 1 >= 5 THEN now() + interval '15 minutes'
                ELSE locked_until
              END,
              updated_at = now()
        WHERE principal_id = :principalId
          AND password_hash = :expectedHash
          AND (locked_until IS NULL OR locked_until <= now())
        RETURNING failed_count, locked_until`,
      { principalId, expectedHash },
    );

    const row = result.records[0];
    return row === undefined
      ? { failedCount: 0, lockedUntil: null }
      : { failedCount: row.failed_count, lockedUntil: row.locked_until };
  }

  /**
   * Resets the failure counter after a successful login.
   *
   * The update is a compare-and-swap on the verified hash and fails when the
   * row is locked, so a login that started before a concurrent password change
   * or lock cannot reset newer state.
   *
   * @param principalId - Principal identifier.
   * @param expectedHash - Hash that was verified for this login.
   * @returns True when the counter was reset.
   */
  public async recordSuccess(principalId: string, expectedHash: string): Promise<boolean> {
    const result = await this.#database.executeQuery<{ readonly principal_id: string }>(
      `UPDATE local_credentials
          SET failed_count = 0, locked_until = NULL, updated_at = now()
        WHERE principal_id = :principalId
          AND password_hash = :expectedHash
          AND (locked_until IS NULL OR locked_until <= now())
        RETURNING principal_id`,
      { principalId, expectedHash },
    );
    return result.records.length > 0;
  }

  /**
   * Stores a new password hash and clears the forced-change flag.
   *
   * The update is a compare-and-swap on the hash that was verified for the
   * change. A concurrent change that committed first wins; the stale writer
   * receives `false` and must not revoke or rotate sessions.
   *
   * @param principalId - Principal identifier.
   * @param passwordHash - New Argon2id PHC string.
   * @param expectedHash - Hash that was verified as the current password.
   * @returns True when the password was updated.
   */
  public async changePassword(
    principalId: string,
    passwordHash: string,
    expectedHash: string,
  ): Promise<boolean> {
    const result = await this.#database.executeQuery<{ readonly principal_id: string }>(
      `UPDATE local_credentials
          SET password_hash = :passwordHash,
              must_change = false,
              failed_count = 0,
              locked_until = NULL,
              updated_at = now()
        WHERE principal_id = :principalId AND password_hash = :expectedHash
        RETURNING principal_id`,
      { principalId, passwordHash, expectedHash },
    );
    return result.records.length > 0;
  }

  async #queryCredential(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<LocalCredential | undefined> {
    const result = await this.#database.executeQuery<CredentialRow>(sql, params);
    const row = result.records[0];
    return row === undefined ? undefined : toCredential(row);
  }
}

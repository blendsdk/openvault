import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PrincipalStatus } from "./types.js";

interface StatusRow {
  readonly status: string;
  readonly name: string;
  readonly email: string | null;
  readonly must_change: boolean;
}

/**
 * Reads principal authentication state from PostgreSQL.
 *
 * The repository keeps SQL in one place so the login, session, and password
 * paths share the same status and `must_change` semantics.
 */
export class CredentialsRepository {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param database - Connected PostgreSQL database.
   */
  public constructor(database: PostgreSQLDatabase) {
    this.#database = database;
  }

  /**
   * Loads the status, display fields, and forced-change flag for a principal.
   *
   * A missing row returns `undefined`; callers treat that as an invalid
   * session and fail closed.
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
      status: row.status === "active" ? "active" : "disabled",
      name: row.name,
      email: row.email,
      mustChange: row.must_change,
    };
  }
}

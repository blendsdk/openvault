import type { QueryExecutor } from "../identity/identity-repository.js";
import { PolicyUnavailableError } from "./errors.js";

interface VersionRow {
  readonly version: string | number;
}

/**
 * Persistence boundary for the policy version row.
 *
 * The full actor snapshot and assignment queries live in this class once the
 * evaluator is implemented. Keeping the version read here gives every caller
 * one fail-closed path.
 */
export class PolicyRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Reads the current policy version.
   *
   * @returns Positive integer version.
   * @throws {PolicyUnavailableError} When the row is missing or unreadable.
   */
  public async readPolicyVersion(): Promise<number> {
    let result: { readonly records: readonly VersionRow[] };
    try {
      result = await this.#database.executeQuery<VersionRow>(
        "SELECT version FROM policy_state WHERE id = 1",
      );
    } catch {
      throw new PolicyUnavailableError();
    }
    const row = result.records[0];
    if (row === undefined) {
      throw new PolicyUnavailableError();
    }
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new PolicyUnavailableError();
    }
    return version;
  }

  /**
   * Locks the policy row and increments its version.
   *
   * This must be the first statement in an assignment mutation transaction.
   * The update both serializes writers and records the policy change.
   *
   * @param database - Transaction executor.
   * @returns The new version.
   * @throws {PolicyUnavailableError} When the row is missing.
   */
  public async bumpPolicyVersion(database: QueryExecutor): Promise<number> {
    const result = await database.executeQuery<VersionRow>(
      `UPDATE policy_state
          SET version = version + 1, updated_at = now()
        WHERE id = 1
        RETURNING version`,
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new PolicyUnavailableError();
    }
    return Number(row.version);
  }
}

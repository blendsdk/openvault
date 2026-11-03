import type { PostgreSQLDatabase } from "blendsdk/postgresql";

/** Resolver for the active project named by a data-route path segment. */
export interface AgentProjectResolver {
  /** Resolves one non-deleted project by its URL name. */
  resolveActiveByName(
    name: string,
  ): Promise<{ readonly id: string; readonly name: string } | undefined>;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Reads active project names from PostgreSQL.
 *
 * Resolution is intentionally a fresh query: a soft-deleted project must stop
 * routing immediately, and project names change rarely compared with secrets.
 */
export class DatabaseProjectResolver implements AgentProjectResolver {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param database - Connected database.
   */
  public constructor(database: PostgreSQLDatabase) {
    this.#database = database;
  }

  /** @inheritDoc */
  public async resolveActiveByName(
    name: string,
  ): Promise<{ readonly id: string; readonly name: string } | undefined> {
    const result = await this.#database.executeQuery<ProjectRow>(
      `SELECT id, name
         FROM projects
        WHERE name = :name AND deleted_at IS NULL
        LIMIT 1`,
      { name },
    );
    return result.records[0];
  }
}

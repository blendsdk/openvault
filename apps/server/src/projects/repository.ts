import type { QueryExecutor } from "../identity/identity-repository.js";

/** A project list item with the active certificate count. */
export interface ProjectListRecord extends ProjectRecord {
  /** Active certificates in the project. */
  readonly certificateCount: number;
}

/** A project row used by the admin lifecycle and data-plane resolution. */
export interface ProjectRecord {
  /** Project identifier. */
  readonly id: string;
  /** Canonical project name. */
  readonly name: string;
  /** Creation time. */
  readonly createdAt: Date;
  /** Last metadata update. */
  readonly updatedAt: Date;
  /** Soft-delete time, or null. */
  readonly deletedAt: Date | null;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

interface ProjectListRow extends ProjectRow {
  readonly certificate_count: number;
}

/** Maps one database row to the public project shape. */
function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const SELECT_COLUMNS = "id, name, created_at, updated_at, deleted_at";

/**
 * Reads and mutates projects in PostgreSQL.
 *
 * Every mutation is conditional on `deleted_at IS NULL`, so a concurrent
 * delete returns no row instead of resurrecting or renaming a hidden project.
 */
export class ProjectRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Connected database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Loads one project including a soft-deleted row.
   *
   * @param executor - Database or transaction.
   * @param id - Project identifier.
   * @returns The project, or undefined.
   */
  public async findById(
    executor: QueryExecutor = this.#database,
    id: string,
  ): Promise<ProjectRecord | undefined> {
    const result = await executor.executeQuery<ProjectRow>(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE id = :id`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Loads one active project.
   *
   * @param executor - Database or transaction.
   * @param id - Project identifier.
   * @returns The active project, or undefined.
   */
  public async findActiveById(
    executor: QueryExecutor = this.#database,
    id: string,
  ): Promise<ProjectRecord | undefined> {
    const result = await executor.executeQuery<ProjectRow>(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE id = :id AND deleted_at IS NULL`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Loads one active project by name for the data plane.
   *
   * @param executor - Database or transaction.
   * @param name - Canonical project name.
   * @returns The active project, or undefined.
   */
  public async findActiveByName(
    executor: QueryExecutor = this.#database,
    name: string,
  ): Promise<ProjectRecord | undefined> {
    const result = await executor.executeQuery<ProjectRow>(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE name = :name AND deleted_at IS NULL`,
      { name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Inserts one project using the database clock.
   *
   * @param executor - Transaction.
   * @param input - Identifier and name.
   * @returns The inserted project.
   */
  public async insert(
    executor: QueryExecutor,
    input: { readonly id: string; readonly name: string },
  ): Promise<ProjectRecord> {
    const result = await executor.executeQuery<ProjectRow>(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (:id, :name, now(), now())
       RETURNING ${SELECT_COLUMNS}`,
      { id: input.id, name: input.name },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("Project insert returned no row");
    }
    return toProject(row);
  }

  /**
   * Renames one active project.
   *
   * @param executor - Transaction.
   * @param id - Project identifier.
   * @param name - New canonical name.
   * @returns The updated project, or undefined when the row is hidden.
   */
  public async rename(
    executor: QueryExecutor,
    id: string,
    name: string,
  ): Promise<ProjectRecord | undefined> {
    const result = await executor.executeQuery<ProjectRow>(
      `UPDATE projects
          SET name = :name, updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
      { id, name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Soft-deletes one active project.
   *
   * @param executor - Transaction.
   * @param id - Project identifier.
   * @returns The deleted project, or undefined when it was already hidden.
   */
  public async softDelete(executor: QueryExecutor, id: string): Promise<ProjectRecord | undefined> {
    const result = await executor.executeQuery<ProjectRow>(
      `UPDATE projects
          SET deleted_at = now(), updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Lists active projects in the caller's visibility.
   *
   * @param executor - Database.
   * @param visibility - Every project or an explicit id set.
   * @returns Active projects ordered by name.
   */
  public async listVisible(
    executor: QueryExecutor = this.#database,
    visibility: "all" | readonly string[],
  ): Promise<readonly ProjectListRecord[]> {
    if (visibility !== "all" && visibility.length === 0) {
      return [];
    }
    const condition = visibility === "all" ? "" : "AND p.id = ANY(:projectIds)";
    const result = await executor.executeQuery<ProjectListRow>(
      `SELECT p.id, p.name, p.created_at, p.updated_at, p.deleted_at,
              (SELECT count(*)::int FROM certificates c
                WHERE c.project_id = p.id AND c.deleted_at IS NULL) AS certificate_count
         FROM projects p
        WHERE p.deleted_at IS NULL ${condition}
        ORDER BY p.name ASC, p.id ASC`,
      visibility === "all" ? {} : { projectIds: [...visibility] },
    );
    return result.records.map((row) => ({
      ...toProject(row),
      certificateCount: row.certificate_count,
    }));
  }
}

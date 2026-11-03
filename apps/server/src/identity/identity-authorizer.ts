import type { QueryExecutor } from "./identity-repository.js";

/** Identity actions understood by the narrow pre-RBAC helper. */
export type IdentityAction =
  | "identity.create"
  | "identity.read"
  | "identity.revoke"
  | "identity.join_token";

interface AssignmentRow {
  readonly role: string;
  readonly scope_type: string;
  readonly scope_id: string;
}

const READ_ORG_ROLES = new Set(["org.admin", "project.admin", "auditor"]);
const READ_PROJECT_ROLES = new Set(["project.admin", "auditor"]);
const WRITE_ORG_ROLES = new Set(["org.admin", "project.admin"]);
const WRITE_PROJECT_ROLES = new Set(["project.admin"]);

function readRoles(action: IdentityAction): {
  readonly org: ReadonlySet<string>;
  readonly project: ReadonlySet<string>;
} {
  return action === "identity.read"
    ? { org: READ_ORG_ROLES, project: READ_PROJECT_ROLES }
    : { org: WRITE_ORG_ROLES, project: WRITE_PROJECT_ROLES };
}

/**
 * Resolves the identity slice of the authorization matrix until the full RBAC
 * evaluator is available.
 *
 * The helper never trusts a role name outside the scope where it is valid:
 * an org-scoped assignment covers every project; a project-scoped assignment
 * covers only that project; and a project-scoped `org.admin` is ignored.
 */
export class IdentityAuthorizer {
  readonly #database: QueryExecutor;

  /**
   * @param database - Database that stores role assignments.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Checks one action against the actor's unexpired assignments.
   *
   * @param action - Identity action.
   * @param actorId - Signed-in user principal.
   * @param projectId - Target identity owner project.
   * @returns True when the action is covered.
   */
  public async can(action: IdentityAction, actorId: string, projectId: string): Promise<boolean> {
    const assignments = await this.#assignments(actorId);
    const roles = readRoles(action);
    return assignments.some((assignment) => {
      if (assignment.scope_type === "org") {
        return roles.org.has(assignment.role);
      }
      return (
        assignment.scope_type === "project" &&
        assignment.scope_id === projectId &&
        roles.project.has(assignment.role)
      );
    });
  }

  /**
   * Reports whether the actor has any assignment for an action.
   *
   * This distinguishes an actor with no relevant role (a policy denial) from
   * an actor whose role simply does not cover the target project (a hidden
   * foreign identity).
   *
   * @param action - Identity action.
   * @param actorId - Signed-in user principal.
   * @returns True when at least one assignment covers the action somewhere.
   */
  public async hasAny(action: IdentityAction, actorId: string): Promise<boolean> {
    const assignments = await this.#assignments(actorId);
    const roles = readRoles(action);
    return assignments.some((assignment) =>
      assignment.scope_type === "org"
        ? roles.org.has(assignment.role)
        : assignment.scope_type === "project" && roles.project.has(assignment.role),
    );
  }

  /**
   * Reports whether an org-scoped read assignment covers every project.
   *
   * @param actorId - Signed-in user principal.
   * @returns True for org-scoped admin, project-admin, or auditor.
   */
  public async canReadAll(actorId: string): Promise<boolean> {
    const assignments = await this.#assignments(actorId);
    return assignments.some(
      (assignment) => assignment.scope_type === "org" && READ_ORG_ROLES.has(assignment.role),
    );
  }

  /**
   * Returns the projects covered by project-scoped read assignments.
   *
   * @param actorId - Signed-in user principal.
   * @returns Unique project identifiers.
   */
  public async readableProjectIds(actorId: string): Promise<readonly string[]> {
    const assignments = await this.#assignments(actorId);
    return [
      ...new Set(
        assignments
          .filter(
            (assignment) =>
              assignment.scope_type === "project" && READ_PROJECT_ROLES.has(assignment.role),
          )
          .map((assignment) => assignment.scope_id),
      ),
    ];
  }

  /** Loads active, unexpired assignments for an active human actor. */
  async #assignments(actorId: string): Promise<readonly AssignmentRow[]> {
    const result = await this.#database.executeQuery<AssignmentRow>(
      `SELECT r.role, r.scope_type, r.scope_id
         FROM principals p
         JOIN role_assignments r ON r.principal_id = p.id
        WHERE p.id = :actorId
          AND p.kind = 'user'
          AND p.status = 'active'
          AND (r.expires_at IS NULL OR r.expires_at > now())`,
      { actorId },
    );
    return result.records;
  }
}

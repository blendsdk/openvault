import { RBAC_ROLES, type RbacRole, type RbacScopeType } from "@openvault/api-contract";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { PolicyUnavailableError } from "./errors.js";

const ROLE_SET: ReadonlySet<string> = new Set(RBAC_ROLES);
const SCOPE_SET: ReadonlySet<string> = new Set(["org", "project", "object"]);

/**
 * SQL predicate that keeps an assignment effective only while its target is
 * reachable. Org assignments always apply. Project and object assignments
 * require a live project; an object also requires a live parent object.
 */
const LIVE_ASSIGNMENT = `(
  r.scope_type = 'org'
  OR (r.scope_type = 'project' AND EXISTS (
    SELECT 1 FROM projects ap WHERE ap.id = r.scope_id AND ap.deleted_at IS NULL
  ))
  OR (r.scope_type = 'object' AND (
    EXISTS (
      SELECT 1 FROM secrets asec
        JOIN projects ap ON ap.id = asec.project_id
       WHERE asec.id = r.scope_id AND asec.deleted_at IS NULL AND ap.deleted_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM certificates acet
        JOIN projects ap ON ap.id = acet.project_id
       WHERE acet.id = r.scope_id AND acet.deleted_at IS NULL AND ap.deleted_at IS NULL
    )
    OR (
      NOT EXISTS (SELECT 1 FROM secrets msec WHERE msec.id = r.scope_id)
      AND NOT EXISTS (SELECT 1 FROM certificates mcet WHERE mcet.id = r.scope_id)
    )
  ))
)`;

/** One assignment loaded into an actor snapshot. */
export interface ActorAssignment {
  /** Assignment row identifier. */
  readonly id: string;
  /** Fixed role. */
  readonly role: RbacRole;
  /** Assignment scope type. */
  readonly scopeType: RbacScopeType;
  /** Assignment scope identifier. */
  readonly scopeId: string;
  /** Expiry, or null for no expiry. */
  readonly expiresAt: Date | null;
}

/** The live policy state for one actor. */
export interface ActorSnapshot {
  /** Principal identifier. */
  readonly principalId: string;
  /** Principal kind. */
  readonly kind: "user" | "service";
  /** Principal status. */
  readonly status: "active" | "disabled";
  /** Current policy version. */
  readonly policyVersion: number;
  /** Every assignment, including expired rows. */
  readonly assignments: readonly ActorAssignment[];
}

interface VersionRow {
  readonly version: string | number;
}

/** One principal used by assignment and explanation flows. */
export interface PrincipalRecord {
  /** Principal identifier. */
  readonly id: string;
  /** Principal kind. */
  readonly kind: "user" | "service";
  /** Principal status. */
  readonly status: "active" | "disabled";
}

/** A project row used to validate assignment targets. */
export interface ProjectRecord {
  /** Project identifier. */
  readonly id: string;
  /** Soft-delete time, or null. */
  readonly deletedAt: Date | null;
}

/** A secret or certificate row used to validate object assignments. */
export interface ObjectRecord {
  /** Object identifier. */
  readonly id: string;
  /** Owning project identifier. */
  readonly projectId: string;
  /** Soft-delete time, or null. */
  readonly deletedAt: Date | null;
}

/** A principal row used to resolve an identity resource. */
export interface IdentityRecord {
  /** Principal identifier. */
  readonly id: string;
  /** Principal kind. */
  readonly kind: "user" | "service";
  /** Owner project for a service identity. */
  readonly ownerProjectId: string | null;
  /** Owner project soft-delete time. */
  readonly projectDeletedAt: Date | null;
}

/** One persisted assignment. */
export interface AssignmentRecord {
  /** Assignment identifier. */
  readonly id: string;
  /** Target principal. */
  readonly principalId: string;
  /** Fixed role. */
  readonly role: RbacRole;
  /** Assignment scope type. */
  readonly scopeType: RbacScopeType;
  /** Assignment scope identifier. */
  readonly scopeId: string;
  /** Granting principal. */
  readonly grantedBy: string;
  /** Creation time. */
  readonly createdAt: Date;
  /** Expiry, or null. */
  readonly expiresAt: Date | null;
  /** Target principal kind. */
  readonly principalKind: "user" | "service";
  /** Target principal status. */
  readonly principalStatus: "active" | "disabled";
}

/** One candidate row for an access explanation. */
export interface ExplainCandidateRow {
  /** Principal identifier. */
  readonly principalId: string;
  /** Principal display name. */
  readonly name: string;
  /** Principal kind. */
  readonly kind: "user" | "service";
  /** Assignment identifier, or null when the principal has no assignment. */
  readonly assignmentId: string | null;
  /** Assignment role, or null. */
  readonly role: string | null;
  /** Assignment scope type, or null. */
  readonly scopeType: string | null;
  /** Assignment scope identifier, or null. */
  readonly scopeId: string | null;
  /** Assignment expiry, or null. */
  readonly expiresAt: Date | null;
  /** Consumer compose project, or null. */
  readonly composeProject: string | null;
  /** Consumer compose service, or null. */
  readonly composeService: string | null;
  /** Consumer hostname, or null. */
  readonly hostname: string | null;
  /** Consumer state, or null. */
  readonly state: string | null;
  /** Consumer last-seen time, or null. */
  readonly lastSeen: Date | null;
}

/** Filters for the assignment list. */
export interface AssignmentFilters {
  readonly principalId?: string;
  readonly role?: string;
  readonly scopeType?: string;
  readonly scopeId?: string;
}

/** List visibility returned by the policy service. */
export type AssignmentVisibility =
  | { readonly kind: "all" }
  | { readonly kind: "projects"; readonly projectIds: readonly string[] };

interface ActorRow {
  readonly principal_id: string;
  readonly kind: string;
  readonly status: string;
  readonly policy_version: string | number | null;
  readonly assignment_id: string | null;
  readonly role: string | null;
  readonly scope_type: string | null;
  readonly scope_id: string | null;
  readonly expires_at: Date | null;
}

/** Returns true for a known role name. */
export function isRole(value: string): value is RbacRole {
  return ROLE_SET.has(value);
}

/** Returns true for a known scope type. */
export function isScopeType(value: string): value is RbacScopeType {
  return SCOPE_SET.has(value);
}

/** Returns true for a known principal kind. */
function isPrincipalKind(value: string): value is "user" | "service" {
  return value === "user" || value === "service";
}

/**
 * Persistence boundary for policy state.
 *
 * The repository returns one statement snapshot of the principal, version, and
 * assignments. It never caches between calls.
 */
export class PolicyRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /** Runs a query on the bound database and maps failures to the policy error. */
  async #query<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }> {
    return this.#execute(this.#database, query, params);
  }

  /** Runs a query on an executor and maps failures to the policy error. */
  async #execute<T>(
    executor: QueryExecutor,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }> {
    try {
      return await executor.executeQuery<T>(query, params);
    } catch {
      throw new PolicyUnavailableError();
    }
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
      result = await this.#query<VersionRow>("SELECT version FROM policy_state WHERE id = 1");
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
    let result: { readonly records: readonly VersionRow[] };
    try {
      result = await database.executeQuery<VersionRow>(
        `UPDATE policy_state
            SET version = version + 1, updated_at = now()
          WHERE id = 1
          RETURNING version`,
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
   * Loads one actor's principal state, version, and assignments.
   *
   * @param actorId - Principal identifier.
   * @returns The snapshot, or undefined when the principal does not exist.
   * @throws {PolicyUnavailableError} When the version row or query is unavailable.
   */
  public async loadActorSnapshot(actorId: string): Promise<ActorSnapshot | undefined> {
    let result: { readonly records: readonly ActorRow[] };
    try {
      result = await this.#query<ActorRow>(
        `SELECT p.id AS principal_id, p.kind, p.status,
                (SELECT version FROM policy_state WHERE id = 1) AS policy_version,
                r.id AS assignment_id, r.role, r.scope_type, r.scope_id, r.expires_at
           FROM principals p
           LEFT JOIN role_assignments r ON r.principal_id = p.id AND ${LIVE_ASSIGNMENT}
          WHERE p.id = :actorId`,
        { actorId },
      );
    } catch {
      throw new PolicyUnavailableError();
    }
    const first = result.records[0];
    if (first === undefined) {
      return undefined;
    }
    if (first.policy_version === null) {
      throw new PolicyUnavailableError();
    }
    const policyVersion = Number(first.policy_version);
    if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
      throw new PolicyUnavailableError();
    }
    if (!isPrincipalKind(first.kind)) {
      throw new PolicyUnavailableError();
    }

    const assignments: ActorAssignment[] = [];
    for (const row of result.records) {
      if (
        row.assignment_id === null ||
        row.role === null ||
        row.scope_type === null ||
        row.scope_id === null ||
        !isRole(row.role) ||
        !isScopeType(row.scope_type)
      ) {
        continue;
      }
      assignments.push({
        id: row.assignment_id,
        role: row.role,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        expiresAt: row.expires_at,
      });
    }

    return {
      principalId: first.principal_id,
      kind: first.kind,
      status: first.status === "active" ? "active" : "disabled",
      policyVersion,
      assignments,
    };
  }

  /**
   * Loads one principal.
   *
   * @param principalId - Principal identifier.
   * @returns The principal, or undefined.
   */
  public async findPrincipal(principalId: string): Promise<PrincipalRecord | undefined> {
    const result = await this.#query<{
      readonly id: string;
      readonly kind: string;
      readonly status: string;
    }>("SELECT id, kind, status FROM principals WHERE id = :principalId", { principalId });
    const row = result.records[0];
    if (row === undefined || !isPrincipalKind(row.kind)) {
      return undefined;
    }
    return { id: row.id, kind: row.kind, status: row.status === "active" ? "active" : "disabled" };
  }

  /**
   * Loads one project.
   *
   * @param projectId - Project identifier.
   * @returns The project, or undefined.
   */
  public async findProject(projectId: string): Promise<ProjectRecord | undefined> {
    const result = await this.#query<{
      readonly id: string;
      readonly deleted_at: Date | null;
    }>("SELECT id, deleted_at FROM projects WHERE id = :projectId", { projectId });
    const row = result.records[0];
    return row === undefined ? undefined : { id: row.id, deletedAt: row.deleted_at };
  }

  /**
   * Loads one secret or certificate.
   *
   * @param type - Object type.
   * @param objectId - Object identifier.
   * @returns The object, or undefined.
   */
  public async findObject(
    type: "secret" | "certificate",
    objectId: string,
  ): Promise<ObjectRecord | undefined> {
    const query =
      type === "secret"
        ? `SELECT s.id, s.project_id, s.deleted_at
             FROM secrets s
             JOIN projects p ON p.id = s.project_id
            WHERE s.id = :objectId AND s.deleted_at IS NULL AND p.deleted_at IS NULL`
        : `SELECT c.id, c.project_id, c.deleted_at
             FROM certificates c
             JOIN projects p ON p.id = c.project_id
            WHERE c.id = :objectId AND c.deleted_at IS NULL AND p.deleted_at IS NULL`;
    const result = await this.#query<{
      readonly id: string;
      readonly project_id: string;
      readonly deleted_at: Date | null;
    }>(query, { objectId });
    const row = result.records[0];
    return row === undefined
      ? undefined
      : { id: row.id, projectId: row.project_id, deletedAt: row.deleted_at };
  }

  /**
   * Loads one identity principal and its owner-project state.
   *
   * @param identityId - Principal identifier.
   * @returns The identity, or undefined.
   */
  public async findIdentity(identityId: string): Promise<IdentityRecord | undefined> {
    const result = await this.#query<{
      readonly id: string;
      readonly kind: string;
      readonly owner_project_id: string | null;
      readonly project_deleted_at: Date | null;
    }>(
      `SELECT p.id, p.kind, p.owner_project_id, pr.deleted_at AS project_deleted_at
         FROM principals p
         LEFT JOIN projects pr ON pr.id = p.owner_project_id
        WHERE p.id = :identityId`,
      { identityId },
    );
    const row = result.records[0];
    if (row === undefined || !isPrincipalKind(row.kind)) {
      return undefined;
    }
    return {
      id: row.id,
      kind: row.kind,
      ownerProjectId: row.owner_project_id,
      projectDeletedAt: row.project_deleted_at,
    };
  }

  /**
   * Loads one assignment with the target principal status.
   *
   * @param executor - Database or transaction executor.
   * @param assignmentId - Assignment identifier.
   * @returns The assignment, or undefined.
   */
  public async findAssignment(
    executor: QueryExecutor,
    assignmentId: string,
  ): Promise<AssignmentRecord | undefined> {
    const result = await this.#execute<{
      readonly id: string;
      readonly principal_id: string;
      readonly role: string;
      readonly scope_type: string;
      readonly scope_id: string;
      readonly granted_by: string;
      readonly created_at: Date;
      readonly expires_at: Date | null;
      readonly principal_kind: string;
      readonly principal_status: string;
    }>(
      executor,
      `SELECT r.id, r.principal_id, r.role, r.scope_type, r.scope_id, r.granted_by,
              r.created_at, r.expires_at, p.kind AS principal_kind,
              p.status AS principal_status
         FROM role_assignments r
         JOIN principals p ON p.id = r.principal_id
        WHERE r.id = :assignmentId AND ${LIVE_ASSIGNMENT}`,
      { assignmentId },
    );
    const row = result.records[0];
    if (row === undefined || !isRole(row.role) || !isScopeType(row.scope_type)) {
      return undefined;
    }
    return {
      id: row.id,
      principalId: row.principal_id,
      role: row.role,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      principalKind: isPrincipalKind(row.principal_kind) ? row.principal_kind : "user",
      principalStatus: row.principal_status === "active" ? "active" : "disabled",
    };
  }

  /**
   * Inserts one assignment inside a transaction.
   *
   * @param executor - Transaction executor.
   * @param input - Assignment fields.
   * @returns The inserted assignment.
   */
  public async insertAssignment(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly principalId: string;
      readonly role: RbacRole;
      readonly scopeType: RbacScopeType;
      readonly scopeId: string;
      readonly grantedBy: string;
      readonly expiresAt: Date | null;
      readonly principalKind: "user" | "service";
    },
  ): Promise<AssignmentRecord> {
    const result = await executor.executeQuery<{
      readonly id: string;
      readonly principal_id: string;
      readonly role: string;
      readonly scope_type: string;
      readonly scope_id: string;
      readonly granted_by: string;
      readonly created_at: Date;
      readonly expires_at: Date | null;
    }>(
      `INSERT INTO role_assignments
         (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
       VALUES
         (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)
       RETURNING id, principal_id, role, scope_type, scope_id, granted_by, created_at, expires_at`,
      input,
    );
    const row = result.records[0];
    if (row === undefined || !isRole(row.role) || !isScopeType(row.scope_type)) {
      throw new PolicyUnavailableError();
    }
    return {
      id: row.id,
      principalId: row.principal_id,
      role: row.role,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      principalKind: input.principalKind,
      principalStatus: "active",
    };
  }

  /**
   * Deletes one assignment inside a transaction.
   *
   * @param executor - Transaction executor.
   * @param assignmentId - Assignment identifier.
   */
  public async deleteAssignment(executor: QueryExecutor, assignmentId: string): Promise<void> {
    await this.#execute(executor, "DELETE FROM role_assignments WHERE id = :assignmentId", {
      assignmentId,
    });
  }

  /**
   * Counts active org administrators excluding one assignment.
   *
   * @param executor - Transaction executor.
   * @param excludeAssignmentId - Assignment being removed.
   * @param now - Evaluation instant used for expiry.
   * @returns Active user administrator count.
   */
  public async countActiveOrgAdmins(
    executor: QueryExecutor,
    excludeAssignmentId: string,
    now: Date,
  ): Promise<number> {
    const result = await this.#execute<{ readonly count: number }>(
      executor,
      `SELECT count(*)::int AS count
         FROM role_assignments r
         JOIN principals p ON p.id = r.principal_id
        WHERE r.role = 'org.admin'
          AND r.scope_type = 'org'
          AND r.scope_id = 'org'
          AND r.id <> :excludeAssignmentId
          AND (r.expires_at IS NULL OR r.expires_at > :now)
          AND p.status = 'active'
          AND p.kind = 'user'`,
      { excludeAssignmentId, now },
    );
    return result.records[0]?.count ?? 0;
  }

  /**
   * Lists assignments visible to one caller.
   *
   * @param visibility - All projects or a project set.
   * @param filters - Optional conjunctive filters.
   * @returns Matching assignments, newest first.
   */
  public async listAssignments(
    visibility: AssignmentVisibility,
    filters: AssignmentFilters,
  ): Promise<readonly AssignmentRecord[]> {
    if (visibility.kind === "projects" && visibility.projectIds.length === 0) {
      return [];
    }
    const conditions: string[] = [LIVE_ASSIGNMENT];
    const params: Record<string, unknown> = {};
    if (visibility.kind === "projects") {
      params.projectIds = visibility.projectIds;
      conditions.push(`(
        (r.scope_type = 'project' AND r.scope_id = ANY(:projectIds))
        OR (r.scope_type = 'object' AND (
          EXISTS (SELECT 1 FROM secrets s WHERE s.id = r.scope_id AND s.project_id = ANY(:projectIds))
          OR EXISTS (SELECT 1 FROM certificates c WHERE c.id = r.scope_id AND c.project_id = ANY(:projectIds))
        ))
      )`);
    }
    if (filters.principalId !== undefined) {
      conditions.push("r.principal_id = :principalId");
      params.principalId = filters.principalId;
    }
    if (filters.role !== undefined) {
      conditions.push("r.role = :role");
      params.role = filters.role;
    }
    if (filters.scopeType !== undefined) {
      conditions.push("r.scope_type = :scopeType");
      params.scopeType = filters.scopeType;
    }
    if (filters.scopeId !== undefined) {
      conditions.push("r.scope_id = :scopeId");
      params.scopeId = filters.scopeId;
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.#query<{
      readonly id: string;
      readonly principal_id: string;
      readonly role: string;
      readonly scope_type: string;
      readonly scope_id: string;
      readonly granted_by: string;
      readonly created_at: Date;
      readonly expires_at: Date | null;
      readonly principal_kind: string;
      readonly principal_status: string;
    }>(
      `SELECT r.id, r.principal_id, r.role, r.scope_type, r.scope_id, r.granted_by,
              r.created_at, r.expires_at, p.kind AS principal_kind,
              p.status AS principal_status
         FROM role_assignments r
         JOIN principals p ON p.id = r.principal_id
         ${where}
        ORDER BY r.created_at DESC, r.id DESC`,
      params,
    );
    const assignments: AssignmentRecord[] = [];
    for (const row of result.records) {
      if (!isRole(row.role) || !isScopeType(row.scope_type)) {
        continue;
      }
      assignments.push({
        id: row.id,
        principalId: row.principal_id,
        role: row.role,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        grantedBy: row.granted_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        principalKind: isPrincipalKind(row.principal_kind) ? row.principal_kind : "user",
        principalStatus: row.principal_status === "active" ? "active" : "disabled",
      });
    }
    return assignments;
  }

  /**
   * Loads active principals, their assignments, and consumer metadata.
   *
   * @returns The policy version and one row per principal/assignment pair.
   */
  public async listExplainCandidates(): Promise<{
    readonly policyVersion: number;
    readonly rows: readonly ExplainCandidateRow[];
  }> {
    const result = await this.#query<{
      readonly policy_version: string | number | null;
      readonly principal_id: string;
      readonly name: string;
      readonly kind: string;
      readonly assignment_id: string | null;
      readonly role: string | null;
      readonly scope_type: string | null;
      readonly scope_id: string | null;
      readonly expires_at: Date | null;
      readonly compose_project: string | null;
      readonly compose_service: string | null;
      readonly hostname: string | null;
      readonly state: string | null;
      readonly last_seen: Date | null;
    }>(
      `SELECT p.id AS principal_id, p.name, p.kind,
              (SELECT version FROM policy_state WHERE id = 1) AS policy_version,
              r.id AS assignment_id, r.role, r.scope_type, r.scope_id, r.expires_at,
              c.compose_project, c.compose_service, c.hostname, c.state, c.last_seen
         FROM principals p
         LEFT JOIN role_assignments r ON r.principal_id = p.id AND ${LIVE_ASSIGNMENT}
         LEFT JOIN consumers c ON c.principal_id = p.id
        WHERE p.status = 'active'
          AND (p.kind = 'user' OR EXISTS (
            SELECT 1 FROM projects op
             WHERE op.id = p.owner_project_id AND op.deleted_at IS NULL
          ))
        ORDER BY p.name, p.id, r.id`,
    );
    const first = result.records[0];
    const policyVersion = Number(first?.policy_version ?? 0);
    if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
      throw new PolicyUnavailableError();
    }
    const rows: ExplainCandidateRow[] = [];
    for (const row of result.records) {
      if (!isPrincipalKind(row.kind)) {
        continue;
      }
      rows.push({
        principalId: row.principal_id,
        name: row.name,
        kind: row.kind,
        assignmentId: row.assignment_id,
        role: row.role,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        expiresAt: row.expires_at,
        composeProject: row.compose_project,
        composeService: row.compose_service,
        hostname: row.hostname,
        state: row.state,
        lastSeen: row.last_seen,
      });
    }
    return { policyVersion, rows };
  }
}

import {
  type AccessExplainQuery,
  type AccessExplainResponse,
  type AssignmentCreateRequest,
  type AssignmentListQuery,
  RBAC_ROLES,
  type RbacRole,
  type RbacScopeType,
} from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { isControlPlaneAction } from "./actions.js";
import type { PolicyAuditContext, PolicyAuditPort } from "./audit.js";
import { PolicyUnavailableError, RbacServiceError } from "./errors.js";
import {
  type ActorAssignment,
  type ActorSnapshot,
  type AssignmentFilters,
  type AssignmentRecord,
  type ExplainCandidateRow,
  isRole,
  isScopeType,
  type PolicyRepository,
} from "./policy-repository.js";
import type { PolicyResource, PolicyService } from "./policy-service.js";
import { ROLE_DEFINITIONS, roleEligibleAt } from "./roles.js";

const SECRET_READER_ROLE = "secrets.reader";
const CERTIFICATE_READER_ROLE = "certificates.reader";

/** Options for {@link AssignmentService}. */
export interface AssignmentServiceOptions {
  /** Connected database for transactions. */
  readonly database: PostgreSQLDatabase;
  /** Policy persistence. */
  readonly repository: PolicyRepository;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Audit sink for mutation events. */
  readonly audit: PolicyAuditPort;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** Resource plus the scope shown in an explanation response. */
interface ResolvedExplainResource {
  readonly resource: PolicyResource;
  readonly responseScope: { readonly type: RbacScopeType; readonly id: string };
}

/** Returns true for a unique violation on the assignment tuple. */
function isDuplicateAssignment(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    Reflect.get(error, "code") === "23505" &&
    typeof Reflect.get(error, "constraint") === "string" &&
    String(Reflect.get(error, "constraint")).includes(
      "role_assignments_principal_id_role_scope_type_scope_id_key",
    )
  );
}

/** Returns true when a role contains a control-plane action. */
function roleHasControlPlane(role: RbacRole): boolean {
  return (ROLE_DEFINITIONS.get(role)?.actions ?? []).some(isControlPlaneAction);
}

/** Builds actor assignments from explanation candidate rows. */
function toActorAssignments(rows: readonly ExplainCandidateRow[]): ActorAssignment[] {
  const assignments: ActorAssignment[] = [];
  for (const row of rows) {
    if (
      row.assignmentId === null ||
      row.role === null ||
      row.scopeType === null ||
      row.scopeId === null ||
      !isRole(row.role) ||
      !isScopeType(row.scopeType)
    ) {
      continue;
    }
    assignments.push({
      id: row.assignmentId,
      role: row.role,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      expiresAt: row.expiresAt,
    });
  }
  return assignments;
}

/** Returns true for a consumer state accepted by the response contract. */
function isConsumerState(value: string | null): value is "ok" | "degraded" | "failed" {
  return value === "ok" || value === "degraded" || value === "failed";
}

/** Infers an object type from an action prefix. */
function inferObjectType(
  action: AccessExplainQuery["action"],
): "secret" | "certificate" | "identity" | undefined {
  if (action.startsWith("secret.")) {
    return "secret";
  }
  if (action.startsWith("certificate.")) {
    return "certificate";
  }
  if (action.startsWith("identity.")) {
    return "identity";
  }
  return undefined;
}

/**
 * Assignment lifecycle and access explanation.
 *
 * Every mutation updates the single policy version row before it checks grants
 * or the last-admin invariant, so concurrent changes serialize. The decision
 * and the mutation are audited exactly once each.
 */
export class AssignmentService {
  readonly #database: PostgreSQLDatabase;
  readonly #repository: PolicyRepository;
  readonly #policy: PolicyService;
  readonly #audit: PolicyAuditPort;
  readonly #now: () => number;

  /**
   * @param options - Database, repository, policy, audit, and clock.
   */
  public constructor(options: AssignmentServiceOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Creates one assignment after the five grant guards pass.
   *
   * @param actorId - Granting principal.
   * @param input - Assignment tuple and optional expiry.
   * @param context - Optional request metadata.
   * @returns The created assignment.
   * @throws {RbacServiceError} For validation, guard, or conflict failures.
   * @throws {PolicyUnavailableError} When policy or audit state is unavailable.
   */
  public async create(
    actorId: string,
    input: AssignmentCreateRequest,
    context?: PolicyAuditContext,
  ): Promise<AssignmentRecord> {
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (
      expiresAt !== null &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= this.#now())
    ) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }

    const principal = await this.#repository.findPrincipal(input.principalId);
    if (principal === undefined) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    if (!roleEligibleAt(input.role, input.scopeType)) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }

    const resource = await this.#resolveCreateResource(input);
    if (principal.kind === "service" && roleHasControlPlane(input.role)) {
      throw new RbacServiceError(
        422,
        "service_control_plane",
        "Control-plane roles cannot be granted to service identities",
      );
    }

    return this.#database.withTransaction(async (tx) => {
      const version = await this.#repository.bumpPolicyVersion(tx);
      const decision = await this.#policy.authorizeGrant(actorId, input.role, resource, context);
      const versioned = { ...decision, policyVersion: version };
      await this.#policy.recordDecision(versioned, context);
      if (!decision.allowed) {
        throw this.#grantError(decision.reason);
      }

      let created: AssignmentRecord;
      try {
        created = await this.#repository.insertAssignment(tx, {
          id: newUlid(),
          principalId: input.principalId,
          role: input.role,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          grantedBy: actorId,
          expiresAt,
        });
      } catch (error) {
        if (isDuplicateAssignment(error)) {
          throw new RbacServiceError(409, "assignment_conflict", "Assignment conflict");
        }
        throw error;
      }

      try {
        await this.#audit.recordMutation({
          actorId,
          actorKind: "user",
          action: "assignment.grant",
          assignmentId: created.id,
          targetPrincipalId: input.principalId,
          role: input.role,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          result: "allow",
          reason: "allowed",
          policyVersion: version,
          ...(context === undefined ? {} : { context }),
        });
      } catch {
        throw new PolicyUnavailableError();
      }
      return created;
    });
  }

  /**
   * Lists assignments visible to one caller.
   *
   * @param actorId - Signed-in user.
   * @param query - Optional filters.
   * @param context - Optional request metadata.
   * @returns Visible assignments, newest first.
   * @throws {RbacServiceError} When the caller cannot read assignments.
   */
  public async list(
    actorId: string,
    query: AssignmentListQuery,
    context?: PolicyAuditContext,
  ): Promise<readonly AssignmentRecord[]> {
    const requestedScope: Extract<PolicyResource, { type: "org" | "project" }> =
      query.scopeType === "project" && query.scopeId !== undefined
        ? { type: "project", id: query.scopeId }
        : { type: "org", id: "org" };
    const result = await this.#policy.authorizeList(
      actorId,
      "assignment.read",
      requestedScope,
      context,
    );
    if (!result.decision.allowed) {
      throw new RbacServiceError(403, "access_denied", "Access denied");
    }
    return this.#repository.listAssignments(result.visibility, query as AssignmentFilters);
  }

  /**
   * Deletes one assignment with hidden-resource and last-admin protection.
   *
   * @param actorId - Signed-in user.
   * @param assignmentId - Assignment identifier.
   * @param context - Optional request metadata.
   * @throws {RbacServiceError} When the assignment is hidden or protected.
   * @throws {PolicyUnavailableError} When policy or audit state is unavailable.
   */
  public async delete(
    actorId: string,
    assignmentId: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    await this.#database.withTransaction(async (tx) => {
      const version = await this.#repository.bumpPolicyVersion(tx);
      const assignment = await this.#repository.findAssignment(tx, assignmentId);
      if (assignment === undefined) {
        throw new RbacServiceError(404, "assignment_not_found", "Assignment not found");
      }
      const resource = await this.#resolveDeleteResource(assignment);
      const decision = await this.#policy.authorize(
        actorId,
        "assignment.write",
        resource,
        context,
        { audit: false },
      );
      if (!decision.allowed) {
        await this.#policy.recordDecision({ ...decision, policyVersion: version }, context);
        throw new RbacServiceError(404, "assignment_not_found", "Assignment not found");
      }

      const expiresAt = assignment.expiresAt;
      const active =
        assignment.role === "org.admin" &&
        assignment.scopeType === "org" &&
        assignment.principalStatus === "active" &&
        (expiresAt === null || expiresAt.getTime() > this.#now());
      if (active) {
        const others = await this.#repository.countActiveOrgAdmins(tx, assignmentId);
        if (others === 0) {
          await this.#policy.recordDecision(
            {
              ...decision,
              allowed: false,
              reason: "last_org_admin",
              policyVersion: version,
            },
            context,
          );
          throw new RbacServiceError(
            409,
            "last_org_admin",
            "Cannot remove the last organization administrator",
          );
        }
      }

      await this.#policy.recordDecision({ ...decision, policyVersion: version }, context);
      await this.#repository.deleteAssignment(tx, assignmentId);
      try {
        await this.#audit.recordMutation({
          actorId,
          actorKind: "user",
          action: "assignment.revoke",
          assignmentId,
          targetPrincipalId: assignment.principalId,
          role: assignment.role,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeId,
          result: "allow",
          reason: "allowed",
          policyVersion: version,
          ...(context === undefined ? {} : { context }),
        });
      } catch {
        throw new PolicyUnavailableError();
      }
    });
  }

  /**
   * Explains who holds an action on one resource.
   *
   * @param actorId - Signed-in user with `assignment.read`.
   * @param query - Action and resource.
   * @param context - Optional request metadata.
   * @returns Effective principals, roles, assignments, and consumers.
   * @throws {RbacServiceError} For invalid, missing, or hidden resources.
   */
  public async explain(
    actorId: string,
    query: AccessExplainQuery,
    context?: PolicyAuditContext,
  ): Promise<AccessExplainResponse> {
    const resolved = await this.#resolveExplainResource(query);
    const decision = await this.#policy.authorize(
      actorId,
      "assignment.read",
      resolved.resource,
      context,
    );
    if (!decision.allowed) {
      throw new RbacServiceError(404, "resource_not_found", "Resource not found");
    }

    const candidates = await this.#repository.listExplainCandidates();
    const groups = new Map<string, ExplainCandidateRow[]>();
    for (const row of candidates) {
      const group = groups.get(row.principalId) ?? [];
      group.push(row);
      groups.set(row.principalId, group);
    }

    const principals: AccessExplainResponse["principals"] = [];
    for (const [principalId, rows] of groups) {
      const first = rows[0];
      if (first === undefined) {
        continue;
      }
      const snapshot: ActorSnapshot = {
        principalId,
        kind: first.kind,
        status: "active",
        policyVersion: decision.policyVersion,
        assignments: toActorAssignments(rows),
      };
      const matches = this.#policy.matchingAssignments(snapshot, query.action, resolved.resource);
      if (matches.length === 0) {
        continue;
      }
      const state = isConsumerState(first.state) ? first.state : null;
      const consumer =
        first.composeProject === null ||
        first.composeService === null ||
        first.hostname === null ||
        first.lastSeen === null ||
        state === null
          ? null
          : {
              composeProject: first.composeProject,
              composeService: first.composeService,
              hostname: first.hostname,
              state,
              lastSeen: first.lastSeen.toISOString(),
            };
      for (const match of matches) {
        principals.push({
          principalId,
          name: first.name,
          kind: first.kind,
          role: match.role,
          assignmentId: match.id,
          scopeType: match.scopeType,
          scopeId: match.scopeId,
          consumer,
        });
      }
    }

    principals.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.principalId.localeCompare(right.principalId) ||
        left.assignmentId.localeCompare(right.assignmentId),
    );
    return {
      policyVersion: decision.policyVersion,
      action: query.action,
      scope: resolved.responseScope,
      principals,
    };
  }

  /** Resolves a create target and validates project/object existence. */
  async #resolveCreateResource(input: AssignmentCreateRequest): Promise<PolicyResource> {
    if (input.scopeType === "org") {
      if (input.scopeId !== "org") {
        throw new RbacServiceError(422, "validation_error", "Validation failed");
      }
      return { type: "org", id: "org" };
    }
    if (input.scopeType === "project") {
      const project = await this.#repository.findProject(input.scopeId);
      if (project === undefined || project.deletedAt !== null) {
        throw new RbacServiceError(422, "validation_error", "Validation failed");
      }
      return { type: "project", id: input.scopeId };
    }

    const objectType =
      input.role === SECRET_READER_ROLE
        ? "secret"
        : input.role === CERTIFICATE_READER_ROLE
          ? "certificate"
          : undefined;
    if (objectType === undefined) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    const object = await this.#repository.findObject(objectType, input.scopeId);
    if (object === undefined || object.deletedAt !== null) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    return objectType === "secret"
      ? { type: "secret", id: object.id, projectId: object.projectId }
      : { type: "certificate", id: object.id, projectId: object.projectId };
  }

  /** Resolves the resource for an existing assignment, falling back to org. */
  async #resolveDeleteResource(assignment: AssignmentRecord): Promise<PolicyResource> {
    if (assignment.scopeType === "org") {
      return { type: "org", id: "org" };
    }
    if (assignment.scopeType === "project") {
      return { type: "project", id: assignment.scopeId };
    }
    const objectType = assignment.role === SECRET_READER_ROLE ? "secret" : "certificate";
    const object = await this.#repository.findObject(objectType, assignment.scopeId);
    if (object === undefined) {
      return { type: "org", id: "org" };
    }
    return objectType === "secret"
      ? { type: "secret", id: object.id, projectId: object.projectId }
      : { type: "certificate", id: object.id, projectId: object.projectId };
  }

  /** Resolves an explanation resource and validates visibility prerequisites. */
  async #resolveExplainResource(query: AccessExplainQuery): Promise<ResolvedExplainResource> {
    const scopeType = query.scopeType ?? "org";
    const dataPlane = query.action.startsWith("secret.") || query.action.startsWith("certificate.");
    if (dataPlane && scopeType === "org") {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    if (scopeType === "org") {
      return {
        resource: { type: "org", id: "org" },
        responseScope: { type: "org", id: "org" },
      };
    }
    if (scopeType === "project") {
      if (query.scopeId === undefined) {
        throw new RbacServiceError(422, "validation_error", "Validation failed");
      }
      const project = await this.#repository.findProject(query.scopeId);
      if (project === undefined || project.deletedAt !== null) {
        throw new RbacServiceError(404, "resource_not_found", "Resource not found");
      }
      return {
        resource: { type: "project", id: project.id },
        responseScope: { type: "project", id: project.id },
      };
    }

    if (query.scopeId === undefined) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    const inferred = inferObjectType(query.action);
    if (query.objectType !== undefined && inferred !== undefined && query.objectType !== inferred) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    const objectType = query.objectType ?? inferred;
    if (objectType === undefined) {
      throw new RbacServiceError(422, "validation_error", "Validation failed");
    }
    if (objectType === "identity") {
      const identity = await this.#repository.findIdentity(query.scopeId);
      if (identity === undefined || identity.projectDeletedAt !== null) {
        throw new RbacServiceError(404, "resource_not_found", "Resource not found");
      }
      if (identity.ownerProjectId === null) {
        return {
          resource: { type: "identity", id: identity.id },
          responseScope: { type: "org", id: "org" },
        };
      }
      return {
        resource: { type: "identity", id: identity.id, projectId: identity.ownerProjectId },
        responseScope: { type: "project", id: identity.ownerProjectId },
      };
    }

    const object = await this.#repository.findObject(objectType, query.scopeId);
    if (object === undefined || object.deletedAt !== null) {
      throw new RbacServiceError(404, "resource_not_found", "Resource not found");
    }
    return objectType === "secret"
      ? {
          resource: { type: "secret", id: object.id, projectId: object.projectId },
          responseScope: { type: "object", id: object.id },
        }
      : {
          resource: { type: "certificate", id: object.id, projectId: object.projectId },
          responseScope: { type: "object", id: object.id },
        };
  }

  /** Maps a mutable grant denial to the public error family. */
  #grantError(reason: string): RbacServiceError {
    if (reason === "service_control_plane") {
      return new RbacServiceError(
        422,
        "service_control_plane",
        "Control-plane roles cannot be granted to service identities",
      );
    }
    if (reason === "invalid_scope") {
      return new RbacServiceError(422, "validation_error", "Validation failed");
    }
    return new RbacServiceError(403, "access_denied", "Access denied");
  }
}

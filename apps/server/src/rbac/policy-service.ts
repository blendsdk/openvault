import {
  type CapabilityFlags,
  RBAC_ACTIONS,
  RBAC_ROLES,
  type RbacAction,
  type RbacRole,
  type RbacScopeType,
  type RoleCatalog,
} from "@openvault/api-contract";
import { ACTION_DEFINITIONS, isControlPlaneAction } from "./actions.js";
import type { PolicyAuditContext, PolicyAuditPort, PolicyDecisionEvent } from "./audit.js";
import { PolicyUnavailableError } from "./errors.js";
import type { ActorAssignment, ActorSnapshot, PolicyRepository } from "./policy-repository.js";
import type { DecisionReason } from "./reasons.js";
import { ROLE_DEFINITIONS, roleEligibleAt, roleHasAction } from "./roles.js";

/** A resource whose authorization is being decided. */
export type PolicyResource =
  | { readonly type: "org"; readonly id: "org" }
  | { readonly type: "project"; readonly id: string }
  | { readonly type: "identity"; readonly id: string; readonly projectId?: string }
  | { readonly type: "secret"; readonly id: string; readonly projectId: string }
  | { readonly type: "certificate"; readonly id: string; readonly projectId: string };

/** One assignment that grants a decision. */
export interface PolicyAssignmentMatch {
  /** Assignment row identifier. */
  readonly id: string;
  /** Fixed role. */
  readonly role: RbacRole;
  /** Assignment scope type. */
  readonly scopeType: RbacScopeType;
  /** Assignment scope identifier. */
  readonly scopeId: string;
}

/** The result of one authorization decision. */
export interface PolicyDecision {
  /** Whether the action is allowed. */
  readonly allowed: boolean;
  /** Stable reason code. */
  readonly reason: DecisionReason;
  /** Policy version used for the decision. */
  readonly policyVersion: number;
  /** Actor principal identifier. */
  readonly actorId: string;
  /** Actor kind. */
  readonly actorKind: "user" | "service";
  /** Evaluated action. */
  readonly action: RbacAction;
  /** Evaluated resource. */
  readonly resource: PolicyResource;
  /** Decision scope; `system` is used by any-scope checks. */
  readonly scope: { readonly type: RbacScopeType | "system"; readonly id: string | null };
  /** Assignment that granted the action, or null. */
  readonly assignment: PolicyAssignmentMatch | null;
}

/** List visibility for a collection route. */
export interface PolicyListDecision {
  /** The list decision. */
  readonly decision: PolicyDecision;
  /** Projects the caller may list, or all projects. */
  readonly visibility:
    | { readonly kind: "all" }
    | { readonly kind: "projects"; readonly projectIds: readonly string[] };
}

/** Options for {@link PolicyService}. */
export interface PolicyServiceOptions {
  /** Policy persistence. */
  readonly repository: PolicyRepository;
  /** Audit sink. */
  readonly audit: PolicyAuditPort;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** Controls whether a decision is written to the audit sink. */
export interface AuthorizeOptions {
  /** Set false when the caller records one composite decision itself. */
  readonly audit?: boolean;
}

const SECRET_CAPABILITIES = {
  canRead: "secret.read",
  canWrite: "secret.write",
  canDelete: "secret.delete",
  canPurge: "secret.purge",
  canManage: "assignment.write",
} as const;

const CERTIFICATE_CAPABILITIES = {
  canRead: "certificate.read",
  canWrite: "certificate.write",
  canDelete: "certificate.delete",
  canPurge: "certificate.purge",
  canManage: "assignment.write",
} as const;

/** Returns true when an assignment is unexpired. */
function isActive(assignment: ActorAssignment, now: number): boolean {
  return assignment.expiresAt === null || assignment.expiresAt.getTime() > now;
}

/** Returns the scope type represented by a resource. */
function resourceScopeType(resource: PolicyResource): RbacScopeType {
  switch (resource.type) {
    case "org":
      return "org";
    case "project":
      return "project";
    case "identity":
      return resource.projectId === undefined ? "org" : "project";
    case "secret":
    case "certificate":
      return "object";
  }
}

/** Returns the project that owns a resource, when it has one. */
function resourceProjectId(resource: PolicyResource): string | undefined {
  switch (resource.type) {
    case "org":
      return undefined;
    case "project":
      return resource.id;
    case "identity":
    case "secret":
    case "certificate":
      return resource.projectId;
  }
}

/** Returns the audit scope for a resource. */
function resourceScope(resource: PolicyResource): { type: RbacScopeType; id: string } {
  switch (resource.type) {
    case "org":
      return { type: "org", id: "org" };
    case "project":
      return { type: "project", id: resource.id };
    case "identity":
      return resource.projectId === undefined
        ? { type: "org", id: "org" }
        : { type: "project", id: resource.projectId };
    case "secret":
    case "certificate":
      return { type: "project", id: resource.projectId };
  }
}

/** Returns true when an assignment's scope covers a resource. */
function assignmentCovers(assignment: ActorAssignment, resource: PolicyResource): boolean {
  if (assignment.scopeType === "org") {
    return true;
  }
  if (assignment.scopeType === "project") {
    if (resource.type === "project") {
      return assignment.scopeId === resource.id;
    }
    return resourceProjectId(resource) === assignment.scopeId;
  }
  if (assignment.scopeId !== resource.id) {
    return false;
  }
  if (resource.type === "secret") {
    return assignment.role === "secrets.reader";
  }
  if (resource.type === "certificate") {
    return assignment.role === "certificates.reader";
  }
  return false;
}

/** Orders assignments from most to least specific. */
function scopeRank(scope: RbacScopeType): number {
  return scope === "object" ? 0 : scope === "project" ? 1 : 2;
}

/** Returns the first matching assignment in specificity order. */
function mostSpecific(matches: readonly ActorAssignment[]): ActorAssignment | undefined {
  return [...matches].sort(
    (left, right) =>
      scopeRank(left.scopeType) - scopeRank(right.scopeType) || left.id.localeCompare(right.id),
  )[0];
}

/**
 * The policy decision engine.
 *
 * Every call loads a fresh actor snapshot and evaluates against the current
 * version. The service holds no decision cache, so revocation is immediate.
 */
export class PolicyService {
  readonly #repository: PolicyRepository;
  readonly #audit: PolicyAuditPort;
  readonly #now: () => number;

  /**
   * @param options - Repository, audit sink, and clock seam.
   */
  public constructor(options: PolicyServiceOptions) {
    this.#repository = options.repository;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Evaluates one action against one resource.
   *
   * @param actorId - Principal identifier.
   * @param action - Fixed action.
   * @param resource - Target resource.
   * @param context - Optional request metadata.
   * @param options - Audit control.
   * @returns The decision.
   * @throws {PolicyUnavailableError} When policy state or audit is unavailable.
   */
  public async authorize(
    actorId: string,
    action: RbacAction,
    resource: PolicyResource,
    context?: PolicyAuditContext,
    options: AuthorizeOptions = {},
  ): Promise<PolicyDecision> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    const now = this.#now();
    const decision =
      snapshot === undefined
        ? this.#unknownPrincipalDecision(
            actorId,
            action,
            resource,
            await this.#repository.readPolicyVersion(),
          )
        : this.#evaluate(snapshot, action, resource, now);
    if (options.audit !== false) {
      await this.recordDecision(decision, context);
    }
    return decision;
  }

  /**
   * Evaluates a collection route and returns its visibility.
   *
   * @param actorId - Principal identifier.
   * @param action - Fixed action.
   * @param requestedScope - Requested org or project scope.
   * @param context - Optional request metadata.
   * @returns The decision and list visibility.
   * @throws {PolicyUnavailableError} When policy state or audit is unavailable.
   */
  public async authorizeList(
    actorId: string,
    action: RbacAction,
    requestedScope: Extract<PolicyResource, { type: "org" | "project" }>,
    context?: PolicyAuditContext,
  ): Promise<PolicyListDecision> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    if (snapshot === undefined) {
      const decision = this.#unknownPrincipalDecision(
        actorId,
        action,
        requestedScope,
        await this.#repository.readPolicyVersion(),
      );
      await this.recordDecision(decision, context);
      return { decision, visibility: { kind: "projects", projectIds: [] } };
    }
    if (snapshot.status !== "active") {
      return this.#denyList(snapshot, action, requestedScope, "inactive_principal", context);
    }
    if (snapshot.kind === "service" && isControlPlaneAction(action)) {
      return this.#denyList(snapshot, action, requestedScope, "service_control_plane", context);
    }

    const now = this.#now();
    const relevant = snapshot.assignments.filter(
      (assignment) =>
        roleEligibleAt(assignment.role, assignment.scopeType) &&
        roleHasAction(assignment.role, action),
    );
    const active = relevant.filter((assignment) => isActive(assignment, now));
    const orgAssignment = active.find((assignment) => assignment.scopeType === "org");
    const projectIds = [
      ...new Set(
        active
          .filter((assignment) => assignment.scopeType === "project")
          .map((assignment) => assignment.scopeId),
      ),
    ];

    if (orgAssignment !== undefined) {
      const decision = this.#allow(snapshot, action, requestedScope, orgAssignment, {
        type: "org",
        id: "org",
      });
      await this.recordDecision(decision, context);
      return { decision, visibility: { kind: "all" } };
    }

    if (projectIds.length > 0) {
      if (requestedScope.type === "project" && !projectIds.includes(requestedScope.id)) {
        return this.#denyList(snapshot, action, requestedScope, "scope_mismatch", context);
      }
      const first = requestedScope.type === "project" ? requestedScope.id : projectIds[0];
      const selected = active.find(
        (candidate) => candidate.scopeType === "project" && candidate.scopeId === first,
      );
      if (first === undefined || selected === undefined) {
        return this.#denyList(snapshot, action, requestedScope, "scope_mismatch", context);
      }
      const decision = this.#allow(snapshot, action, { type: "project", id: first }, selected, {
        type: "project",
        id: first,
      });
      await this.recordDecision(decision, context);
      return { decision, visibility: { kind: "projects", projectIds } };
    }

    const expired = relevant.some((assignment) => !isActive(assignment, now));
    return this.#denyList(
      snapshot,
      action,
      requestedScope,
      expired ? "expired_assignment" : "no_assignment",
      context,
    );
  }

  /**
   * Evaluates the five grant guards without auditing.
   *
   * The caller records one composite decision after all guards pass or fail.
   *
   * @param actorId - Granting principal.
   * @param role - Role being granted.
   * @param resource - Target scope resource.
   * @param _context - Reserved for symmetry with future audit-aware callers.
   * @returns The composite decision.
   * @throws {PolicyUnavailableError} When policy state is unavailable.
   */
  public async authorizeGrant(
    actorId: string,
    role: RbacRole,
    resource: PolicyResource,
    _context?: PolicyAuditContext,
  ): Promise<PolicyDecision> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    if (snapshot === undefined) {
      return this.#unknownPrincipalDecision(
        actorId,
        "assignment.write",
        resource,
        await this.#repository.readPolicyVersion(),
      );
    }
    if (snapshot.status !== "active") {
      return this.#deny(snapshot, "assignment.write", resource, "inactive_principal");
    }
    if (snapshot.kind === "service") {
      return this.#deny(snapshot, "assignment.write", resource, "service_control_plane");
    }
    if (!roleEligibleAt(role, resourceScopeType(resource))) {
      return this.#deny(snapshot, "assignment.write", resource, "invalid_scope");
    }

    const now = this.#now();
    const effective = this.#effectiveActions(snapshot, resource, now);
    const write = effective.get("assignment.write");
    if (write === undefined) {
      return this.#deny(snapshot, "assignment.write", resource, "grant_scope_not_covered", null);
    }
    if (
      role === "org.admin" &&
      !snapshot.assignments.some(
        (assignment) =>
          assignment.role === "org.admin" &&
          assignment.scopeType === "org" &&
          isActive(assignment, now),
      )
    ) {
      return this.#deny(snapshot, "assignment.write", resource, "grant_org_admin_forbidden", write);
    }
    const targetActions = ROLE_DEFINITIONS.get(role)?.actions ?? [];
    if (targetActions.some((action) => !effective.has(action))) {
      return this.#deny(snapshot, "assignment.write", resource, "grant_role_not_subset", write);
    }
    return this.#allow(snapshot, "assignment.write", resource, write, resourceScope(resource));
  }

  /**
   * Answers whether the actor holds an action at any eligible scope.
   *
   * @param actorId - Principal identifier.
   * @param action - Fixed action.
   * @param context - Optional request metadata.
   * @returns A system-scope decision.
   * @throws {PolicyUnavailableError} When policy state or audit is unavailable.
   */
  public async hasAny(
    actorId: string,
    action: RbacAction,
    context?: PolicyAuditContext,
  ): Promise<PolicyDecision> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    const systemScope = { type: "system", id: null } as const;
    if (snapshot === undefined) {
      const decision = this.#unknownPrincipalDecision(
        actorId,
        action,
        { type: "org", id: "org" },
        await this.#repository.readPolicyVersion(),
        systemScope,
      );
      await this.recordDecision(decision, context);
      return decision;
    }
    const now = this.#now();
    let decision: PolicyDecision;
    if (snapshot.status !== "active") {
      decision = this.#deny(
        snapshot,
        action,
        { type: "org", id: "org" },
        "inactive_principal",
        null,
        systemScope,
      );
    } else if (snapshot.kind === "service" && isControlPlaneAction(action)) {
      decision = this.#deny(
        snapshot,
        action,
        { type: "org", id: "org" },
        "service_control_plane",
        null,
        systemScope,
      );
    } else {
      const relevant = snapshot.assignments.filter(
        (assignment) =>
          roleEligibleAt(assignment.role, assignment.scopeType) &&
          roleHasAction(assignment.role, action),
      );
      const active = relevant.filter((assignment) => isActive(assignment, now));
      const first = active[0];
      if (first !== undefined) {
        decision = this.#allow(snapshot, action, { type: "org", id: "org" }, first, systemScope);
      } else if (relevant.length > 0) {
        decision = this.#deny(
          snapshot,
          action,
          { type: "org", id: "org" },
          "expired_assignment",
          null,
          systemScope,
        );
      } else {
        decision = this.#deny(
          snapshot,
          action,
          { type: "org", id: "org" },
          "no_assignment",
          null,
          systemScope,
        );
      }
    }
    await this.recordDecision(decision, context);
    return decision;
  }

  /**
   * Projects the five capability flags without auditing.
   *
   * @param actorId - Principal identifier.
   * @param resource - Secret or certificate resource.
   * @returns Capability flags.
   * @throws {PolicyUnavailableError} When policy state is unavailable.
   */
  public async capabilitiesFor(
    actorId: string,
    resource: Extract<PolicyResource, { type: "secret" | "certificate" }>,
  ): Promise<CapabilityFlags> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    if (snapshot === undefined || snapshot.status !== "active") {
      return {
        canRead: false,
        canWrite: false,
        canDelete: false,
        canPurge: false,
        canManage: false,
      };
    }
    const mapping = resource.type === "secret" ? SECRET_CAPABILITIES : CERTIFICATE_CAPABILITIES;
    const now = this.#now();
    return {
      canRead: this.#evaluate(snapshot, mapping.canRead, resource, now).allowed,
      canWrite: this.#evaluate(snapshot, mapping.canWrite, resource, now).allowed,
      canDelete: this.#evaluate(snapshot, mapping.canDelete, resource, now).allowed,
      canPurge: this.#evaluate(snapshot, mapping.canPurge, resource, now).allowed,
      canManage: this.#evaluate(snapshot, mapping.canManage, resource, now).allowed,
    };
  }

  /**
   * Returns the distinct project ids where an actor holds an action.
   *
   * This is a non-auditing projection for identity list filtering.
   *
   * @param actorId - Principal identifier.
   * @param action - Fixed action.
   * @returns Project identifiers.
   * @throws {PolicyUnavailableError} When policy state is unavailable.
   */
  public async readableProjectIds(actorId: string, action: RbacAction): Promise<readonly string[]> {
    const snapshot = await this.#repository.loadActorSnapshot(actorId);
    if (
      snapshot === undefined ||
      snapshot.status !== "active" ||
      (snapshot.kind === "service" && isControlPlaneAction(action))
    ) {
      return [];
    }
    const now = this.#now();
    return [
      ...new Set(
        snapshot.assignments
          .filter(
            (assignment) =>
              assignment.scopeType === "project" &&
              roleEligibleAt(assignment.role, assignment.scopeType) &&
              roleHasAction(assignment.role, action) &&
              isActive(assignment, now),
          )
          .map((assignment) => assignment.scopeId),
      ),
    ];
  }

  /**
   * Builds the public role and action catalog.
   *
   * @returns The catalog and current policy version.
   * @throws {PolicyUnavailableError} When the version row is unavailable.
   */
  public async catalog(): Promise<RoleCatalog> {
    const policyVersion = await this.#repository.readPolicyVersion();
    return {
      actions: RBAC_ACTIONS.map((action) => ({
        name: action,
        plane: ACTION_DEFINITIONS.get(action)?.plane ?? "data",
        description: ACTION_DEFINITIONS.get(action)?.description ?? action,
      })),
      roles: RBAC_ROLES.map((role) => ({
        name: role,
        actions: [...(ROLE_DEFINITIONS.get(role)?.actions ?? [])],
        scopes: [...(ROLE_DEFINITIONS.get(role)?.scopes ?? [])],
      })),
      policyVersion,
    };
  }

  /**
   * Records one decision through the audit port.
   *
   * @param decision - Decision to record.
   * @param context - Optional request metadata.
   * @throws {PolicyUnavailableError} When the audit port rejects.
   */
  public async recordDecision(
    decision: PolicyDecision,
    context?: PolicyAuditContext,
  ): Promise<void> {
    try {
      await this.#audit.recordDecision(this.#toEvent(decision, context));
    } catch {
      throw new PolicyUnavailableError();
    }
  }

  /** Evaluates one action against one resource without auditing. */
  #evaluate(
    snapshot: ActorSnapshot,
    action: RbacAction,
    resource: PolicyResource,
    now: number,
  ): PolicyDecision {
    if (snapshot.status !== "active") {
      return this.#deny(snapshot, action, resource, "inactive_principal");
    }
    if (snapshot.kind === "service" && isControlPlaneAction(action)) {
      return this.#deny(snapshot, action, resource, "service_control_plane");
    }

    const actionAssignments = snapshot.assignments.filter((assignment) =>
      roleHasAction(assignment.role, action),
    );
    const relevant = actionAssignments.filter((assignment) =>
      roleEligibleAt(assignment.role, assignment.scopeType),
    );
    const matching = relevant.filter(
      (assignment) => isActive(assignment, now) && assignmentCovers(assignment, resource),
    );
    const selected = mostSpecific(matching);
    if (selected !== undefined) {
      return this.#allow(snapshot, action, resource, selected, resourceScope(resource));
    }
    const expiredMatch = relevant.some(
      (assignment) => !isActive(assignment, now) && assignmentCovers(assignment, resource),
    );
    if (expiredMatch) {
      return this.#deny(snapshot, action, resource, "expired_assignment");
    }
    if (actionAssignments.length > 0) {
      return this.#deny(snapshot, action, resource, "scope_mismatch");
    }
    return this.#deny(snapshot, action, resource, "no_assignment");
  }

  /** Computes every allowed action for one resource. */
  #effectiveActions(
    snapshot: ActorSnapshot,
    resource: PolicyResource,
    now: number,
  ): ReadonlyMap<RbacAction, ActorAssignment> {
    const effective = new Map<RbacAction, ActorAssignment>();
    for (const action of RBAC_ACTIONS) {
      const matching = snapshot.assignments.filter(
        (assignment) =>
          roleEligibleAt(assignment.role, assignment.scopeType) &&
          roleHasAction(assignment.role, action) &&
          isActive(assignment, now) &&
          assignmentCovers(assignment, resource),
      );
      const selected = mostSpecific(matching);
      if (selected !== undefined) {
        effective.set(action, selected);
      }
    }
    return effective;
  }

  /** Builds an allow decision. */
  #allow(
    snapshot: ActorSnapshot,
    action: RbacAction,
    resource: PolicyResource,
    assignment: ActorAssignment,
    scope: { type: RbacScopeType | "system"; id: string | null },
  ): PolicyDecision {
    return {
      allowed: true,
      reason: "allowed",
      policyVersion: snapshot.policyVersion,
      actorId: snapshot.principalId,
      actorKind: snapshot.kind,
      action,
      resource,
      scope,
      assignment: {
        id: assignment.id,
        role: assignment.role,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      },
    };
  }

  /** Builds a denial decision. */
  #deny(
    snapshot: ActorSnapshot,
    action: RbacAction,
    resource: PolicyResource,
    reason: DecisionReason,
    assignment: ActorAssignment | null = null,
    scope: { readonly type: RbacScopeType | "system"; readonly id: string | null } = resourceScope(
      resource,
    ),
  ): PolicyDecision {
    return {
      allowed: false,
      reason,
      policyVersion: snapshot.policyVersion,
      actorId: snapshot.principalId,
      actorKind: snapshot.kind,
      action,
      resource,
      scope,
      assignment:
        assignment === null
          ? null
          : {
              id: assignment.id,
              role: assignment.role,
              scopeType: assignment.scopeType,
              scopeId: assignment.scopeId,
            },
    };
  }

  /** Builds a list denial and records it. */
  async #denyList(
    snapshot: ActorSnapshot,
    action: RbacAction,
    requestedScope: Extract<PolicyResource, { type: "org" | "project" }>,
    reason: DecisionReason,
    context?: PolicyAuditContext,
  ): Promise<PolicyListDecision> {
    const decision = this.#deny(snapshot, action, requestedScope, reason);
    await this.recordDecision(decision, context);
    return { decision, visibility: { kind: "projects", projectIds: [] } };
  }

  /** Builds an unknown-principal decision after reading the version. */
  #unknownPrincipalDecision(
    actorId: string,
    action: RbacAction,
    resource: PolicyResource,
    policyVersion: number,
    scope: { readonly type: RbacScopeType | "system"; readonly id: string | null } = resourceScope(
      resource,
    ),
  ): PolicyDecision {
    return {
      allowed: false,
      reason: "unknown_principal",
      policyVersion,
      actorId,
      actorKind: "user",
      action,
      resource,
      scope,
      assignment: null,
    };
  }

  /** Builds the audit event for one decision. */
  #toEvent(decision: PolicyDecision, context?: PolicyAuditContext): PolicyDecisionEvent {
    const system = decision.scope.type === "system";
    const objectType =
      system || decision.resource.type === "org"
        ? null
        : decision.resource.type === "project"
          ? "project"
          : decision.resource.type;
    const objectId = system || decision.resource.type === "org" ? null : decision.resource.id;
    return {
      actorId: decision.actorId,
      actorKind: decision.actorKind,
      action: decision.action,
      scopeType: decision.scope.type,
      scopeId: decision.scope.id,
      objectType,
      objectId,
      result: decision.allowed ? "allow" : "deny",
      reason: decision.reason,
      policyVersion: decision.policyVersion,
      ...(context === undefined ? {} : { context }),
    };
  }
}

import type {
  Assignment,
  IdentitySummary,
  JoinTokenResponse,
  ScaffoldAssignment,
  ScaffoldRequest,
  ScaffoldResponse,
} from "@openvault/api-contract";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { IdentityServiceError } from "../identity/errors.js";
import type { IdentityService } from "../identity/identity-service.js";
import { ProjectServiceError } from "../projects/errors.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { ProjectService } from "../projects/service.js";
import type { AssignmentService } from "../rbac/assignment-service.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { RbacServiceError } from "../rbac/errors.js";
import type { AssignmentRecord, PolicyRepository } from "../rbac/policy-repository.js";
import type { PolicyService } from "../rbac/policy-service.js";
import type { SecretRepository } from "../secrets/repository.js";
import { manifestFileName, renderCompose, renderManifest } from "./compose.js";
import { ScaffoldServiceError } from "./errors.js";

/** Options for {@link ScaffoldService}. */
export interface ScaffoldServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Project lifecycle service. */
  readonly projects: ProjectService;
  /** Project lookup. */
  readonly projectRepository: ProjectRepository;
  /** Identity lifecycle service. */
  readonly identities: IdentityService;
  /** Assignment lifecycle service. */
  readonly assignments: AssignmentService;
  /** Secret lookup. */
  readonly secrets: SecretRepository;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Policy persistence for the unfiltered assignment query. */
  readonly policyRepository: PolicyRepository;
  /** Injectable clock. */
  readonly now?: () => number;
}

const BROADER_ROLES = new Set(["org.admin", "project.admin", "secrets.manager", "secrets.officer"]);

/** Projects one persisted assignment into the public contract shape. */
function toAssignment(assignment: AssignmentRecord): Assignment {
  return {
    id: assignment.id,
    principalId: assignment.principalId,
    role: assignment.role,
    scopeType: assignment.scopeType,
    scopeId: assignment.scopeId,
    grantedBy: assignment.grantedBy,
    createdAt: assignment.createdAt.toISOString(),
    expiresAt: assignment.expiresAt === null ? null : assignment.expiresAt.toISOString(),
  };
}

/** Returns true for a live broader grant. */
function isBroaderGrant(assignment: AssignmentRecord): boolean {
  if (BROADER_ROLES.has(assignment.role)) {
    return true;
  }
  if (assignment.role === "secrets.reader") {
    return assignment.scopeType !== "object";
  }
  if (assignment.role === "reader") {
    return assignment.scopeType === "project" || assignment.scopeType === "org";
  }
  return false;
}

/**
 * Creates or reuses the project, service identity, object-scope grants, and a
 * one-time join token for one Compose service.
 *
 * The token is issued last. A retry is idempotent for the project, identity,
 * and live assignments, and rotation invalidates older unused tokens.
 */
export class ScaffoldService {
  readonly #database: PostgreSQLDatabase;
  readonly #projects: ProjectService;
  readonly #projectRepository: ProjectRepository;
  readonly #identities: IdentityService;
  readonly #assignments: AssignmentService;
  readonly #secrets: SecretRepository;
  readonly #policy: PolicyService;
  readonly #policyRepository: PolicyRepository;
  readonly #now: () => number;
  readonly #identityLocks = new Map<string, Promise<void>>();

  /**
   * @param options - Database and existing project/identity/assignment services.
   */
  public constructor(options: ScaffoldServiceOptions) {
    this.#database = options.database;
    this.#projects = options.projects;
    this.#projectRepository = options.projectRepository;
    this.#identities = options.identities;
    this.#assignments = options.assignments;
    this.#secrets = options.secrets;
    this.#policy = options.policy;
    this.#policyRepository = options.policyRepository;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs the scaffold.
   *
   * @param actorId - Authenticated administrator.
   * @param input - Project, service slug, and secret entries.
   * @param context - Optional request metadata.
   * @returns The scaffold response, including one one-time token.
   */
  public async scaffold(
    actorId: string,
    input: ScaffoldRequest,
    context?: PolicyAuditContext,
  ): Promise<ScaffoldResponse> {
    const project = await this.#resolveProject(actorId, input, context);

    const secrets = new Map<string, string>();
    const missing: string[] = [];
    for (const name of input.entries) {
      const secret = await this.#secrets.findActiveSecret(this.#database, project.id, name);
      if (secret === undefined) {
        missing.push(name);
      } else {
        secrets.set(name, secret.id);
      }
    }
    if (missing.length > 0) {
      throw new ScaffoldServiceError(
        422,
        "validation_error",
        `Unknown secret: ${missing.join(", ")}`,
      );
    }

    const identity = await this.#resolveIdentity(actorId, project.id, input.service, context);
    return await this.#withIdentityLock(identity.id, async () => {
      const live = await this.#policyRepository.listAllLiveForPrincipal(identity.id);
      const broader = live.find(isBroaderGrant);
      if (broader !== undefined) {
        throw new ScaffoldServiceError(
          409,
          "identity_scope_conflict",
          "The service identity already has a broader live grant; use a different service name or revoke it",
        );
      }

      const requested = new Set(secrets.values());
      for (const assignment of live) {
        if (
          assignment.role === "secrets.reader" &&
          assignment.scopeType === "object" &&
          !requested.has(assignment.scopeId)
        ) {
          await this.#assignments.delete(actorId, assignment.id, context);
        }
      }

      const assignments: ScaffoldAssignment[] = [];
      for (const [name, secretId] of secrets) {
        const assignment = await this.#ensureAssignment(actorId, identity.id, secretId, context);
        assignments.push({ name, assignment: toAssignment(assignment) });
      }

      const joinToken: JoinTokenResponse = await this.#identities.rotateJoinToken(
        actorId,
        identity.id,
        undefined,
        context,
      );

      return {
        project: {
          id: project.id,
          name: project.name,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
          deletedAt: project.deletedAt?.toISOString() ?? null,
        },
        identity,
        assignments,
        joinToken,
        compose: renderCompose({
          project: project.name,
          service: input.service,
          entries: input.entries,
        }),
        manifest: renderManifest({
          project: project.name,
          service: input.service,
          entries: input.entries,
        }),
        manifestFile: manifestFileName(input.project, input.service),
      };
    });
  }

  /** Serializes grant reconciliation and token issuance per identity. */
  async #withIdentityLock<T>(identityId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#identityLocks.get(identityId) ?? Promise.resolve();
    const current = previous.then(action);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#identityLocks.set(identityId, tail);
    try {
      return await current;
    } finally {
      if (this.#identityLocks.get(identityId) === tail) {
        this.#identityLocks.delete(identityId);
      }
    }
  }

  /**
   * Resolves or creates the active project with collection visibility.
   *
   * An existing project the caller cannot manage is either 403 (the caller can
   * read it) or a uniform 404 (the caller cannot see it). A missing project is
   * a 404 unless the caller can create projects, in which case the empty-entry
   * path creates it and the non-empty path returns the actionable 422.
   */
  async #resolveProject(
    actorId: string,
    input: ScaffoldRequest,
    context?: PolicyAuditContext,
  ): Promise<{
    readonly id: string;
    readonly name: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly deletedAt: Date | null;
  }> {
    const existing = await this.#projectRepository.findActiveByName(this.#database, input.project);
    if (existing !== undefined) {
      return await this.#authorizeExistingProject(actorId, existing, context);
    }

    const createDecision = await this.#policy.authorize(
      actorId,
      "project.create",
      { type: "org", id: "org" },
      context,
      { audit: false },
    );
    if (!createDecision.allowed) {
      await this.#policy.recordDecision(createDecision, context);
      throw new ScaffoldServiceError(404, "project_not_found", "Resource not found");
    }
    if (input.entries.length > 0) {
      await this.#policy.recordDecision(createDecision, context);
      throw new ScaffoldServiceError(
        422,
        "validation_error",
        "Project not found; create the project and its secrets before scaffolding entries",
      );
    }
    try {
      return await this.#projects.create(actorId, { name: input.project }, context);
    } catch (error) {
      if (error instanceof ProjectServiceError && error.code === "project_name_conflict") {
        const raced = await this.#projectRepository.findActiveByName(this.#database, input.project);
        if (raced !== undefined) {
          return await this.#authorizeExistingProject(actorId, raced, context);
        }
        throw new ScaffoldServiceError(409, "project_name_conflict", "Project name conflict");
      }
      throw error;
    }
  }

  /**
   * Authorizes one existing project without revealing it to an invisible caller.
   */
  async #authorizeExistingProject(
    actorId: string,
    project: {
      readonly id: string;
      readonly name: string;
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly deletedAt: Date | null;
    },
    context?: PolicyAuditContext,
  ): Promise<typeof project> {
    const write = await this.#policy.authorize(
      actorId,
      "assignment.write",
      { type: "project", id: project.id },
      context,
      { audit: false },
    );
    if (write.allowed) {
      return project;
    }
    const read = await this.#policy.authorize(
      actorId,
      "project.read",
      { type: "project", id: project.id },
      context,
      { audit: false },
    );
    await this.#policy.recordDecision(write, context);
    if (read.allowed) {
      throw new ScaffoldServiceError(403, "access_denied", "Access denied");
    }
    throw new ScaffoldServiceError(404, "project_not_found", "Resource not found");
  }

  /** Resolves an active identity or creates one. */
  async #resolveIdentity(
    actorId: string,
    projectId: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<IdentitySummary> {
    const active = await this.#findActiveIdentity(actorId, projectId, name, context);
    if (active !== undefined) {
      return active;
    }
    try {
      return await this.#identities.create(actorId, { name, projectId }, context);
    } catch (error) {
      if (error instanceof IdentityServiceError && error.code === "identity_name_conflict") {
        const raced = await this.#findActiveIdentity(actorId, projectId, name, context);
        if (raced !== undefined) {
          return raced;
        }
      }
      throw error;
    }
  }

  /** Finds an active identity by exact name. */
  async #findActiveIdentity(
    actorId: string,
    projectId: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<IdentitySummary | undefined> {
    const list = await this.#identities.list(actorId, projectId, context);
    return list.find((identity) => identity.name === name.trim() && identity.status === "active");
  }

  /** Creates, reuses, or recreates one object-scope reader assignment. */
  async #ensureAssignment(
    actorId: string,
    principalId: string,
    secretId: string,
    context?: PolicyAuditContext,
  ): Promise<AssignmentRecord> {
    try {
      return await this.#assignments.create(
        actorId,
        {
          principalId,
          role: "secrets.reader",
          scopeType: "object",
          scopeId: secretId,
        },
        context,
      );
    } catch (error) {
      if (!(error instanceof RbacServiceError) || error.code !== "assignment_conflict") {
        throw error;
      }
      const [existing] = await this.#assignments.list(
        actorId,
        {
          principalId,
          role: "secrets.reader",
          scopeType: "object",
          scopeId: secretId,
        },
        context,
      );
      if (existing === undefined) {
        throw error;
      }
      if (existing.expiresAt !== null && existing.expiresAt.getTime() <= this.#now()) {
        await this.#assignments.delete(actorId, existing.id, context);
        return await this.#assignments.create(
          actorId,
          {
            principalId,
            role: "secrets.reader",
            scopeType: "object",
            scopeId: secretId,
          },
          context,
        );
      }
      return existing;
    }
  }
}

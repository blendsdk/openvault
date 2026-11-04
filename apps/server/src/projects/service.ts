import type { ProjectCreateRequest, ProjectUpdateRequest } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyDecision, PolicyService } from "../rbac/policy-service.js";
import { ProjectServiceError } from "./errors.js";
import type { ProjectRecord, ProjectRepository } from "./repository.js";

/** Options for {@link ProjectService}. */
export interface ProjectServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Project persistence. */
  readonly repository: ProjectRepository;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Chain writer used for independent error outcomes. */
  readonly audit: AuditWriter;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** Returns true for a PostgreSQL unique violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

/** Maps a denial to the published project visibility status. */
function denialError(decision: PolicyDecision): ProjectServiceError {
  if (decision.reason === "scope_mismatch" || decision.reason === "expired_assignment") {
    return new ProjectServiceError(404, "project_not_found", "Project not found");
  }
  return new ProjectServiceError(403, "access_denied", "Access denied");
}

/**
 * Project lifecycle service.
 *
 * State changes take the audit chain lock before the project row lock, write
 * one joined allow on success, and write one independent error outcome after a
 * rolled-back change. Reads and denials use the normal independent decision.
 */
export class ProjectService {
  readonly #database: PostgreSQLDatabase;
  readonly #repository: ProjectRepository;
  readonly #policy: PolicyService;
  readonly #audit: AuditWriter;
  readonly #now: () => number;

  /**
   * @param options - Database, repository, policy, audit writer, and clock.
   */
  public constructor(options: ProjectServiceOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Creates one project.
   *
   * @param actorId - Authenticated principal.
   * @param input - Project name.
   * @param context - Optional request metadata.
   * @returns The created project.
   */
  public async create(
    actorId: string,
    input: ProjectCreateRequest,
    context?: PolicyAuditContext,
  ): Promise<ProjectRecord> {
    const id = newUlid();
    const resource = { type: "project" as const, id };
    const decision = await this.#policy.authorize(actorId, "project.create", resource, context, {
      audit: false,
    });
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision);
    }

    try {
      return await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        const created = await this.#repository.insert(tx, { id, name: input.name });
        await this.#policy.recordDecision(decision, context, tx, {
          independent: false,
          details: { version: 1 },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.#recordError(
          actorId,
          "project.create",
          id,
          "project_name_conflict",
          decision.policyVersion,
          context,
        );
        throw new ProjectServiceError(409, "project_name_conflict", "Project name conflict");
      }
      if (error instanceof PolicyUnavailableError || error instanceof ProjectServiceError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
  }

  /**
   * Lists active projects visible to the caller.
   *
   * @param actorId - Authenticated principal.
   * @param context - Optional request metadata.
   * @returns Visible projects.
   */
  public async list(
    actorId: string,
    context?: PolicyAuditContext,
  ): Promise<readonly ProjectRecord[]> {
    const result = await this.#policy.authorizeList(
      actorId,
      "project.read",
      { type: "org", id: "org" },
      context,
    );
    if (!result.decision.allowed) {
      throw denialError(result.decision);
    }
    return this.#repository.listVisible(
      this.#database,
      result.visibility.kind === "all" ? "all" : result.visibility.projectIds,
    );
  }

  /**
   * Reads one active project.
   *
   * @param actorId - Authenticated principal.
   * @param id - Project identifier.
   * @param context - Optional request metadata.
   * @returns The project.
   */
  public async get(
    actorId: string,
    id: string,
    context?: PolicyAuditContext,
  ): Promise<ProjectRecord> {
    const project = await this.#repository.findActiveById(this.#database, id);
    if (project === undefined) {
      throw new ProjectServiceError(404, "project_not_found", "Project not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "project.read",
      { type: "project", id },
      context,
    );
    if (!decision.allowed) {
      throw denialError(decision);
    }
    return project;
  }

  /**
   * Renames one active project.
   *
   * @param actorId - Authenticated principal.
   * @param id - Project identifier.
   * @param input - New name.
   * @param context - Optional request metadata.
   * @returns The updated project.
   */
  public async update(
    actorId: string,
    id: string,
    input: ProjectUpdateRequest,
    context?: PolicyAuditContext,
  ): Promise<ProjectRecord> {
    await this.#requireActive(id);
    const decision = await this.#policy.authorize(
      actorId,
      "project.update",
      { type: "project", id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision);
    }

    try {
      return await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        const updated = await this.#repository.rename(tx, id, input.name);
        if (updated === undefined) {
          throw new ProjectServiceError(404, "project_not_found", "Project not found");
        }
        await this.#policy.recordDecision(decision, context, tx, {
          independent: false,
          details: { version: 1 },
        });
        return updated;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.#recordError(
          actorId,
          "project.update",
          id,
          "project_name_conflict",
          decision.policyVersion,
          context,
        );
        throw new ProjectServiceError(409, "project_name_conflict", "Project name conflict");
      }
      if (error instanceof ProjectServiceError) {
        await this.#recordError(
          actorId,
          "project.update",
          id,
          "project_not_found",
          decision.policyVersion,
          context,
        );
        throw error;
      }
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
  }

  /**
   * Soft-deletes one active project.
   *
   * @param actorId - Authenticated principal.
   * @param id - Project identifier.
   * @param context - Optional request metadata.
   */
  public async delete(actorId: string, id: string, context?: PolicyAuditContext): Promise<void> {
    await this.#requireActive(id);
    const decision = await this.#policy.authorize(
      actorId,
      "project.delete",
      { type: "project", id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision);
    }

    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        const deleted = await this.#repository.softDelete(tx, id);
        if (deleted === undefined) {
          throw new ProjectServiceError(404, "project_not_found", "Project not found");
        }
        await this.#policy.recordDecision(decision, context, tx, {
          independent: false,
          details: { version: 1 },
        });
      });
    } catch (error) {
      if (error instanceof ProjectServiceError) {
        await this.#recordError(
          actorId,
          "project.delete",
          id,
          "project_not_found",
          decision.policyVersion,
          context,
        );
        throw error;
      }
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
  }

  /** Loads an active project or throws the stable not-found error. */
  async #requireActive(id: string): Promise<ProjectRecord> {
    const project = await this.#repository.findActiveById(this.#database, id);
    if (project === undefined) {
      throw new ProjectServiceError(404, "project_not_found", "Project not found");
    }
    return project;
  }

  /** Writes one independent error outcome for a failed state change. */
  async #recordError(
    actorId: string,
    action: "project.create" | "project.update" | "project.delete",
    objectId: string,
    reason: string,
    policyVersion: number,
    context?: PolicyAuditContext,
  ): Promise<void> {
    try {
      await this.#audit.record({
        eventId: newUlid(),
        ts: new Date(this.#now()),
        projectId: null,
        requestId: context?.requestId ?? "internal",
        actorId,
        actorKind: "user",
        action,
        scopeType: "system",
        scopeId: null,
        objectType: "project",
        objectId,
        result: "error",
        sourceIp: context?.sourceIp ?? null,
        userAgent: context?.userAgent ?? null,
        details: { reason, policyVersion },
      });
    } catch {
      throw new PolicyUnavailableError();
    }
  }
}

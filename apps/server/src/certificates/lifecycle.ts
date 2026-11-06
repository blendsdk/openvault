import type {
  CertificateMetadata,
  CertificateMetadataUpdateRequest,
} from "@openvault/api-contract";
import { certificateNameSchema, projectNameSchema } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { canListCollection } from "../rbac/collection-visibility.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyDecision, PolicyService } from "../rbac/policy-service.js";
import { CertificateServiceError } from "./errors.js";
import type { CertificateRecord, CertificateRepository } from "./repository.js";
import type { CertificateService } from "./service.js";

/** Narrow purge port used by the certificate lifecycle. */
export interface CertificatePurgePort {
  /**
   * Deletes one certificate and its versions.
   *
   * @param certificateId - Certificate identifier.
   * @param projectId - Active project identifier.
   * @param name - Certificate name.
   * @returns Deleted version count.
   */
  deleteCertificate(certificateId: string, projectId: string, name: string): Promise<number>;
}

/** Options for {@link CertificateLifecycle}. */
export interface CertificateLifecycleOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Certificate persistence. */
  readonly repository: CertificateRepository;
  /** Core service used for metadata projection. */
  readonly service: CertificateService;
  /** Project lookup. */
  readonly projectRepository: ProjectRepository;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Chain writer used for independent error outcomes. */
  readonly audit: AuditWriter;
  /** Dedicated purger, absent when purge is not configured. */
  readonly purger?: CertificatePurgePort;
  /** Retention window in days. */
  readonly softDeleteDays: number;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** Maps a denial to the published visibility status. */
function denialError(hideExistence: boolean): CertificateServiceError {
  if (hideExistence) {
    return new CertificateServiceError(404, "certificate_not_found", "Resource not found");
  }
  return new CertificateServiceError(403, "access_denied", "Access denied");
}

/**
 * Certificate metadata, retention, recovery, and purge lifecycle.
 *
 * Every state change takes the audit chain lock before data locks and writes one joined allow
 * on success or one independent error outcome on failure. Purge authorizes before it inspects
 * lifecycle state and is the documented decision-then-outcome split because the trigger needs
 * the dedicated purger session.
 */
export class CertificateLifecycle {
  readonly #database: PostgreSQLDatabase;
  readonly #repository: CertificateRepository;
  readonly #service: CertificateService;
  readonly #projectRepository: ProjectRepository;
  readonly #policy: PolicyService;
  readonly #audit: AuditWriter;
  readonly #purger: CertificatePurgePort | undefined;
  readonly #softDeleteDays: number;
  readonly #now: () => number;

  /**
   * @param options - Database, repositories, policy, audit, purger, and retention.
   */
  public constructor(options: CertificateLifecycleOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#service = options.service;
    this.#projectRepository = options.projectRepository;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#purger = options.purger;
    this.#softDeleteDays = options.softDeleteDays;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Updates tags and one-way protection without creating a version.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param input - Metadata changes.
   * @param context - Optional request metadata.
   * @returns Updated metadata.
   */
  public async updateMetadata(
    actorId: string,
    projectName: string,
    name: string,
    input: CertificateMetadataUpdateRequest,
    context?: PolicyAuditContext,
  ): Promise<CertificateMetadata> {
    const project = await this.#activeProject(projectName);
    await this.#preAuthorizeProject(actorId, "certificate.write", project.id, context);
    const certificate = await this.#activeCertificate(project.id, name);
    const decision = await this.#authorizeObject(
      actorId,
      "certificate.write",
      project.id,
      certificate.id,
      context,
    );
    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new CertificateServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockCertificateName(tx, project.id, name);
        const locked = await this.#repository.lockCertificate(tx, certificate.id);
        if (locked === undefined || locked.deletedAt !== null) {
          throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
        }
        if (input.purgeProtected === false && locked.purgeProtected) {
          throw new CertificateServiceError(
            409,
            "purge_protection_locked",
            "Purge protection cannot be disabled",
          );
        }
        const updated = await this.#repository.updateMetadata(tx, certificate.id, {
          tags: input.tags ?? locked.tags,
          purgeProtected: input.purgeProtected === true ? true : locked.purgeProtected,
        });
        if (updated === undefined) {
          throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof CertificateServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.write",
          project.id,
          certificate.id,
          error.code,
          context,
        );
        throw error;
      }
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
    return this.#service.metadataFor(actorId, certificate.id);
  }

  /**
   * Soft-deletes one active certificate.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param context - Optional request metadata.
   */
  public async delete(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    const project = await this.#activeProject(projectName);
    await this.#preAuthorizeProject(actorId, "certificate.delete", project.id, context);
    const certificate = await this.#activeCertificate(project.id, name);
    const decision = await this.#authorizeObject(
      actorId,
      "certificate.delete",
      project.id,
      certificate.id,
      context,
    );
    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new CertificateServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockCertificateName(tx, project.id, name);
        const locked = await this.#repository.lockCertificate(tx, certificate.id);
        if (locked === undefined || locked.deletedAt !== null) {
          throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
        }
        const deleted = await this.#repository.softDelete(tx, certificate.id, this.#softDeleteDays);
        if (deleted === undefined) {
          throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof CertificateServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.delete",
          project.id,
          certificate.id,
          error.code,
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
   * Recovers one deleted certificate before retention expires.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param context - Optional request metadata.
   * @returns Recovered metadata.
   */
  public async recover(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<CertificateMetadata> {
    const project = await this.#activeProject(projectName);
    await this.#preAuthorizeProject(actorId, "certificate.recover", project.id, context);
    const certificate = await this.#certificateByName(project.id, name);
    const decision = await this.#authorizeObject(
      actorId,
      "certificate.recover",
      project.id,
      certificate.id,
      context,
    );
    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new CertificateServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockCertificateName(tx, project.id, name);
        const recovered = await this.#repository.recover(tx, certificate.id);
        if (recovered === undefined) {
          const current = await this.#repository.findCertificateById(tx, certificate.id);
          if (current === undefined) {
            throw new CertificateServiceError(
              404,
              "certificate_not_found",
              "Certificate not found",
            );
          }
          throw new CertificateServiceError(
            409,
            current.deletedAt === null ? "certificate_not_deleted" : "certificate_not_recoverable",
            current.deletedAt === null
              ? "Certificate is not deleted"
              : "Certificate can no longer be recovered",
          );
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof CertificateServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.recover",
          project.id,
          certificate.id,
          error.code,
          context,
        );
        throw error;
      }
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
    return this.#service.metadataFor(actorId, certificate.id);
  }

  /**
   * Purges one deleted certificate after retention when protection is off.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param context - Optional request metadata.
   */
  public async purge(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    const project = await this.#activeProject(projectName);
    await this.#preAuthorizeProject(actorId, "certificate.purge", project.id, context);
    const certificate = await this.#certificateByName(project.id, name);
    const decision = await this.#authorizeObject(
      actorId,
      "certificate.purge",
      project.id,
      certificate.id,
      context,
    );
    const fail = async (
      code:
        | "certificate_not_deleted"
        | "purge_protection_locked"
        | "certificate_retention_active"
        | "service_unavailable",
      status: number,
    ): Promise<never> => {
      await this.#recordError(
        actorId,
        decision,
        "certificate.purge",
        project.id,
        certificate.id,
        code,
        context,
      );
      throw new CertificateServiceError(status, code, "Certificate purge is not allowed");
    };
    const state = await this.#repository.purgeState(this.#database, certificate.id);
    if (state === undefined) {
      throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
    }
    if (state.deletedAt === null) {
      await fail("certificate_not_deleted", 409);
    }
    if (state.purgeProtected) {
      await fail("purge_protection_locked", 409);
    }
    if (state.purgeAfter === null || state.purgeAfter.getTime() > state.databaseNow.getTime()) {
      await fail("certificate_retention_active", 409);
    }
    const purger = this.#purger;
    if (purger === undefined) {
      await fail("service_unavailable", 503);
      return;
    }
    // Persist authorization before the independent purge transaction commits.
    // If the process dies after the delete, this event is the durable evidence
    // that the destructive action was authorized.
    await this.#policy.recordDecision(decision, context, undefined, {
      details: { phase: "authorized" },
    });
    try {
      await purger.deleteCertificate(certificate.id, project.id, name);
    } catch (error) {
      const latest = await this.#repository.purgeState(this.#database, certificate.id);
      if (latest === undefined) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.purge",
          project.id,
          certificate.id,
          "certificate_not_found",
          context,
        );
        throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
      }
      if (latest.deletedAt === null) {
        await fail("certificate_not_deleted", 409);
      }
      if (latest.purgeProtected) {
        await fail("purge_protection_locked", 409);
      }
      if (
        latest.purgeAfter === null ||
        latest.purgeAfter.getTime() > latest.databaseNow.getTime()
      ) {
        await fail("certificate_retention_active", 409);
      }
      if (
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "project_not_found"
      ) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.purge",
          project.id,
          certificate.id,
          "project_not_found",
          context,
        );
        throw new CertificateServiceError(404, "project_not_found", "Project not found");
      }
      await this.#recordError(
        actorId,
        decision,
        "certificate.purge",
        project.id,
        certificate.id,
        "purge_failed",
        context,
      );
      throw new CertificateServiceError(503, "service_unavailable", "Service unavailable");
    }
    await this.#policy.recordDecision(decision, context, undefined, {
      details: { phase: "completed" },
    });
  }

  /** Resolves an active project by name. */
  async #activeProject(name: string) {
    if (!projectNameSchema.safeParse(name).success) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    const project = await this.#projectRepository.findActiveByName(this.#database, name);
    if (project === undefined) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    return project;
  }

  /** Resolves one certificate including deleted rows. */
  async #certificateByName(projectId: string, name: string): Promise<CertificateRecord> {
    if (!certificateNameSchema.safeParse(name).success) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    const certificate = await this.#repository.findCertificateByName(
      this.#database,
      projectId,
      name,
    );
    if (certificate === undefined) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    return certificate;
  }

  /** Resolves one active certificate. */
  async #activeCertificate(projectId: string, name: string): Promise<CertificateRecord> {
    const certificate = await this.#certificateByName(projectId, name);
    if (certificate.deletedAt !== null) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    return certificate;
  }

  /** Pre-authorizes one lifecycle action at project scope before the name lookup. */
  async #preAuthorizeProject(
    actorId: string,
    action:
      | "certificate.write"
      | "certificate.delete"
      | "certificate.recover"
      | "certificate.purge",
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    const decision = await this.#policy.authorize(
      actorId,
      action,
      { type: "project", id: projectId },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, projectId, context);
    }
  }

  /**
   * Chooses 403 or 404 for a name-addressed lifecycle denial.
   *
   * A caller that can list certificates knows the collection exists and gets
   * 403 for an action it lacks. Every other caller gets the same 404 as a
   * missing name.
   */
  async #denyName(
    decision: PolicyDecision,
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<CertificateServiceError> {
    const canList = await canListCollection({
      policy: this.#policy,
      actorId: decision.actorId,
      listAction: "certificate.list",
      projectId,
      ...(context === undefined ? {} : { context }),
    });
    return denialError(!canList);
  }

  /** Authorizes one object action and returns the decision used for the joined/deny event. */
  async #authorizeObject(
    actorId: string,
    action:
      | "certificate.write"
      | "certificate.delete"
      | "certificate.recover"
      | "certificate.purge",
    projectId: string,
    certificateId: string,
    context?: PolicyAuditContext,
  ): Promise<PolicyDecision> {
    const decision = await this.#policy.authorize(
      actorId,
      action,
      { type: "certificate", id: certificateId, projectId },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, projectId, context);
    }
    return decision;
  }

  /** Writes one independent error outcome. */
  async #recordError(
    actorId: string,
    decision: PolicyDecision,
    action:
      | "certificate.write"
      | "certificate.delete"
      | "certificate.recover"
      | "certificate.purge",
    projectId: string,
    certificateId: string,
    reason: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    try {
      await this.#audit.record({
        eventId: newUlid(),
        ts: new Date(this.#now()),
        projectId,
        requestId: context?.requestId ?? "internal",
        actorId,
        actorKind: decision.actorKind,
        action,
        scopeType: "project",
        scopeId: projectId,
        objectType: "certificate",
        objectId: certificateId,
        result: "error",
        sourceIp: context?.sourceIp ?? null,
        userAgent: context?.userAgent ?? null,
        details: { reason, policyVersion: decision.policyVersion },
      });
    } catch {
      throw new PolicyUnavailableError();
    }
  }
}

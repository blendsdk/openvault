import type {
  IdentityCertificate,
  IdentityConsumer,
  IdentityDetail,
  IdentitySummary,
  JoinTokenResponse,
} from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AgentTokenService } from "../agent/agent-token-service.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { IdentityServiceError } from "./errors.js";
import type { IdentityAction, IdentityAuthorizer } from "./identity-authorizer.js";
import type {
  IdentityCertificateRecord,
  IdentityConsumerRecord,
  IdentityRepository,
  IdentityScope,
} from "./identity-repository.js";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

function iso(value: Date): string {
  return value.toISOString();
}

function toSummary(identity: {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly status: "active" | "disabled";
  readonly createdAt: Date;
}): IdentitySummary {
  return {
    id: identity.id,
    name: identity.name,
    projectId: identity.projectId,
    status: identity.status,
    createdAt: iso(identity.createdAt),
  };
}

function toCertificate(certificate: IdentityCertificateRecord): IdentityCertificate {
  return {
    serial: certificate.serial,
    fingerprint: certificate.fingerprint,
    notBefore: iso(certificate.notBefore),
    notAfter: iso(certificate.notAfter),
    revokedAt: certificate.revokedAt === null ? null : iso(certificate.revokedAt),
  };
}

function toConsumer(consumer: IdentityConsumerRecord): IdentityConsumer {
  return {
    composeProject: consumer.composeProject,
    composeService: consumer.composeService,
    hostname: consumer.hostname,
    manifestHash: consumer.manifestHash,
    state: consumer.state,
    firstSeen: iso(consumer.firstSeen),
    lastSeen: iso(consumer.lastSeen),
    selfReported: true,
  };
}

/**
 * Applies the identity lifecycle rules above the repository.
 *
 * The service owns authorization, status transitions, idempotent revocation,
 * and response projection. It has no Express dependency so the same rules can
 * be reused by a CLI or a future admin workflow.
 */
export class IdentityService {
  readonly #repository: IdentityRepository;
  readonly #authorizer: IdentityAuthorizer;
  readonly #tokens: AgentTokenService;
  readonly #database: PostgreSQLDatabase;
  readonly #onRevoked: ((principalId: string) => void) | undefined;

  /**
   * @param options - Repositories, authorizer, token issuer, and revoke hook.
   */
  public constructor(options: {
    readonly repository: IdentityRepository;
    readonly authorizer: IdentityAuthorizer;
    readonly tokens: AgentTokenService;
    readonly database: PostgreSQLDatabase;
    readonly onRevoked?: (principalId: string) => void;
  }) {
    this.#repository = options.repository;
    this.#authorizer = options.authorizer;
    this.#tokens = options.tokens;
    this.#database = options.database;
    this.#onRevoked = options.onRevoked;
  }

  /**
   * Creates a project-owned service identity.
   *
   * @param actorId - Signed-in admin principal.
   * @param input - Name and optional project.
   * @param context - Optional request metadata.
   * @returns The created summary.
   */
  public async create(
    actorId: string,
    input: { readonly name: string; readonly projectId?: string | undefined },
    context?: PolicyAuditContext,
  ): Promise<IdentitySummary> {
    const projectId = input.projectId;
    if (projectId === undefined) {
      throw new IdentityServiceError(422, "validation_error", "Validation failed");
    }
    await this.#assert("identity.create", actorId, projectId, context);

    const name = input.name.trim();
    try {
      const identity = await this.#database.withTransaction(async (tx) => {
        const project = await this.#repository.lockProject(tx, projectId);
        if (project === undefined || project.deletedAt !== null) {
          throw new IdentityServiceError(422, "validation_error", "Validation failed");
        }
        return this.#repository.insertServiceIdentity(
          { id: newUlid(), name, projectId: project.id },
          tx,
        );
      });
      return toSummary(identity);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IdentityServiceError(409, "identity_name_conflict", "Identity name conflict");
      }
      throw error;
    }
  }

  /**
   * Lists visible service identities, optionally filtered by project.
   *
   * @param actorId - Signed-in admin principal.
   * @param projectId - Optional exact project filter.
   * @param context - Optional request metadata.
   * @returns Visible summaries, newest first.
   */
  public async list(
    actorId: string,
    projectId?: string,
    context?: PolicyAuditContext,
  ): Promise<readonly IdentitySummary[]> {
    let scope: IdentityScope;
    if (projectId !== undefined) {
      const project = await this.#repository.findProject(projectId);
      if (project === undefined || project.deletedAt !== null) {
        throw new IdentityServiceError(403, "access_denied", "Access denied");
      }
      await this.#assert("identity.read", actorId, projectId, context);
      scope = (await this.#authorizer.canReadAll(actorId))
        ? "all"
        : await this.#authorizer.readableProjectIds(actorId);
    } else {
      const visibility = await this.#authorizer.readScope(actorId, context);
      if (visibility === undefined) {
        throw new IdentityServiceError(403, "access_denied", "Access denied");
      }
      scope = visibility.kind === "all" ? "all" : visibility.projectIds;
    }

    const identities = await this.#repository.listIdentities(scope, projectId);
    return identities.map(toSummary);
  }

  /**
   * Loads one identity with retained certificates and consumer metadata.
   *
   * @param actorId - Signed-in admin principal.
   * @param id - Service principal identifier.
   * @param context - Optional request metadata.
   * @returns The detail response.
   */
  public async get(
    actorId: string,
    id: string,
    context?: PolicyAuditContext,
  ): Promise<IdentityDetail> {
    const identity = await this.#repository.findIdentity(id);
    if (identity === undefined || identity.projectDeletedAt !== null) {
      throw new IdentityServiceError(404, "identity_not_found", "Identity not found");
    }
    const decision = await this.#authorizer.decide(
      "identity.read",
      actorId,
      { type: "identity", id, projectId: identity.projectId },
      context,
    );
    if (!decision.allowed) {
      const visible = await this.#authorizer.hasAny("identity.read", actorId, context, {
        audit: false,
      });
      throw new IdentityServiceError(
        visible ? 404 : 403,
        visible ? "identity_not_found" : "access_denied",
        visible ? "Identity not found" : "Access denied",
      );
    }

    const certificates = await this.#repository.listCertificates(id);
    const consumer = await this.#repository.findConsumer(id);
    return {
      ...toSummary(identity),
      certificates: certificates.map(toCertificate),
      consumer: consumer === undefined ? null : toConsumer(consumer),
    };
  }

  /**
   * Revokes an identity, its unexpired certificates, unused tokens, and consumer.
   *
   * The operation is idempotent and locks the principal before the related
   * rows, matching join, renewal, and token issuance.
   *
   * @param actorId - Signed-in admin principal.
   * @param id - Service principal identifier.
   * @param context - Optional request metadata.
   */
  public async revoke(actorId: string, id: string, context?: PolicyAuditContext): Promise<void> {
    const visible = await this.#authorizer.hasAny("identity.revoke", actorId, context, {
      audit: false,
    });
    const identity = await this.#repository.findIdentity(id);
    if (identity === undefined || identity.projectDeletedAt !== null) {
      throw new IdentityServiceError(404, "identity_not_found", "Identity not found");
    }
    const decision = await this.#authorizer.decide(
      "identity.revoke",
      actorId,
      { type: "identity", id, projectId: identity.projectId },
      context,
    );
    if (!decision.allowed) {
      throw new IdentityServiceError(
        visible ? 404 : 403,
        visible ? "identity_not_found" : "access_denied",
        visible ? "Identity not found" : "Access denied",
      );
    }

    await this.#database.withTransaction(async (tx) => {
      const locked = await this.#repository.lockIdentity(tx, id);
      if (locked === undefined) {
        throw new IdentityServiceError(404, "identity_not_found", "Identity not found");
      }
      await this.#repository.revokeIdentity(tx, id);
      await this.#tokens.revokeUnused(tx, id);
    });
    this.#onRevoked?.(id);
  }

  /**
   * Issues one one-time join token for an active identity.
   *
   * @param actorId - Signed-in admin principal.
   * @param id - Service principal identifier.
   * @param ttlSeconds - Optional explicit lifetime.
   * @param context - Optional request metadata.
   * @returns The raw token response.
   */
  public async issueJoinToken(
    actorId: string,
    id: string,
    ttlSeconds: number | undefined,
    context?: PolicyAuditContext,
  ): Promise<JoinTokenResponse> {
    return await this.#issueJoinToken(actorId, id, ttlSeconds, context, false);
  }

  /**
   * Atomically revokes every unused token and issues a new one.
   *
   * @param actorId - Signed-in admin principal.
   * @param id - Service principal identifier.
   * @param ttlSeconds - Optional explicit lifetime.
   * @param context - Optional request metadata.
   * @returns The raw token response.
   */
  public async rotateJoinToken(
    actorId: string,
    id: string,
    ttlSeconds: number | undefined,
    context?: PolicyAuditContext,
  ): Promise<JoinTokenResponse> {
    return await this.#issueJoinToken(actorId, id, ttlSeconds, context, true);
  }

  /** Shared issue/rotate implementation. */
  async #issueJoinToken(
    actorId: string,
    id: string,
    ttlSeconds: number | undefined,
    context: PolicyAuditContext | undefined,
    rotate: boolean,
  ): Promise<JoinTokenResponse> {
    const visible = await this.#authorizer.hasAny("identity.join_token", actorId, context, {
      audit: false,
    });
    const identity = await this.#repository.findIdentity(id);
    if (identity === undefined || identity.projectDeletedAt !== null) {
      throw new IdentityServiceError(404, "identity_not_found", "Identity not found");
    }
    const decision = await this.#authorizer.decide(
      "identity.join_token",
      actorId,
      { type: "identity", id, projectId: identity.projectId },
      context,
    );
    if (!decision.allowed) {
      throw new IdentityServiceError(
        visible ? 404 : 403,
        visible ? "identity_not_found" : "access_denied",
        visible ? "Identity not found" : "Access denied",
      );
    }
    if (identity.status !== "active") {
      throw new IdentityServiceError(409, "identity_inactive", "Identity is inactive");
    }

    const issued = rotate
      ? await this.#tokens.rotate(
          { id: identity.id, projectId: identity.projectId },
          ttlSeconds,
          actorId,
        )
      : await this.#tokens.issue(
          { id: identity.id, projectId: identity.projectId },
          ttlSeconds,
          actorId,
        );
    return {
      id: issued.id,
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /** Enforces one action or raises the stable access-denied error. */
  async #assert(
    action: IdentityAction,
    actorId: string,
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    if (!(await this.#authorizer.can(action, actorId, projectId, context))) {
      throw new IdentityServiceError(403, "access_denied", "Access denied");
    }
  }
}

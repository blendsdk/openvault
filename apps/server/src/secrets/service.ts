import type {
  CapabilityFlags,
  SecretConsumerSummary,
  SecretCreateInput,
  SecretEncoding,
  SecretList,
  SecretListQuery,
  SecretMetadata,
  SecretMetadataUpdateRequest,
  SecretReadQuery,
  SecretValueResponse,
  SecretValueWriteInput,
  SecretVersion,
  SecretVersionSummary,
  SecretWriteResponse,
} from "@openvault/api-contract";
import { projectNameSchema, secretNameSchema, ulidSchema } from "@openvault/api-contract";
import {
  decryptValue,
  type EnvelopeKeyring,
  encryptValue,
  KeyringError,
  newUlid,
} from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import { canonicalJson } from "../audit/canonical-json.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyDecision, PolicyService } from "../rbac/policy-service.js";
import {
  decodeRequestValue,
  encodeResponseValue,
  fromStoredEnvelope,
  integrityError,
  toStoredEnvelope,
} from "./envelope.js";
import { SecretServiceError } from "./errors.js";
import {
  type ClaimResult,
  claimIdempotency,
  requestHash,
  validateIdempotencyKey,
} from "./idempotency.js";
import type {
  ConsumerSummary,
  ListCursor,
  SecretRecord,
  SecretRepository,
  SecretVersionRecord,
} from "./repository.js";

const MAX_VERSIONS = 1_000;
const ZERO_CAPABILITIES: CapabilityFlags = {
  canRead: false,
  canWrite: false,
  canDelete: false,
  canPurge: false,
  canManage: false,
};

/** Options for {@link SecretService}. */
export interface SecretServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Loaded keyring used for envelopes and idempotency MACs. */
  readonly keyring: EnvelopeKeyring;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Chain writer used for independent error outcomes. */
  readonly audit: AuditWriter;
  /** Project lookup. */
  readonly projectRepository: ProjectRepository;
  /** Secret persistence. */
  readonly repository: SecretRepository;
  /** Decoded value limit. */
  readonly secretMaxBytes: number;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** Optional read behavior. */
export interface SecretReadOptions {
  /** Agent principal whose consumer heartbeat should be refreshed. */
  readonly agentPrincipalId?: string;
}

/** Union returned by a create or write transaction. */
type WriteOutcome =
  | {
      readonly kind: "written";
      readonly secret: SecretRecord;
      readonly version: SecretVersionRecord;
    }
  | { readonly kind: "replay"; readonly versionId: string };

/** Returns true for a PostgreSQL unique violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

/** Maps a denial to the published visibility status. */
function denialError(
  decision: PolicyDecision,
  notFoundCode: "project_not_found" | "secret_not_found",
): SecretServiceError {
  if (decision.reason === "scope_mismatch" || decision.reason === "expired_assignment") {
    return new SecretServiceError(404, notFoundCode, "Resource not found");
  }
  return new SecretServiceError(403, "access_denied", "Access denied");
}

/** Encodes one list cursor. */
function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decodes one list cursor or throws a validation error. */
function decodeCursor(raw: string | undefined): ListCursor | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !secretNameSchema.safeParse(record.name).success ||
      typeof record.id !== "string" ||
      !ulidSchema.safeParse(record.id).success
    ) {
      throw new Error("invalid");
    }
    return { name: record.name, id: record.id };
  } catch {
    throw new SecretServiceError(422, "validation_error", "Validation failed");
  }
}

/**
 * Secret data-plane service.
 *
 * State changes take the audit chain lock before data locks, write one joined
 * allow on success, and write one independent error outcome on failure. Reads
 * write one allow decision before returning plaintext. Values never enter a
 * metadata, error, or audit payload.
 */
export class SecretService {
  readonly #database: PostgreSQLDatabase;
  readonly #keyring: EnvelopeKeyring;
  readonly #policy: PolicyService;
  readonly #audit: AuditWriter;
  readonly #projectRepository: ProjectRepository;
  readonly #repository: SecretRepository;
  readonly #secretMaxBytes: number;
  readonly #now: () => number;

  /**
   * @param options - Database, keyring, policy, audit, repositories, and limits.
   */
  public constructor(options: SecretServiceOptions) {
    this.#database = options.database;
    this.#keyring = options.keyring;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#projectRepository = options.projectRepository;
    this.#repository = options.repository;
    this.#secretMaxBytes = options.secretMaxBytes;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Creates one secret and its first version.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param input - Create request.
   * @param context - Optional request metadata.
   * @param idempotencyKey - Optional caller key.
   * @returns Metadata plus the written version.
   */
  public async create(
    actorId: string,
    projectName: string,
    input: SecretCreateInput,
    context?: PolicyAuditContext,
    idempotencyKey?: string,
  ): Promise<SecretWriteResponse> {
    const project = await this.#activeProject(projectName);
    if (!secretNameSchema.safeParse(input.name).success) {
      throw new SecretServiceError(422, "validation_error", "Validation failed");
    }
    const expiresAt = this.#futureDate(input.expiresAt);
    const key = validateIdempotencyKey(idempotencyKey);
    const encoding = input.encoding ?? "utf8";
    const contentType = input.contentType ?? "text/plain";
    const tags = input.tags ?? {};
    const decoded = decodeRequestValue(input.value, encoding, this.#secretMaxBytes);
    const secretId = newUlid();
    const versionId = newUlid();
    const resource = { type: "secret" as const, id: secretId, projectId: project.id };

    try {
      const decision = await this.#policy.authorize(actorId, "secret.write", resource, context, {
        audit: false,
      });
      if (!decision.allowed) {
        await this.#policy.recordDecision(decision, context);
        throw denialError(decision, "project_not_found");
      }
      let envelope: ReturnType<typeof toStoredEnvelope>;
      try {
        envelope = toStoredEnvelope(
          encryptValue(decoded.bytes, this.#keyring, {
            objectType: "secret",
            projectId: project.id,
            objectId: secretId,
            version: versionId,
          }),
        );
      } catch (error) {
        if (error instanceof KeyringError) {
          throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
        }
        throw error;
      } finally {
        decoded.bytes.fill(0);
      }
      const path = `/v1/data/${projectName}/secrets`;
      const hash =
        key === undefined
          ? undefined
          : requestHash(this.#keyring, { method: "POST", path, body: input });

      let outcome: WriteOutcome;
      try {
        outcome = await this.#database.withTransaction(async (tx) => {
          await this.#audit.lockChain(tx);
          if (!(await this.#repository.lockActiveProject(tx, project.id))) {
            throw new SecretServiceError(404, "project_not_found", "Project not found");
          }
          await this.#repository.lockSecretName(tx, project.id, input.name);
          if (key !== undefined && hash !== undefined) {
            const claim = await claimIdempotency(
              tx,
              {
                principalId: actorId,
                key,
                method: "POST",
                path,
                requestHash: hash,
                status: 201,
                versionId,
                now: new Date(this.#now()),
              },
              this.#now(),
            );
            if (claim.kind === "replay") {
              return { kind: "replay", versionId: claim.versionId };
            }
            if (claim.kind === "conflict") {
              throw new SecretServiceError(409, "idempotency_conflict", "Idempotency conflict");
            }
          }
          if ((await this.#repository.findSecretByName(tx, project.id, input.name)) !== undefined) {
            throw new SecretServiceError(409, "secret_name_conflict", "Secret name conflict");
          }
          const secret = await this.#repository.insertSecret(tx, {
            id: secretId,
            projectId: project.id,
            name: input.name,
            tags,
            contentType,
          });
          const version = await this.#repository.insertVersion(tx, {
            id: versionId,
            secretId,
            envelope,
            createdBy: actorId,
            expiresAt,
          });
          await this.#repository.updateCurrentVersion(tx, secretId, versionId);
          await this.#policy.recordDecision(decision, context, tx, {
            independent: false,
            details: { version: versionId },
          });
          return { kind: "written", secret: { ...secret, currentVersionId: versionId }, version };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          await this.#recordError(
            actorId,
            decision,
            "secret.write",
            project.id,
            secretId,
            "secret_name_conflict",
            context,
          );
          throw new SecretServiceError(409, "secret_name_conflict", "Secret name conflict");
        }
        if (error instanceof SecretServiceError && error.code !== "project_not_found") {
          await this.#recordError(
            actorId,
            decision,
            "secret.write",
            project.id,
            secretId,
            error.code,
            context,
          );
          throw error;
        }
        if (error instanceof SecretServiceError) {
          throw error;
        }
        if (error instanceof PolicyUnavailableError) {
          throw error;
        }
        throw new PolicyUnavailableError();
      }
      if (outcome.kind === "replay") {
        return this.#loadWriteResponse(actorId, outcome.versionId);
      }
      return this.#writeResponse(actorId, outcome.secret, outcome.version);
    } finally {
      decoded.bytes.fill(0);
    }
  }

  /**
   * Writes a new immutable version.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param input - Value write request.
   * @param context - Optional request metadata.
   * @param idempotencyKey - Optional caller key.
   * @returns Metadata plus the written version.
   */
  public async write(
    actorId: string,
    projectName: string,
    name: string,
    input: SecretValueWriteInput,
    context?: PolicyAuditContext,
    idempotencyKey?: string,
  ): Promise<SecretWriteResponse> {
    const project = await this.#activeProject(projectName);
    if (!secretNameSchema.safeParse(name).success) {
      throw new SecretServiceError(422, "validation_error", "Validation failed");
    }
    const secret = await this.#repository.findSecretByName(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Secret not found");
    }
    const expiresAt = this.#futureDate(input.expiresAt);
    const key = validateIdempotencyKey(idempotencyKey);
    const encoding = input.encoding ?? "utf8";
    const decoded = decodeRequestValue(input.value, encoding, this.#secretMaxBytes);
    const versionId = newUlid();
    const resource = { type: "secret" as const, id: secret.id, projectId: project.id };

    try {
      const decision = await this.#policy.authorize(actorId, "secret.write", resource, context, {
        audit: false,
      });
      if (!decision.allowed) {
        await this.#policy.recordDecision(decision, context);
        throw denialError(decision, "secret_not_found");
      }
      let envelope: ReturnType<typeof toStoredEnvelope>;
      try {
        envelope = toStoredEnvelope(
          encryptValue(decoded.bytes, this.#keyring, {
            objectType: "secret",
            projectId: project.id,
            objectId: secret.id,
            version: versionId,
          }),
        );
      } catch (error) {
        if (error instanceof KeyringError) {
          throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
        }
        throw error;
      } finally {
        decoded.bytes.fill(0);
      }
      const path = `/v1/data/${projectName}/secrets/${name}`;
      const hash =
        key === undefined
          ? undefined
          : requestHash(this.#keyring, { method: "PUT", path, body: input });

      let outcome: WriteOutcome;
      try {
        outcome = await this.#database.withTransaction(async (tx) => {
          await this.#audit.lockChain(tx);
          if (!(await this.#repository.lockActiveProject(tx, project.id))) {
            throw new SecretServiceError(404, "project_not_found", "Project not found");
          }
          await this.#repository.lockSecretName(tx, project.id, name);
          if (key !== undefined && hash !== undefined) {
            const claim = await claimIdempotency(
              tx,
              {
                principalId: actorId,
                key,
                method: "PUT",
                path,
                requestHash: hash,
                status: 200,
                versionId,
                now: new Date(this.#now()),
              },
              this.#now(),
            );
            if (claim.kind === "replay") {
              return { kind: "replay", versionId: claim.versionId };
            }
            if (claim.kind === "conflict") {
              throw new SecretServiceError(409, "idempotency_conflict", "Idempotency conflict");
            }
          }
          const locked = await this.#repository.lockSecret(tx, secret.id);
          if (locked === undefined || locked.deletedAt !== null) {
            throw new SecretServiceError(404, "secret_not_found", "Secret not found");
          }
          if ((await this.#repository.countVersions(tx, secret.id)) >= MAX_VERSIONS) {
            throw new SecretServiceError(409, "secret_version_limit", "Version limit reached");
          }
          const version = await this.#repository.insertVersion(tx, {
            id: versionId,
            secretId: secret.id,
            envelope,
            createdBy: actorId,
            expiresAt,
          });
          await this.#repository.updateCurrentVersion(tx, secret.id, versionId);
          await this.#policy.recordDecision(decision, context, tx, {
            independent: false,
            details: { version: versionId },
          });
          return { kind: "written", secret: { ...locked, currentVersionId: versionId }, version };
        });
      } catch (error) {
        if (error instanceof SecretServiceError && error.code !== "project_not_found") {
          await this.#recordError(
            actorId,
            decision,
            "secret.write",
            project.id,
            secret.id,
            error.code,
            context,
          );
          throw error;
        }
        if (error instanceof SecretServiceError) {
          throw error;
        }
        if (error instanceof PolicyUnavailableError) {
          throw error;
        }
        throw new PolicyUnavailableError();
      }
      if (outcome.kind === "replay") {
        return this.#loadWriteResponse(actorId, outcome.versionId);
      }
      return this.#writeResponse(actorId, outcome.secret, outcome.version);
    } finally {
      decoded.bytes.fill(0);
    }
  }

  /**
   * Reads one value version.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param query - Optional version selector.
   * @param context - Optional request metadata.
   * @param options - Agent heartbeat behavior.
   * @returns The value and its metadata.
   */
  public async read(
    actorId: string,
    projectName: string,
    name: string,
    query: SecretReadQuery,
    context?: PolicyAuditContext,
    options: SecretReadOptions = {},
  ): Promise<SecretValueResponse> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findSecretByName(this.#database, project.id, name);
    if (secret === undefined || secret.deletedAt !== null) {
      throw new SecretServiceError(404, "secret_not_found", "Secret not found");
    }
    const resource = { type: "secret" as const, id: secret.id, projectId: project.id };
    const decision = await this.#policy.authorize(actorId, "secret.read", resource, context, {
      audit: false,
    });
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision, "secret_not_found");
    }

    let version: SecretVersionRecord | undefined;
    if (query.version !== undefined) {
      version = await this.#repository.findVersion(this.#database, secret.id, query.version);
      if (version === undefined) {
        throw new SecretServiceError(404, "secret_version_not_found", "Version not found");
      }
      if (version.expiresAt !== null && version.expiresAt.getTime() <= this.#now()) {
        await this.#recordError(
          actorId,
          decision,
          "secret.read",
          project.id,
          secret.id,
          "secret_expired",
          context,
        );
        throw new SecretServiceError(410, "secret_expired", "Secret expired");
      }
    } else {
      version = await this.#repository.findLatestActiveVersion(this.#database, secret.id);
      if (version === undefined) {
        await this.#recordError(
          actorId,
          decision,
          "secret.read",
          project.id,
          secret.id,
          "secret_expired",
          context,
        );
        throw new SecretServiceError(410, "secret_expired", "Secret expired");
      }
    }

    await this.#policy.recordDecision(decision, context, undefined, {
      details: { version: version.id },
    });
    let bytes: Buffer;
    try {
      bytes = decryptValue(
        fromStoredEnvelope(version),
        this.#keyring,
        {
          objectType: "secret",
          projectId: project.id,
          objectId: secret.id,
          version: version.id,
        },
        { maxCiphertextBytes: this.#secretMaxBytes },
      );
    } catch (error) {
      if (error instanceof KeyringError) {
        throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
      }
      throw integrityError(error);
    }
    try {
      const encoded = encodeResponseValue(bytes);
      if (options.agentPrincipalId !== undefined) {
        await this.#repository
          .touchConsumer(this.#database, options.agentPrincipalId)
          .catch(() => undefined);
      }
      const capabilities = await this.#capabilities(actorId, secret);
      return {
        id: secret.id,
        projectId: project.id,
        name: secret.name,
        value: encoded.value,
        encoding: encoded.encoding,
        contentType: secret.contentType,
        tags: secret.tags,
        version: this.#version(version),
        capabilities,
      };
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * Lists active secrets in one project.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param query - Search, tag, and cursor filters.
   * @param context - Optional request metadata.
   * @returns One page and a continuation cursor.
   */
  public async list(
    actorId: string,
    projectName: string,
    query: SecretListQuery,
    context?: PolicyAuditContext,
  ): Promise<SecretList> {
    const project = await this.#activeProject(projectName);
    const result = await this.#policy.authorizeList(
      actorId,
      "secret.list",
      { type: "project", id: project.id },
      context,
    );
    if (!result.decision.allowed) {
      throw denialError(result.decision, "project_not_found");
    }
    const cursor = decodeCursor(query.cursor);
    const rows = await this.#repository.listActiveSecrets(this.#database, project.id, {
      q: query.q,
      tagKey: query.tagKey,
      tagValue: query.tagValue,
      cursor,
      limit: query.limit,
    });
    const page = rows.slice(0, query.limit);
    const resources = page.map((secret) => ({
      type: "secret" as const,
      id: secret.id,
      projectId: project.id,
    }));
    const capabilities = await this.#policy.capabilitiesForMany(actorId, resources);
    const consumers = await this.#repository.listConsumers(
      this.#database,
      project.id,
      page.map((secret) => secret.id),
    );
    const secrets = page.map((secret) =>
      this.#metadata(
        secret,
        secret.currentVersion,
        consumers.get(secret.id) ?? [],
        capabilities.get(secret.id) ?? ZERO_CAPABILITIES,
      ),
    );
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ name: last.name, id: last.id })
        : null;
    return { secrets, nextCursor };
  }

  /**
   * Lists every version of one active secret.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param context - Optional request metadata.
   * @returns Version summaries newest first.
   */
  public async versions(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<readonly SecretVersionSummary[]> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findActiveSecret(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Secret not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.read",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision, "secret_not_found");
    }
    await this.#policy.recordDecision(decision, context);
    const versions = await this.#repository.listVersions(this.#database, secret.id);
    return versions.map((version) => this.#versionSummary(version, secret.currentVersionId));
  }

  /**
   * Lists consumer summaries for one active secret.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param context - Optional request metadata.
   * @returns Consumer summaries.
   */
  public async consumers(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<readonly SecretConsumerSummary[]> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findActiveSecret(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Secret not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.list",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw denialError(decision, "secret_not_found");
    }
    await this.#policy.recordDecision(decision, context);
    const consumers = await this.#repository.listConsumers(this.#database, project.id, [secret.id]);
    return (consumers.get(secret.id) ?? []).map((consumer) => this.#consumer(consumer));
  }

  /** Resolves an active project by name. */
  async #activeProject(name: string) {
    if (!projectNameSchema.safeParse(name).success) {
      throw new SecretServiceError(404, "project_not_found", "Project not found");
    }
    const project = await this.#projectRepository.findActiveByName(this.#database, name);
    if (project === undefined) {
      throw new SecretServiceError(404, "project_not_found", "Project not found");
    }
    return project;
  }

  /** Validates one optional future expiry. */
  #futureDate(value: string | undefined): Date | null {
    if (value === undefined) {
      return null;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= this.#now()) {
      throw new SecretServiceError(422, "validation_error", "Validation failed");
    }
    return date;
  }

  /** Builds metadata for one secret. */
  #metadata(
    secret: SecretRecord,
    currentVersion: SecretVersionRecord | null,
    consumers: readonly ConsumerSummary[],
    capabilities: CapabilityFlags,
  ): SecretMetadata {
    return {
      id: secret.id,
      projectId: secret.projectId,
      name: secret.name,
      tags: secret.tags,
      contentType: secret.contentType,
      status: secret.deletedAt === null ? "active" : "deleted",
      currentVersion: currentVersion === null ? null : this.#version(currentVersion),
      createdAt: secret.createdAt.toISOString(),
      updatedAt: secret.updatedAt.toISOString(),
      deletedAt: secret.deletedAt?.toISOString() ?? null,
      purgeAfter: secret.purgeAfter?.toISOString() ?? null,
      purgeProtected: secret.purgeProtected,
      consumers: consumers.map((consumer) => this.#consumer(consumer)),
      capabilities,
    };
  }

  /** Maps one version to the public shape. */
  #version(version: SecretVersionRecord): SecretVersion {
    return {
      id: version.id,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
      expiresAt: version.expiresAt?.toISOString() ?? null,
    };
  }

  /** Maps one version to a summary with status and current flag. */
  #versionSummary(version: SecretVersionRecord, currentId: string | null): SecretVersionSummary {
    const expired = version.expiresAt !== null && version.expiresAt.getTime() <= this.#now();
    return {
      ...this.#version(version),
      status: expired ? "expired" : "active",
      isCurrent: version.id === currentId,
    };
  }

  /** Maps one consumer summary to the public shape. */
  #consumer(consumer: ConsumerSummary): SecretConsumerSummary {
    return {
      composeProject: consumer.composeProject,
      composeService: consumer.composeService,
      lastSeen: consumer.lastSeen.toISOString(),
    };
  }

  /** Computes the five flags for one secret. */
  async #capabilities(actorId: string, secret: SecretRecord): Promise<CapabilityFlags> {
    const result = await this.#policy.capabilitiesForMany(actorId, [
      { type: "secret", id: secret.id, projectId: secret.projectId },
    ]);
    return result.get(secret.id) ?? ZERO_CAPABILITIES;
  }

  /** Builds a write response for a written version. */
  async #writeResponse(
    actorId: string,
    secret: SecretRecord,
    version: SecretVersionRecord,
  ): Promise<SecretWriteResponse> {
    const current =
      secret.currentVersionId === null
        ? null
        : ((await this.#repository.findVersion(
            this.#database,
            secret.id,
            secret.currentVersionId,
          )) ?? null);
    const consumers = await this.#repository.listConsumers(this.#database, secret.projectId, [
      secret.id,
    ]);
    const capabilities = await this.#capabilities(actorId, secret);
    return {
      ...this.#metadata(secret, current, consumers.get(secret.id) ?? [], capabilities),
      version: this.#version(version),
    };
  }

  /** Loads a write response for an idempotent replay. */
  async #loadWriteResponse(actorId: string, versionId: string): Promise<SecretWriteResponse> {
    const found = await this.#repository.findVersionById(this.#database, versionId);
    if (found === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Secret not found");
    }
    return this.#writeResponse(actorId, found.secret, found.version);
  }

  /** Writes one independent error outcome for a failed state change. */
  async #recordError(
    actorId: string,
    decision: PolicyDecision,
    action: "secret.read" | "secret.write" | "secret.delete" | "secret.recover" | "secret.purge",
    projectId: string,
    secretId: string,
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
        objectType: "secret",
        objectId: secretId,
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

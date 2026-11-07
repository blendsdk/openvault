import { createHash } from "node:crypto";
import type {
  CapabilityFlags,
  SecretConsumerSummary,
  SecretCreateInput,
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
import type { ProjectRepository } from "../projects/repository.js";
import { VaultPurgerError } from "../purge/errors.js";
import type { VaultPurger } from "../purge/vault-purger.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { canListCollection } from "../rbac/collection-visibility.js";
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
import { claimIdempotency, requestHash, validateIdempotencyKey } from "./idempotency.js";
import type {
  ConsumerSummary,
  ListCursor,
  SecretRecord,
  SecretRepository,
  SecretVersionMetadata,
  SecretVersionRecord,
} from "./repository.js";

const MAX_VERSIONS = 1_000;
const MAX_SECRET_CIPHERTEXT = 65_536;
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
  /** Soft-delete retention window in days. */
  readonly softDeleteDays: number;
  /** Dedicated purge executor, absent when purge is not configured. */
  readonly purger?: VaultPurger;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
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
  notFoundCode: "project_not_found" | "secret_not_found",
  hideExistence: boolean,
  message = "Resource not found",
): SecretServiceError {
  if (hideExistence) {
    return new SecretServiceError(404, notFoundCode, message);
  }
  return new SecretServiceError(403, "access_denied", "Access denied");
}

/** Replaces a potentially large value with a fixed-size digest for the MAC. */
function hashableBody<T extends { readonly value: string }>(input: T): Record<string, unknown> {
  const { value, ...rest } = input as { readonly value: string } & Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(rest)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  result.valueHash = createHash("sha256").update(value, "utf8").digest("hex");
  return result;
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
  readonly #softDeleteDays: number;
  readonly #purger: VaultPurger | undefined;
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
    this.#softDeleteDays = options.softDeleteDays;
    this.#purger = options.purger;
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
    const secretId = newUlid();
    const versionId = newUlid();
    const resource = { type: "secret" as const, id: secretId, projectId: project.id };
    const decision = await this.#policy.authorize(actorId, "secret.write", resource, context, {
      audit: false,
    });
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    const expiresAt = this.#futureDate(input.expiresAt);
    const key = validateIdempotencyKey(idempotencyKey);
    const encoding = input.encoding ?? "utf8";
    const contentType = input.contentType ?? "text/plain";
    const tags = input.tags ?? {};
    const decoded = decodeRequestValue(input.value, encoding, this.#secretMaxBytes);

    try {
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
          : requestHash(this.#keyring, { method: "POST", path, body: hashableBody(input) });

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
        return this.#loadWriteResponse(actorId, outcome.versionId, project.id, input.name);
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
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const versionId = newUlid();
    const resource = { type: "secret" as const, id: secret.id, projectId: project.id };
    const decision = await this.#policy.authorize(actorId, "secret.write", resource, context, {
      audit: false,
    });
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    const expiresAt = this.#futureDate(input.expiresAt);
    const key = validateIdempotencyKey(idempotencyKey);
    const encoding = input.encoding ?? "utf8";
    const decoded = decodeRequestValue(input.value, encoding, this.#secretMaxBytes);

    try {
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
          : requestHash(this.#keyring, {
              method: "PUT",
              path,
              body: hashableBody({
                value: input.value,
                encoding: input.encoding,
                expiresAt: input.expiresAt,
              }),
            });

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
            throw new SecretServiceError(404, "secret_not_found", "Resource not found");
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
          const refreshed = await this.#repository.findSecretById(tx, secret.id);
          return {
            kind: "written",
            secret: refreshed ?? { ...locked, currentVersionId: versionId },
            version,
          };
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
        return this.#loadWriteResponse(actorId, outcome.versionId, project.id, name, secret.id);
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
  ): Promise<SecretValueResponse> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findSecretByName(this.#database, project.id, name);
    if (secret === undefined || secret.deletedAt !== null) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const resource = { type: "secret" as const, id: secret.id, projectId: project.id };
    const decision = await this.#policy.authorize(actorId, "secret.read", resource, context, {
      audit: false,
    });
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }

    let version: SecretVersionRecord | undefined;
    if (query.version !== undefined) {
      version = await this.#repository.findVersion(this.#database, secret.id, query.version);
      if (version === undefined) {
        await this.#recordError(
          actorId,
          decision,
          "secret.read",
          project.id,
          secret.id,
          "secret_version_not_found",
          context,
          query.version,
        );
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
          version.id,
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
        { maxCiphertextBytes: MAX_SECRET_CIPHERTEXT },
      );
    } catch (error) {
      // A valid authorization is not a successful read. Record the integrity
      // failure against the selected version before returning the error.
      await this.#recordError(
        actorId,
        decision,
        "secret.read",
        project.id,
        secret.id,
        "secret_integrity_failed",
        context,
        version.id,
      );
      if (error instanceof KeyringError) {
        throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
      }
      throw integrityError(error);
    }
    try {
      let response: SecretValueResponse;
      try {
        const encoded = encodeResponseValue(bytes);
        const capabilities = await this.#capabilities(actorId, secret);
        response = {
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
      } catch (error) {
        await this.#recordError(
          actorId,
          decision,
          "secret.read",
          project.id,
          secret.id,
          error instanceof PolicyUnavailableError ? "policy_unavailable" : "secret_integrity_failed",
          context,
          version.id,
        );
        if (error instanceof PolicyUnavailableError) {
          throw error;
        }
        throw integrityError(error);
      }
      // The allow event is written only after every integrity-sensitive step
      // and the response object are complete.
      await this.#policy.recordDecision(decision, context, undefined, {
        details: { version: version.id },
      });
      return response;
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
    const project = await this.#activeProject(projectName, "project_not_found");
    const result = await this.#policy.authorizeList(
      actorId,
      "secret.list",
      { type: "project", id: project.id },
      context,
    );
    if (!result.decision.allowed) {
      throw denialError("project_not_found", true, "Project not found");
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
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
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
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
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
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
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
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    await this.#policy.recordDecision(decision, context);
    const consumers = await this.#repository.listConsumers(this.#database, project.id, [secret.id]);
    return (consumers.get(secret.id) ?? []).map((consumer) => this.#consumer(consumer));
  }

  /**
   * Updates metadata without creating a version.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param input - Metadata changes.
   * @param context - Optional request metadata.
   * @returns The updated metadata.
   */
  public async updateMetadata(
    actorId: string,
    projectName: string,
    name: string,
    input: SecretMetadataUpdateRequest,
    context?: PolicyAuditContext,
  ): Promise<SecretMetadata> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findActiveSecret(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.write",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }

    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new SecretServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockSecretName(tx, project.id, name);
        const locked = await this.#repository.lockSecret(tx, secret.id);
        if (locked === undefined || locked.deletedAt !== null) {
          throw new SecretServiceError(404, "secret_not_found", "Resource not found");
        }
        if (input.purgeProtected === false && locked.purgeProtected) {
          throw new SecretServiceError(
            409,
            "purge_protection_locked",
            "Purge protection cannot be disabled",
          );
        }
        const updated = await this.#repository.updateMetadata(tx, secret.id, {
          tags: input.tags ?? locked.tags,
          contentType: input.contentType ?? locked.contentType,
          purgeProtected: input.purgeProtected === true ? true : locked.purgeProtected,
        });
        if (updated === undefined) {
          throw new SecretServiceError(404, "secret_not_found", "Resource not found");
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof SecretServiceError) {
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
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
    return this.#metadataResponse(actorId, secret.id);
  }

  /**
   * Soft-deletes one active secret.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param context - Optional request metadata.
   */
  public async delete(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findActiveSecret(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.delete",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new SecretServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockSecretName(tx, project.id, name);
        const locked = await this.#repository.lockSecret(tx, secret.id);
        if (locked === undefined || locked.deletedAt !== null) {
          throw new SecretServiceError(404, "secret_not_found", "Resource not found");
        }
        const deleted = await this.#repository.softDelete(tx, secret.id, this.#softDeleteDays);
        if (deleted === undefined) {
          throw new SecretServiceError(404, "secret_not_found", "Resource not found");
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof SecretServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "secret.delete",
          project.id,
          secret.id,
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
   * Recovers one deleted secret before retention expires.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param context - Optional request metadata.
   * @returns The recovered metadata.
   */
  public async recover(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<SecretMetadata> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findSecretByName(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.recover",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    try {
      await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, project.id))) {
          throw new SecretServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockSecretName(tx, project.id, name);
        const recovered = await this.#repository.recover(tx, secret.id);
        if (recovered === undefined) {
          const current = await this.#repository.findSecretById(tx, secret.id);
          if (current === undefined) {
            throw new SecretServiceError(404, "secret_not_found", "Resource not found");
          }
          throw new SecretServiceError(
            current.deletedAt === null ? 409 : 409,
            current.deletedAt === null ? "secret_not_deleted" : "secret_not_recoverable",
            current.deletedAt === null
              ? "Secret is not deleted"
              : "Secret can no longer be recovered",
          );
        }
        await this.#policy.recordDecision(decision, context, tx, { independent: false });
      });
    } catch (error) {
      if (error instanceof SecretServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "secret.recover",
          project.id,
          secret.id,
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
    return this.#metadataResponse(actorId, secret.id);
  }

  /**
   * Purges one deleted secret after retention when protection is off.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Secret name.
   * @param context - Optional request metadata.
   */
  public async purge(
    actorId: string,
    projectName: string,
    name: string,
    context?: PolicyAuditContext,
  ): Promise<void> {
    const project = await this.#activeProject(projectName);
    const secret = await this.#repository.findSecretByName(this.#database, project.id, name);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const decision = await this.#policy.authorize(
      actorId,
      "secret.purge",
      { type: "secret", id: secret.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, "secret_not_found", project.id, context);
    }
    const fail = async (
      code:
        | "secret_not_deleted"
        | "purge_protection_locked"
        | "secret_retention_active"
        | "service_unavailable",
      status: number,
    ) => {
      await this.#recordError(
        actorId,
        decision,
        "secret.purge",
        project.id,
        secret.id,
        code,
        context,
      );
      throw new SecretServiceError(status, code, "Secret purge is not allowed");
    };
    if (secret.deletedAt === null) {
      await fail("secret_not_deleted", 409);
    }
    if (secret.purgeProtected) {
      await fail("purge_protection_locked", 409);
    }
    if (secret.purgeAfter === null || secret.purgeAfter.getTime() > this.#now()) {
      await fail("secret_retention_active", 409);
    }
    const purger = this.#purger;
    if (purger === undefined) {
      await this.#recordError(
        actorId,
        decision,
        "secret.purge",
        project.id,
        secret.id,
        "service_unavailable",
        context,
      );
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
    // Persist authorization before the independent purge transaction commits.
    // If the process dies after the delete, this event is the durable evidence
    // that the destructive action was authorized.
    await this.#policy.recordDecision(decision, context, undefined, {
      details: { phase: "authorized" },
    });
    try {
      await purger.deleteSecret(secret.id, project.id, name);
    } catch (error) {
      const latest = await this.#repository.findSecretById(this.#database, secret.id);
      if (latest === undefined) {
        await this.#recordError(
          actorId,
          decision,
          "secret.purge",
          project.id,
          secret.id,
          "secret_not_found",
          context,
        );
        throw new SecretServiceError(404, "secret_not_found", "Resource not found");
      }
      if (latest.deletedAt === null) {
        await this.#recordError(
          actorId,
          decision,
          "secret.purge",
          project.id,
          secret.id,
          "secret_not_deleted",
          context,
        );
        throw new SecretServiceError(409, "secret_not_deleted", "Secret is not deleted");
      }
      if (latest.purgeProtected) {
        await this.#recordError(
          actorId,
          decision,
          "secret.purge",
          project.id,
          secret.id,
          "purge_protection_locked",
          context,
        );
        throw new SecretServiceError(409, "purge_protection_locked", "Purge protection is enabled");
      }
      if (latest.purgeAfter !== null && latest.purgeAfter.getTime() > this.#now()) {
        await this.#recordError(
          actorId,
          decision,
          "secret.purge",
          project.id,
          secret.id,
          "secret_retention_active",
          context,
        );
        throw new SecretServiceError(409, "secret_retention_active", "Retention is active");
      }
      if (
        error instanceof VaultPurgerError &&
        (error.code === "project_not_found" || error.code === "target_not_found")
      ) {
        const code = error.code === "project_not_found" ? "project_not_found" : "secret_not_found";
        await this.#recordError(
          actorId,
          decision,
          "secret.purge",
          project.id,
          secret.id,
          code,
          context,
        );
        throw new SecretServiceError(
          error.code === "project_not_found" ? 404 : 404,
          error.code === "project_not_found" ? "project_not_found" : "secret_not_found",
          "Resource not found",
        );
      }
      await this.#recordError(
        actorId,
        decision,
        "secret.purge",
        project.id,
        secret.id,
        "purge_failed",
        context,
      );
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
    await this.#policy.recordDecision(decision, context, undefined, {
      details: { phase: "completed" },
    });
  }

  /** Loads current metadata for a secret. */
  async #metadataResponse(actorId: string, secretId: string): Promise<SecretMetadata> {
    const secret = await this.#repository.findSecretById(this.#database, secretId);
    if (secret === undefined) {
      throw new SecretServiceError(404, "secret_not_found", "Resource not found");
    }
    const current =
      secret.currentVersionId === null
        ? null
        : ((await this.#repository.findVersionMetadata(
            this.#database,
            secret.id,
            secret.currentVersionId,
          )) ?? null);
    const consumers = await this.#repository.listConsumers(this.#database, secret.projectId, [
      secret.id,
    ]);
    const capabilities = await this.#capabilities(actorId, secret);
    return this.#metadata(secret, current, consumers.get(secret.id) ?? [], capabilities);
  }

  /**
   * Chooses the public denial for a name-addressed route.
   *
   * A caller that can list secrets in the project already knows which names
   * exist, so 403 is accurate. A caller that cannot list gets the same 404 for
   * an existing and a missing name.
   */
  async #denyName(
    decision: PolicyDecision,
    notFoundCode: "project_not_found" | "secret_not_found",
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<SecretServiceError> {
    const canList = await canListCollection({
      policy: this.#policy,
      actorId: decision.actorId,
      listAction: "secret.list",
      projectId,
      ...(context === undefined ? {} : { context }),
    });
    return denialError(notFoundCode, !canList);
  }

  /**
   * Resolves an active project by name.
   *
   * Name-addressed routes use the secret-specific not-found code so a caller
   * cannot distinguish a missing project from a missing secret. The list route
   * keeps the project code because it has no secret name.
   */
  async #activeProject(
    name: string,
    notFoundCode: "project_not_found" | "secret_not_found" = "secret_not_found",
  ) {
    if (!projectNameSchema.safeParse(name).success) {
      throw new SecretServiceError(
        404,
        notFoundCode,
        notFoundCode === "project_not_found" ? "Project not found" : "Resource not found",
      );
    }
    const project = await this.#projectRepository.findActiveByName(this.#database, name);
    if (project === undefined) {
      throw new SecretServiceError(
        404,
        notFoundCode,
        notFoundCode === "project_not_found" ? "Project not found" : "Resource not found",
      );
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
    currentVersion: SecretVersionMetadata | null,
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
  #version(version: SecretVersionMetadata): SecretVersion {
    return {
      id: version.id,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
      expiresAt: version.expiresAt?.toISOString() ?? null,
    };
  }

  /** Maps one version to a summary with status and current flag. */
  #versionSummary(version: SecretVersionMetadata, currentId: string | null): SecretVersionSummary {
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
    version: SecretVersionMetadata,
  ): Promise<SecretWriteResponse> {
    const current =
      secret.currentVersionId === null
        ? null
        : ((await this.#repository.findVersionMetadata(
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

  /** Loads a write response for an idempotent replay with ownership checks. */
  async #loadWriteResponse(
    actorId: string,
    versionId: string,
    projectId: string,
    name: string,
    secretId?: string,
  ): Promise<SecretWriteResponse> {
    const found = await this.#repository.findVersionById(this.#database, versionId);
    if (
      found === undefined ||
      found.secret.projectId !== projectId ||
      found.secret.name !== name ||
      (secretId !== undefined && found.secret.id !== secretId)
    ) {
      throw new SecretServiceError(409, "idempotency_conflict", "Idempotency conflict");
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
    versionId?: string,
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
        details: {
          reason,
          policyVersion: decision.policyVersion,
          ...(versionId === undefined ? {} : { version: versionId }),
        },
      });
    } catch {
      throw new PolicyUnavailableError();
    }
  }
}

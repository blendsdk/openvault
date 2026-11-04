import type { AgentCertificateResponse, AgentConsumer } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AuditUnavailableError } from "../audit/errors.js";
import type { AuditRecorder, AuditRequestContext } from "../audit/types.js";
import type { OpenVaultConfig } from "../config/index.js";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { type CaSigner, CaSignerUnavailableError } from "../security/ca.js";
import { CsrValidationError, parseAgentCsr } from "../security/x509.js";
import { CERTIFICATE_ATTEMPTS, isCertificateConflict } from "./certificate-retry.js";
import {
  type ConsumerChange,
  type ConsumerRecord,
  type ConsumerRepository,
  classifyConsumerChange,
} from "./consumer-repository.js";
import { AgentServiceError } from "./errors.js";
import type { AgentAuthContext } from "./types.js";

/** Five-minute replay window for a lost renewal response. */
const REPLAY_TTL_MS = 5 * 60_000;
/** Maximum replay entries retained by one process. */
const REPLAY_CACHE_LIMIT = 1_024;

interface CachedRenewal {
  readonly expiresAt: number;
  readonly response: AgentCertificateResponse;
}

/**
 * Bounded process-local cache for renewal responses.
 *
 * A retry with the same principal and public key returns the exact response
 * issued moments earlier, so a lost HTTP response cannot force a rejoin. The
 * cache is not shared between processes and is cleared when an identity is
 * revoked.
 */
export class RenewalReplayCache {
  readonly #entries = new Map<string, CachedRenewal>();
  readonly #now: () => number;
  readonly #limit: number;

  /**
   * @param options - Injectable clock and optional size bound.
   */
  public constructor(options: { readonly now?: () => number; readonly limit?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#limit = options.limit ?? REPLAY_CACHE_LIMIT;
  }

  /**
   * Reads one unexpired response.
   *
   * @param principalId - Service principal.
   * @param publicKeySha256 - CSR SPKI hash.
   * @returns The cached response, or undefined.
   */
  public get(principalId: string, publicKeySha256: string): AgentCertificateResponse | undefined {
    this.#prune();
    const key = `${principalId}:${publicKeySha256}`;
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.response;
  }

  /**
   * Stores one response for five minutes.
   *
   * @param principalId - Service principal.
   * @param publicKeySha256 - CSR SPKI hash.
   * @param response - Response to replay.
   */
  public set(
    principalId: string,
    publicKeySha256: string,
    response: AgentCertificateResponse,
  ): void {
    this.#prune();
    const key = `${principalId}:${publicKeySha256}`;
    this.#entries.delete(key);
    while (this.#entries.size >= this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { expiresAt: this.#now() + REPLAY_TTL_MS, response });
  }

  /**
   * Removes every entry owned by a revoked principal.
   *
   * @param principalId - Service principal.
   */
  public invalidatePrincipal(principalId: string): void {
    const prefix = `${principalId}:`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key);
      }
    }
  }

  /** Removes every entry. */
  public clear(): void {
    this.#entries.clear();
  }

  /** Current number of retained entries after pruning. */
  public get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  /** Drops expired entries. */
  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}

/** Principal state loaded under the renewal lock. */
interface LockedRenewIdentity {
  readonly id: string;
  readonly owner_project_id: string;
  readonly status: string;
  readonly project_deleted_at: Date | null;
}

/** Newest eligible certificate row. */
interface NewestCertificate {
  readonly id: string;
  readonly not_before: Date;
  readonly not_after: Date;
}

/** One renewal request accepted by the service. */
export interface AgentRenewInput {
  /** Fresh CSR PEM. */
  readonly csr: string;
  /** Self-reported consumer metadata. */
  readonly consumer: AgentConsumer;
}

/** Mutable state captured for one renewal failure event. */
interface RenewAuditState {
  readonly principalId: string;
  projectId?: string;
}

/**
 * Renews one authenticated agent certificate.
 *
 * The authenticating certificate must be the newest live certificate and must
 * be at least two thirds through its actual validity window. A fresh key is
 * required, except when the same public key is retried inside the replay
 * window.
 */
export class AgentRenewService {
  readonly #database: PostgreSQLDatabase;
  readonly #consumers: ConsumerRepository;
  readonly #signer: CaSigner;
  readonly #config: Pick<OpenVaultConfig, "certTtlDays">;
  readonly #cache: RenewalReplayCache;
  readonly #now: () => number;
  readonly #audit: AuditRecorder | undefined;
  readonly #queues = new Map<string, Promise<void>>();

  /**
   * @param options - Database, consumer repository, CA signer, config, and cache.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly consumers: ConsumerRepository;
    readonly signer: CaSigner;
    readonly config: Pick<OpenVaultConfig, "certTtlDays">;
    readonly cache?: RenewalReplayCache;
    readonly now?: () => number;
    /** Persistent audit sink; omitted only by isolated unit tests. */
    readonly audit?: AuditRecorder;
  }) {
    this.#database = options.database;
    this.#consumers = options.consumers;
    this.#audit = options.audit;
    this.#signer = options.signer;
    this.#config = options.config;
    this.#cache =
      options.cache ??
      new RenewalReplayCache(options.now === undefined ? {} : { now: options.now });
    this.#now = options.now ?? Date.now;
  }

  /**
   * Renews one certificate after authentication.
   *
   * @param context - Authenticated peer-certificate context.
   * @param input - Fresh CSR and consumer metadata.
   * @returns The new or replayed certificate response.
   * @throws {AgentServiceError} For validation, liveness, and lifecycle failures.
   */
  public async renew(
    context: AgentAuthContext,
    input: AgentRenewInput,
    auditContext: AuditRequestContext = { requestId: "internal" },
  ): Promise<AgentCertificateResponse> {
    const state: RenewAuditState = { principalId: context.principalId };
    try {
      return await this.#renew(context, input, state, auditContext);
    } catch (error) {
      if (error instanceof AuditUnavailableError || this.#audit === undefined) {
        throw error;
      }
      await this.#recordFailure(error, state, auditContext);
      throw error;
    }
  }

  /** Runs one renewal attempt and records the state needed by a failure event. */
  async #renew(
    context: AgentAuthContext,
    input: AgentRenewInput,
    state: RenewAuditState,
    auditContext: AuditRequestContext,
  ): Promise<AgentCertificateResponse> {
    let csr: Awaited<ReturnType<typeof parseAgentCsr>>;
    try {
      csr = await parseAgentCsr(input.csr);
    } catch (error) {
      if (error instanceof CsrValidationError) {
        throw new AgentServiceError(422, "validation_error", "Validation failed", "invalid_csr");
      }
      throw error;
    }

    const replay = this.#cache.get(context.principalId, csr.publicKeySha256);
    if (replay !== undefined) {
      return replay;
    }
    if (csr.publicKeySha256 === context.publicKeySha256) {
      throw new AgentServiceError(422, "validation_error", "Validation failed", "invalid_csr");
    }

    return this.#serialize(context.principalId, async () => {
      // A concurrent renewal for the same principal may have completed while
      // this request waited for the in-process queue.
      const queuedReplay = this.#cache.get(context.principalId, csr.publicKeySha256);
      if (queuedReplay !== undefined) {
        return queuedReplay;
      }

      for (let attempt = 1; attempt <= CERTIFICATE_ATTEMPTS; attempt += 1) {
        try {
          const response = await this.#database.withTransaction(async (tx) => {
            const locked = await this.#lockIdentity(tx, context.principalId);
            if (locked !== undefined) {
              state.projectId = locked.owner_project_id;
            }
            if (locked === undefined || locked.status !== "active") {
              throw new AgentServiceError(
                401,
                "authentication_required",
                "Authentication required",
                "principal_inactive",
              );
            }
            if (locked.project_deleted_at !== null) {
              throw new AgentServiceError(
                401,
                "authentication_required",
                "Authentication required",
                "project_inactive",
              );
            }

            const project = await tx.executeQuery<{ readonly deleted_at: Date | null }>(
              "SELECT deleted_at FROM projects WHERE id = :projectId FOR SHARE",
              { projectId: locked.owner_project_id },
            );
            if (project.records[0] === undefined || project.records[0].deleted_at !== null) {
              throw new AgentServiceError(
                401,
                "authentication_required",
                "Authentication required",
                "project_inactive",
              );
            }

            const newest = await this.#newestCertificate(tx, context.principalId);
            if (newest === undefined || newest.id !== context.certificateId) {
              throw new AgentServiceError(
                409,
                "renewal_not_current",
                "Certificate is not current",
                "renewal_not_current",
              );
            }

            const threshold =
              newest.not_before.getTime() +
              Math.floor(((newest.not_after.getTime() - newest.not_before.getTime()) * 2) / 3);
            if (this.#now() < threshold) {
              throw new AgentServiceError(
                409,
                "renewal_not_due",
                "Certificate renewal is not due",
                "renewal_not_due",
              );
            }

            let issued: Awaited<ReturnType<CaSigner["issueClientCertificate"]>>;
            try {
              issued = await this.#signer.issueClientCertificate(
                csr,
                locked.id,
                this.#config.certTtlDays,
              );
            } catch (error) {
              if (error instanceof CaSignerUnavailableError) {
                throw new AgentServiceError(
                  503,
                  "ca_unavailable",
                  "Certificate authority unavailable",
                  "ca_unavailable",
                );
              }
              throw error;
            }

            await tx.executeQuery(
              `INSERT INTO workload_certs
                 (id, principal_id, serial, fingerprint, not_before, not_after, issued_at)
               VALUES
                 (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter,
                  clock_timestamp())`,
              {
                id: newUlid(),
                principalId: locked.id,
                serial: issued.serial,
                fingerprint: issued.fingerprint,
                notBefore: issued.notBefore,
                notAfter: issued.notAfter,
              },
            );
            const previous = await this.#consumers.findForUpdate(locked.id, tx);
            const consumer = await this.#consumers.upsert(tx, {
              principalId: locked.id,
              projectId: locked.owner_project_id,
              consumer: input.consumer,
            });
            if (this.#audit !== undefined) {
              await this.#audit.record(
                {
                  projectId: locked.owner_project_id,
                  requestId: auditContext.requestId ?? "internal",
                  actorId: locked.id,
                  actorKind: "service",
                  action: "agent.renew",
                  scopeType: "project",
                  scopeId: locked.owner_project_id,
                  objectType: "identity",
                  objectId: locked.id,
                  result: "allow",
                  sourceIp: auditContext.sourceIp ?? null,
                  userAgent: auditContext.userAgent ?? null,
                  details: {
                    consumerId: consumer.id,
                    certificateSerial: issued.serial,
                  },
                },
                tx,
              );
              await this.#recordConsumerChange(
                tx,
                locked.owner_project_id,
                locked.id,
                consumer,
                classifyConsumerChange(previous, consumer),
                auditContext,
              );
            }

            return {
              certificatePem: issued.certificatePem,
              chainPem: this.#signer.certificatePem,
              identityId: locked.id,
              serial: issued.serial,
              notAfter: issued.notAfter.toISOString(),
            };
          });

          this.#cache.set(context.principalId, csr.publicKeySha256, response);
          return response;
        } catch (error) {
          if (isCertificateConflict(error)) {
            if (attempt < CERTIFICATE_ATTEMPTS) {
              continue;
            }
            throw new AgentServiceError(
              503,
              "ca_unavailable",
              "Certificate authority unavailable",
              "certificate_conflict",
            );
          }
          throw error;
        }
      }

      throw new AgentServiceError(
        503,
        "ca_unavailable",
        "Certificate authority unavailable",
        "ca_unavailable",
      );
    });
  }

  /** Records one consumer register or update event inside the renewal transaction. */
  async #recordConsumerChange(
    tx: QueryExecutor,
    projectId: string,
    principalId: string,
    consumer: ConsumerRecord,
    change: ConsumerChange | null,
    context: AuditRequestContext,
  ): Promise<void> {
    if (change === null || this.#audit === undefined) {
      return;
    }
    const details: Record<string, string | readonly string[]> = {
      consumerId: consumer.id,
      composeProject: consumer.composeProject,
      composeService: consumer.composeService,
      hostname: consumer.hostname,
      manifestHash: consumer.manifestHash,
      state: consumer.state,
    };
    if (change.kind === "update") {
      details.changed = change.changed;
    }
    await this.#audit.record(
      {
        projectId,
        requestId: context.requestId ?? "internal",
        actorId: principalId,
        actorKind: "service",
        action: change.kind === "register" ? "consumer.register" : "consumer.update",
        scopeType: "project",
        scopeId: projectId,
        objectType: "consumer",
        objectId: consumer.id,
        result: "allow",
        sourceIp: context.sourceIp ?? null,
        userAgent: context.userAgent ?? null,
        details,
      },
      tx,
    );
  }

  /** Records one independent renewal failure event. */
  async #recordFailure(
    error: unknown,
    state: RenewAuditState,
    context: AuditRequestContext,
  ): Promise<void> {
    if (this.#audit === undefined) {
      return;
    }
    const reason =
      error instanceof AgentServiceError ? (error.reason ?? "internal_error") : "internal_error";
    const result =
      reason === "ca_unavailable" ||
      reason === "certificate_conflict" ||
      reason === "internal_error"
        ? "error"
        : "deny";
    const projectId = state.projectId;
    await this.#audit.record({
      projectId: projectId ?? null,
      requestId: context.requestId ?? "internal",
      actorId: state.principalId,
      actorKind: "service",
      action: "agent.renew",
      scopeType: projectId === undefined ? "system" : "project",
      scopeId: projectId ?? null,
      objectType: null,
      objectId: null,
      result,
      sourceIp: context.sourceIp ?? null,
      userAgent: context.userAgent ?? null,
      details: { reason },
    });
  }

  /**
   * Serializes renewal work for one principal inside this process.
   *
   * The database principal lock remains the cross-process authority. The
   * in-process queue closes the small window between commit and replay-cache
   * publication for overlapping retries.
   *
   * @param principalId - Service principal.
   * @param action - Renewal action.
   * @returns The action result.
   */
  async #serialize<T>(principalId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(principalId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#queues.set(principalId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release?.();
      if (this.#queues.get(principalId) === tail) {
        this.#queues.delete(principalId);
      }
    }
  }

  /**
   * Clears replay entries for a revoked identity.
   *
   * @param principalId - Service principal.
   */
  public invalidatePrincipal(principalId: string): void {
    this.#cache.invalidatePrincipal(principalId);
  }

  /** Clears the whole replay cache. */
  public clear(): void {
    this.#cache.clear();
  }

  /** Locks the service principal and reads its active-project state. */
  async #lockIdentity(
    tx: QueryExecutor,
    principalId: string,
  ): Promise<LockedRenewIdentity | undefined> {
    const result = await tx.executeQuery<LockedRenewIdentity>(
      `SELECT p.id, p.owner_project_id, p.status, pr.deleted_at AS project_deleted_at
         FROM principals p
         JOIN projects pr ON pr.id = p.owner_project_id
        WHERE p.id = :principalId AND p.kind = 'service'
        FOR UPDATE OF p`,
      { principalId },
    );
    return result.records[0];
  }

  /** Selects the newest unexpired, unrevoked certificate. */
  async #newestCertificate(
    tx: QueryExecutor,
    principalId: string,
  ): Promise<NewestCertificate | undefined> {
    const result = await tx.executeQuery<NewestCertificate>(
      `SELECT id, not_before, not_after
         FROM workload_certs
        WHERE principal_id = :principalId
          AND revoked_at IS NULL
          AND not_after > now()
        ORDER BY issued_at DESC, id DESC
        LIMIT 1`,
      { principalId },
    );
    return result.records[0];
  }
}

import { createHash } from "node:crypto";
import type { AgentCertificateResponse, AgentConsumer } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AuditUnavailableError } from "../audit/errors.js";
import type { AuditRecorder, AuditRequestContext } from "../audit/types.js";
import type { OpenVaultConfig } from "../config/index.js";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { type CaSigner, CaSignerUnavailableError } from "../security/ca.js";
import { CsrValidationError, parseAgentCsr } from "../security/x509.js";
import type { AgentTokenService } from "./agent-token-service.js";
import { CERTIFICATE_ATTEMPTS, isCertificateConflict } from "./certificate-retry.js";
import {
  type ConsumerChange,
  type ConsumerRecord,
  type ConsumerRepository,
  classifyConsumerChange,
} from "./consumer-repository.js";
import { AgentServiceError } from "./errors.js";

/** Principal state loaded under the join lock. */
interface LockedJoinIdentity {
  readonly id: string;
  readonly owner_project_id: string;
  readonly status: string;
  readonly project_deleted_at: Date | null;
}

/** One consumer payload accepted by the join service. */
export interface AgentJoinInput {
  /** Raw join token. */
  readonly token: string;
  /** CSR PEM. */
  readonly csr: string;
  /** Self-reported consumer metadata. */
  readonly consumer: AgentConsumer;
}

/** Hashes a raw join token with SHA-256. */
export function joinTokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Completes one join: validates the CSR, locks the identity, claims the token,
 * signs a fixed-profile certificate, and writes the certificate and consumer.
 *
 * The CSR is validated before the token is touched, so a malformed request
 * never consumes a valid token. All database writes share one transaction.
 */
export class AgentJoinService {
  readonly #database: PostgreSQLDatabase;
  readonly #tokens: AgentTokenService;
  readonly #consumers: ConsumerRepository;
  readonly #signer: CaSigner;
  readonly #config: Pick<OpenVaultConfig, "certTtlDays">;
  readonly #audit: AuditRecorder | undefined;

  /**
   * @param options - Database, token service, consumer repository, CA signer, config, and audit sink.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly tokens: AgentTokenService;
    readonly consumers: ConsumerRepository;
    readonly signer: CaSigner;
    readonly config: Pick<OpenVaultConfig, "certTtlDays">;
    /** Persistent audit sink; omitted only by isolated unit tests. */
    readonly audit?: AuditRecorder;
  }) {
    this.#database = options.database;
    this.#tokens = options.tokens;
    this.#consumers = options.consumers;
    this.#signer = options.signer;
    this.#config = options.config;
    this.#audit = options.audit;
  }

  /**
   * Joins one service identity.
   *
   * @param input - Token, CSR, and consumer metadata.
   * @param context - Optional request metadata.
   * @returns Certificate material and the identity id.
   * @throws {AgentServiceError} For validation, authentication, or CA failures.
   */
  public async join(
    input: AgentJoinInput,
    context: AuditRequestContext = { requestId: "internal" },
  ): Promise<AgentCertificateResponse> {
    const state: JoinAuditState = {};
    try {
      return await this.#join(input, state, context);
    } catch (error) {
      if (error instanceof AuditUnavailableError || this.#audit === undefined) {
        throw error;
      }
      await this.#recordFailure(error, state, context);
      throw error;
    }
  }

  /** Runs one join attempt and records the state needed by a failure event. */
  async #join(
    input: AgentJoinInput,
    state: JoinAuditState,
    context: AuditRequestContext,
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

    const tokenHash = joinTokenHash(input.token);
    const token = await this.#tokens.findByHash(tokenHash);
    if (token === undefined) {
      throw new AgentServiceError(401, "join_failed", "Join failed", "join_token_unknown");
    }
    state.principalId = token.principalId;
    state.projectId = token.projectId;
    if (token.revokedAt !== null) {
      throw new AgentServiceError(401, "join_failed", "Join failed", "join_token_revoked");
    }
    if (token.usedAt !== null) {
      throw new AgentServiceError(401, "join_failed", "Join failed", "join_token_used");
    }
    if (token.expiresAt.getTime() <= Date.now()) {
      throw new AgentServiceError(401, "join_failed", "Join failed", "join_token_expired");
    }

    for (let attempt = 1; attempt <= CERTIFICATE_ATTEMPTS; attempt += 1) {
      try {
        return await this.#database.withTransaction(async (tx) => {
          const locked = await this.#lockIdentity(tx, token.principalId);
          if (locked === undefined || locked.status !== "active") {
            throw new AgentServiceError(401, "join_failed", "Join failed", "principal_inactive");
          }
          if (locked.project_deleted_at !== null) {
            throw new AgentServiceError(401, "join_failed", "Join failed", "project_inactive");
          }

          const project = await tx.executeQuery<{ readonly deleted_at: Date | null }>(
            "SELECT deleted_at FROM projects WHERE id = :projectId FOR SHARE",
            { projectId: locked.owner_project_id },
          );
          if (project.records[0] === undefined || project.records[0].deleted_at !== null) {
            throw new AgentServiceError(401, "join_failed", "Join failed", "project_inactive");
          }

          const claimed = await this.#tokens.claim(tx, tokenHash);
          if (
            claimed === undefined ||
            claimed.principalId !== locked.id ||
            claimed.projectId !== locked.owner_project_id
          ) {
            throw new AgentServiceError(
              401,
              "join_failed",
              "Join failed",
              await this.#claimFailureReason(tokenHash),
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
                requestId: context.requestId ?? "internal",
                actorId: locked.id,
                actorKind: "service",
                action: "agent.join",
                scopeType: "project",
                scopeId: locked.owner_project_id,
                objectType: "identity",
                objectId: locked.id,
                result: "allow",
                sourceIp: context.sourceIp ?? null,
                userAgent: context.userAgent ?? null,
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
              context,
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
  }

  /** Records one consumer register or update event inside the join transaction. */
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

  /** Records one independent join failure event. */
  async #recordFailure(
    error: unknown,
    state: JoinAuditState,
    context: AuditRequestContext,
  ): Promise<void> {
    if (this.#audit === undefined) {
      return;
    }
    const reason =
      error instanceof AgentServiceError ? (error.reason ?? "internal_error") : "internal_error";
    const serviceActor =
      reason === "join_token_used" ||
      reason === "join_token_revoked" ||
      reason === "join_token_claim_failed" ||
      reason === "ca_unavailable" ||
      reason === "certificate_conflict";
    const projectScope =
      state.projectId !== undefined &&
      reason !== "invalid_csr" &&
      reason !== "join_token_unknown" &&
      reason !== "join_token_expired";
    const result =
      reason === "ca_unavailable" ||
      reason === "certificate_conflict" ||
      reason === "internal_error"
        ? "error"
        : "deny";
    await this.#audit.record({
      projectId: projectScope ? (state.projectId ?? null) : null,
      requestId: context.requestId ?? "internal",
      actorId: serviceActor ? (state.principalId ?? null) : null,
      actorKind: serviceActor ? "service" : "system",
      action: "agent.join",
      scopeType: projectScope ? "project" : "system",
      scopeId: projectScope ? (state.projectId ?? null) : null,
      objectType: null,
      objectId: null,
      result,
      sourceIp: context.sourceIp ?? null,
      userAgent: context.userAgent ?? null,
      details: { reason },
    });
  }

  /** Re-reads a token after a lost claim to report the terminal state. */
  async #claimFailureReason(
    tokenHash: Buffer,
  ): Promise<
    "join_token_expired" | "join_token_used" | "join_token_revoked" | "join_token_claim_failed"
  > {
    const latest = await this.#tokens.findByHash(tokenHash);
    if (latest?.revokedAt != null) {
      return "join_token_revoked";
    }
    if (latest?.usedAt != null) {
      return "join_token_used";
    }
    if (latest !== undefined && latest.expiresAt.getTime() <= Date.now()) {
      return "join_token_expired";
    }
    return "join_token_claim_failed";
  }

  /** Locks the service principal and reads its active-project state. */
  async #lockIdentity(
    tx: QueryExecutor,
    principalId: string,
  ): Promise<LockedJoinIdentity | undefined> {
    const result = await tx.executeQuery<LockedJoinIdentity>(
      `SELECT p.id, p.owner_project_id, p.status, pr.deleted_at AS project_deleted_at
         FROM principals p
         JOIN projects pr ON pr.id = p.owner_project_id
        WHERE p.id = :principalId AND p.kind = 'service'
        FOR UPDATE OF p`,
      { principalId },
    );
    return result.records[0];
  }
}

/** Mutable state captured for one join failure event. */
interface JoinAuditState {
  principalId?: string;
  projectId?: string;
}

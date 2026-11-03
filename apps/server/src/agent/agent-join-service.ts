import { createHash } from "node:crypto";
import type { AgentCertificateResponse, AgentConsumer } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { OpenVaultConfig } from "../config/index.js";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { type CaSigner, CaSignerUnavailableError } from "../security/ca.js";
import { CsrValidationError, parseAgentCsr } from "../security/x509.js";
import type { AgentTokenService } from "./agent-token-service.js";
import type { ConsumerRepository } from "./consumer-repository.js";
import { AgentServiceError } from "./errors.js";

/** Maximum serial-collision retries for one join. */
const SERIAL_RETRIES = 3;

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

/** Returns true for a unique-violation on the certificate serial. */
function isSerialConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = Reflect.get(error, "code");
  const constraint = Reflect.get(error, "constraint");
  return (
    code === "23505" &&
    typeof constraint === "string" &&
    constraint.includes("workload_certs_serial")
  );
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

  /**
   * @param options - Database, token service, consumer repository, CA signer, and config.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly tokens: AgentTokenService;
    readonly consumers: ConsumerRepository;
    readonly signer: CaSigner;
    readonly config: Pick<OpenVaultConfig, "certTtlDays">;
  }) {
    this.#database = options.database;
    this.#tokens = options.tokens;
    this.#consumers = options.consumers;
    this.#signer = options.signer;
    this.#config = options.config;
  }

  /**
   * Joins one service identity.
   *
   * @param input - Token, CSR, and consumer metadata.
   * @returns Certificate material and the identity id.
   * @throws {AgentServiceError} For validation, authentication, or CA failures.
   */
  public async join(input: AgentJoinInput): Promise<AgentCertificateResponse> {
    let csr: Awaited<ReturnType<typeof parseAgentCsr>>;
    try {
      csr = await parseAgentCsr(input.csr);
    } catch (error) {
      if (error instanceof CsrValidationError) {
        throw new AgentServiceError(422, "validation_error", "Validation failed");
      }
      throw error;
    }

    const tokenHash = joinTokenHash(input.token);
    const token = await this.#tokens.findByHash(tokenHash);
    if (token === undefined) {
      throw new AgentServiceError(401, "join_failed", "Join failed");
    }

    for (let attempt = 1; attempt <= SERIAL_RETRIES; attempt += 1) {
      try {
        return await this.#database.withTransaction(async (tx) => {
          const locked = await this.#lockIdentity(tx, token.principalId);
          if (
            locked === undefined ||
            locked.status !== "active" ||
            locked.project_deleted_at !== null
          ) {
            throw new AgentServiceError(401, "join_failed", "Join failed");
          }

          const claimed = await this.#tokens.claim(tx, tokenHash);
          if (
            claimed === undefined ||
            claimed.principalId !== locked.id ||
            claimed.projectId !== locked.owner_project_id
          ) {
            throw new AgentServiceError(401, "join_failed", "Join failed");
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
              );
            }
            throw error;
          }

          await tx.executeQuery(
            `INSERT INTO workload_certs
               (id, principal_id, serial, fingerprint, not_before, not_after)
             VALUES
               (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter)`,
            {
              id: newUlid(),
              principalId: locked.id,
              serial: issued.serial,
              fingerprint: issued.fingerprint,
              notBefore: issued.notBefore,
              notAfter: issued.notAfter,
            },
          );
          await this.#consumers.upsert(tx, {
            principalId: locked.id,
            projectId: locked.owner_project_id,
            consumer: input.consumer,
          });

          return {
            certificatePem: issued.certificatePem,
            chainPem: this.#signer.certificatePem,
            identityId: locked.id,
            serial: issued.serial,
            notAfter: issued.notAfter.toISOString(),
          };
        });
      } catch (error) {
        if (isSerialConflict(error)) {
          if (attempt < SERIAL_RETRIES) {
            continue;
          }
          throw new AgentServiceError(503, "ca_unavailable", "Certificate authority unavailable");
        }
        throw error;
      }
    }

    throw new AgentServiceError(503, "ca_unavailable", "Certificate authority unavailable");
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

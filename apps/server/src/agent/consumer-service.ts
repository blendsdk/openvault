import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";
import type { AuditQueryExecutor, AuditRecorder, AuditRequestContext } from "../audit/types.js";
import type { ConsumerRecord, ConsumerRepository } from "./consumer-repository.js";

/** Options for {@link AgentConsumerService}. */
export interface AgentConsumerServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Consumer persistence. */
  readonly consumers: ConsumerRepository;
  /** Audit sink; absent only in isolated unit tests. */
  readonly audit?: AuditRecorder;
  /** Structured logger. */
  readonly logger?: Logger;
}

/** The allowlisted consumer state. */
export type ConsumerState = "ok" | "degraded" | "failed";

/**
 * Updates one agent's consumer heartbeat.
 *
 * A `last_seen`-only update is not audited. A state change writes one
 * `consumer.update` event in the same transaction as the update. Audit or
 * database failures are caught, logged, and do not fail the data read; the
 * next heartbeat retries.
 */
export class AgentConsumerService {
  readonly #database: PostgreSQLDatabase;
  readonly #consumers: ConsumerRepository;
  readonly #audit: AuditRecorder | undefined;
  readonly #logger: Logger | undefined;

  /**
   * @param options - Database, consumer repository, audit sink, and logger.
   */
  public constructor(options: AgentConsumerServiceOptions) {
    this.#database = options.database;
    this.#consumers = options.consumers;
    this.#audit = options.audit;
    this.#logger = options.logger;
  }

  /**
   * Applies one best-effort heartbeat.
   *
   * @param principalId - Authenticated service principal.
   * @param state - Aggregate delivery state.
   * @param context - Optional request metadata.
   */
  public async update(
    principalId: string,
    state: ConsumerState,
    context: AuditRequestContext = { requestId: "internal" },
  ): Promise<void> {
    try {
      await this.#database.withTransaction(async (tx) => {
        const previous = await this.#consumers.findForUpdate(principalId, tx);
        if (previous === undefined) {
          return;
        }
        if (previous.state === state) {
          await this.#consumers.touchConsumer(tx, principalId, state);
          return;
        }
        const next = await this.#consumers.updateState(tx, principalId, state);
        if (next === undefined || this.#audit === undefined) {
          return;
        }
        await this.#recordStateChange(next, context, tx);
      });
    } catch (error) {
      await this.#logger?.warn("consumer_heartbeat_failed", {
        principalId,
        code: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** Writes one consumer.update event for a state transition. */
  async #recordStateChange(
    next: ConsumerRecord,
    context: AuditRequestContext,
    tx: AuditQueryExecutor,
  ): Promise<void> {
    if (this.#audit === undefined) {
      return;
    }
    await this.#audit.record(
      {
        projectId: next.projectId,
        requestId: context.requestId ?? "internal",
        actorId: next.principalId,
        actorKind: "service",
        action: "consumer.update",
        scopeType: "project",
        scopeId: next.projectId,
        objectType: "consumer",
        objectId: next.id,
        result: "allow",
        sourceIp: context.sourceIp ?? null,
        userAgent: context.userAgent ?? null,
        details: {
          consumerId: next.id,
          composeProject: next.composeProject,
          composeService: next.composeService,
          hostname: next.hostname,
          manifestHash: next.manifestHash,
          state: next.state,
          changed: ["state"],
        },
      },
      tx,
    );
  }
}

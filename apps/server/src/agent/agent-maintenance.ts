import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;

/** Counts deleted by one maintenance run. */
export interface AgentMaintenanceResult {
  /** Expired/used/revoked tokens deleted. */
  readonly tokens: number;
  /** Expired/revoked certificates deleted. */
  readonly certificates: number;
}

/** Cleanup operations over the agent tables. */
export interface AgentMaintenanceRepository {
  /** Deletes at most `limit` retained-out tokens. */
  cleanupTokens(limit: number): Promise<number>;
  /** Deletes at most `limit` retained-out certificates. */
  cleanupCertificates(limit: number): Promise<number>;
}

/** SQL-backed retention repository. */
export class DatabaseAgentMaintenanceRepository implements AgentMaintenanceRepository {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param database - Connected database.
   */
  public constructor(database: PostgreSQLDatabase) {
    this.#database = database;
  }

  /** @inheritDoc */
  public async cleanupTokens(limit: number): Promise<number> {
    const result = await this.#database.executeQuery(
      `DELETE FROM join_tokens
        WHERE id IN (
          SELECT id
            FROM join_tokens
           WHERE expires_at < now() - interval '24 hours'
             AND (used_at IS NULL OR used_at < now() - interval '24 hours')
             AND (revoked_at IS NULL OR revoked_at < now() - interval '24 hours')
           ORDER BY expires_at
           LIMIT :limit
        )`,
      { limit },
    );
    return result.rowCount ?? 0;
  }

  /** @inheritDoc */
  public async cleanupCertificates(limit: number): Promise<number> {
    const result = await this.#database.executeQuery(
      `DELETE FROM workload_certs
        WHERE id IN (
          SELECT id
            FROM workload_certs
           WHERE not_after < now() - interval '30 days'
             AND (revoked_at IS NULL OR revoked_at < now() - interval '30 days')
           ORDER BY not_after
           LIMIT :limit
        )`,
      { limit },
    );
    return result.rowCount ?? 0;
  }
}

/** Options for {@link AgentMaintenanceService}. */
export interface AgentMaintenanceOptions {
  /** Retention repository. */
  readonly repository: AgentMaintenanceRepository;
  /** Structured logger for background failures. */
  readonly logger: Logger;
  /** Scheduler interval in milliseconds; defaults to 24 hours. */
  readonly intervalMs?: number;
  /** Rows deleted per table per run; defaults to 1,000. */
  readonly batchSize?: number;
}

/**
 * Runs bounded token and certificate retention cleanup at startup and daily.
 *
 * A failed run is logged with a fixed code and never blocks authentication or
 * startup. The timer is unref'd so it cannot keep a test process alive.
 */
export class AgentMaintenanceService {
  readonly #repository: AgentMaintenanceRepository;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #started = false;

  /**
   * @param options - Repository, logger, interval, and batch size.
   */
  public constructor(options: AgentMaintenanceOptions) {
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Runs one cleanup and schedules the next daily run.
   *
   * The initial failure is logged and swallowed. Calling `start` twice is a
   * no-op.
   */
  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#timer = setInterval(() => {
      void this.#runScheduled();
    }, this.#intervalMs);
    this.#timer.unref?.();
    try {
      await this.runOnce();
    } catch {
      await this.#logFailure();
    }
  }

  /**
   * Runs one bounded cleanup immediately.
   *
   * @returns Deleted token and certificate counts.
   */
  public async runOnce(): Promise<AgentMaintenanceResult> {
    const tokens = await this.#repository.cleanupTokens(this.#batchSize);
    const certificates = await this.#repository.cleanupCertificates(this.#batchSize);
    return { tokens, certificates };
  }

  /** Stops the scheduler. The operation is idempotent. */
  public stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#started = false;
  }

  async #runScheduled(): Promise<void> {
    try {
      await this.runOnce();
    } catch {
      await this.#logFailure();
    }
  }

  async #logFailure(): Promise<void> {
    await this.#logger
      .error("Agent cleanup failed", { code: "agent_cleanup_failed" })
      .catch(() => undefined);
  }
}

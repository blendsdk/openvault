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
      `DELETE FROM join_tokens t
        WHERE t.id IN (
          SELECT id
            FROM join_tokens
           WHERE expires_at < now() - interval '24 hours'
             AND (used_at IS NULL OR used_at < now() - interval '24 hours')
             AND (revoked_at IS NULL OR revoked_at < now() - interval '24 hours')
           ORDER BY expires_at
           FOR UPDATE SKIP LOCKED
           LIMIT :limit
        )
        AND t.expires_at < now() - interval '24 hours'
        AND (t.used_at IS NULL OR t.used_at < now() - interval '24 hours')
        AND (t.revoked_at IS NULL OR t.revoked_at < now() - interval '24 hours')`,
      { limit },
    );
    return result.rowCount ?? 0;
  }

  /** @inheritDoc */
  public async cleanupCertificates(limit: number): Promise<number> {
    const result = await this.#database.executeQuery(
      `DELETE FROM workload_certs c
        WHERE c.id IN (
          SELECT id
            FROM workload_certs
           WHERE not_after < now() - interval '30 days'
             AND (revoked_at IS NULL OR revoked_at < now() - interval '30 days')
           ORDER BY not_after
           FOR UPDATE SKIP LOCKED
           LIMIT :limit
        )
        AND c.not_after < now() - interval '30 days'
        AND (c.revoked_at IS NULL OR c.revoked_at < now() - interval '30 days')`,
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
  readonly #activeRuns = new Set<Promise<void>>();

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
      void this.#track(this.#runScheduled());
    }, this.#intervalMs);
    this.#timer.unref?.();
    // The initial cleanup runs in the background so a slow table or lock
    // cannot delay listener binding. stop()/dispose() waits for this run.
    void this.#track(
      this.runOnce()
        .then(() => undefined)
        .catch(() => this.#logFailure()),
    );
  }

  /**
   * Runs one bounded cleanup immediately.
   *
   * @returns Deleted token and certificate counts.
   */
  public async runOnce(): Promise<AgentMaintenanceResult> {
    const results = await Promise.allSettled([
      this.#repository.cleanupTokens(this.#batchSize),
      this.#repository.cleanupCertificates(this.#batchSize),
    ]);
    let failure: unknown;
    let tokens = 0;
    let certificates = 0;
    if (results[0].status === "fulfilled") {
      tokens = results[0].value;
    } else {
      failure = results[0].reason;
    }
    if (results[1].status === "fulfilled") {
      certificates = results[1].value;
    } else {
      failure ??= results[1].reason;
    }
    if (results.some((result) => result.status === "rejected")) {
      throw failure ?? new Error("Agent cleanup failed");
    }
    return { tokens, certificates };
  }

  /** True while the daily scheduler is active. */
  public get started(): boolean {
    return this.#started;
  }

  /**
   * Stops the scheduler and waits for an in-flight cleanup.
   *
   * The operation is idempotent. Waiting prevents a disposal path from
   * disconnecting the database while a cleanup query is still running.
   */
  public async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#started = false;
    await Promise.allSettled([...this.#activeRuns]);
  }

  /** Tracks one in-flight run so stop() can wait for it. */
  #track(run: Promise<void>): Promise<void> {
    const tracked = run.finally(() => {
      this.#activeRuns.delete(tracked);
    });
    this.#activeRuns.add(tracked);
    return tracked;
  }

  async #runScheduled(): Promise<void> {
    if (!this.#started) {
      return;
    }
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

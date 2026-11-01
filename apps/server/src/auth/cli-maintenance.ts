import type { Logger } from "blendsdk/webafx";

/** The cleanup operation the maintenance service needs. */
export interface CliMaintenanceRepository {
  /** Deletes at most `batchSize` rows past retention. */
  cleanup(batchSize: number): Promise<number>;
}

/** Options for {@link CliSessionMaintenanceService}. */
export interface CliSessionMaintenanceOptions {
  /** Retention repository. */
  readonly repository: CliMaintenanceRepository;
  /** Structured logger for background failures. */
  readonly logger: Logger;
  /** Scheduler interval in milliseconds; defaults to 24 hours. */
  readonly intervalMs?: number;
  /** Rows deleted per run; defaults to 1,000. */
  readonly batchSize?: number;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Runs bounded CLI-session retention cleanup at startup and every 24 hours.
 *
 * A failed initial cleanup is logged and does not prevent the server from
 * starting; the next scheduled or manual run retries. `start` is idempotent so
 * repeated bootstrap calls cannot create duplicate timers.
 */
export class CliSessionMaintenanceService {
  readonly #repository: CliMaintenanceRepository;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #started = false;

  /**
   * @param options - Repository, logger, interval, and batch size.
   */
  public constructor(options: CliSessionMaintenanceOptions) {
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Runs one cleanup and schedules the next daily run.
   *
   * The initial failure is logged but not propagated, so a transient cleanup
   * problem cannot take authentication offline. Calling `start` twice is a
   * no-op.
   */
  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    try {
      await this.runOnce();
    } catch {
      await this.#logFailure();
    }

    this.#timer = setInterval(() => {
      void this.#runScheduled();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  /**
   * Runs one bounded cleanup immediately.
   *
   * @returns The number of deleted rows.
   */
  public async runOnce(): Promise<number> {
    return this.#repository.cleanup(this.#batchSize);
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
      .error("CLI session cleanup failed", { code: "cli_cleanup_failed" })
      .catch(() => undefined);
  }
}

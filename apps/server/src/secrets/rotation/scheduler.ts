import type { RotationLogger, SecretRotationService } from "./service.js";

/** Options for {@link SecretRotationScheduler}. */
export interface SecretRotationSchedulerOptions {
  /** Rotation scan. */
  readonly service: SecretRotationService;
  /** Configured UTC hour (0–23). */
  readonly hour: number;
  /** Logger. */
  readonly logger: RotationLogger;
  /** Injectable clock. */
  readonly now?: () => number;
}

/**
 * Runs the rotation scan once per UTC day.
 *
 * The scheduler is idempotent and awaits an in-flight scan on stop. A rejected
 * scan is logged and the next run is scheduled, so one failure cannot stop the
 * job.
 */
export class SecretRotationScheduler {
  readonly #service: SecretRotationService;
  readonly #hour: number;
  readonly #logger: RotationLogger;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #started = false;
  #stopped = false;

  /**
   * @param options - Service, UTC hour, logger, and clock.
   */
  public constructor(options: SecretRotationSchedulerOptions) {
    this.#service = options.service;
    this.#hour = options.hour;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Returns the next UTC occurrence at the configured hour.
   *
   * @param from - Current time in milliseconds.
   * @returns The next run time.
   */
  public nextRunAt(from: number): Date {
    const date = new Date(from);
    const today = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      this.#hour,
      0,
      0,
      0,
    );
    return new Date(today > from ? today : today + 86_400_000);
  }

  /**
   * Starts the scheduler. A second call is a no-op.
   *
   * @returns A promise resolved after the startup catch-up decision.
   */
  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#stopped = false;
    const now = this.#now();
    const date = new Date(now);
    const today = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      this.#hour,
      0,
      0,
      0,
    );
    if (now >= today) {
      await this.#run();
    }
    this.#schedule(this.nextRunAt(this.#now()));
  }

  /**
   * Stops the scheduler and awaits any in-flight scan.
   */
  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inFlight !== undefined) {
      await this.#inFlight;
    }
  }

  /** Schedules the next run. */
  #schedule(at: Date): void {
    if (this.#stopped) {
      return;
    }
    const delay = Math.max(0, at.getTime() - this.#now());
    this.#timer = setTimeout(() => {
      void this.#run().finally(() => {
        if (!this.#stopped) {
          this.#schedule(this.nextRunAt(this.#now()));
        }
      });
    }, delay);
    this.#timer.unref();
  }

  /** Runs one scan with failure isolation. */
  async #run(): Promise<void> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    this.#inFlight = (async () => {
      try {
        const summary = await this.#service.runOnce();
        await this.#logger.info("secret rotation scan complete", {
          scanned: summary.scanned,
          claimed: summary.claimed,
          sent: summary.sent,
          failed: summary.failed,
          skipped: summary.skipped,
        });
      } catch {
        await this.#logger.error("secret rotation scan failed", {
          reason: "scan_failed",
        });
      }
    })().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }
}

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AgentConsumerState } from "@openvault/api-contract";
import { VaultClient } from "./client.js";
import type { AgentConfig } from "./config.js";
import { Delivery, type DeliverySnapshot, DeliveryTerminalError } from "./delivery.js";
import { AgentError, agentErrorCode } from "./errors.js";
import { joinAgent } from "./join.js";
import type { AgentLogger } from "./logger.js";
import type { AgentManifest } from "./manifest.js";
import { RenewalTerminalError, renewalAt, renewOnce } from "./renewal.js";
import { type LocalSocketHandle, startLocalSocket } from "./socket.js";
import type { AgentStateStore, StoredIdentity } from "./state.js";
import { type RenewalStatus, readHealth, type StatusDocument, StatusWriter } from "./status.js";

/** Options for {@link AgentRunner}. */
export interface AgentRunnerOptions {
  readonly config: AgentConfig;
  readonly manifest: AgentManifest;
  readonly store: AgentStateStore;
  readonly logger: AgentLogger;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Wrapper command, when `run -- <cmd>` was used. */
  readonly wrapper?: { readonly command: string; readonly args: readonly string[] };
}

const MAX_TIMER_MS = 24 * 60 * 60 * 1_000;

/** Reads the CA bundle with a bound. */
function readCaBundle(path: string): string {
  try {
    const stat = readFileSync(path, "utf8");
    if (stat.length === 0 || stat.length > 1_048_576) {
      throw new Error("CA bundle size is invalid");
    }
    return stat;
  } catch (error) {
    if (error instanceof AgentError) {
      throw error;
    }
    throw new AgentError("agent_config_invalid", "OPENVAULT_CA_FILE could not be read", {
      cause: error,
    });
  }
}

/**
 * Runs the agent lifecycle: join, startup fetch, refresh, renewal, status,
 * socket, wrapper child, and clean shutdown.
 */
export class AgentRunner {
  readonly #config: AgentConfig;
  readonly #manifest: AgentManifest;
  readonly #store: AgentStateStore;
  readonly #logger: AgentLogger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #wrapper: { readonly command: string; readonly args: readonly string[] } | undefined;
  #client: VaultClient | undefined;
  #delivery: Delivery | undefined;
  #statusWriter: StatusWriter | undefined;
  #socket: LocalSocketHandle | undefined;
  #identity: StoredIdentity | undefined;
  #snapshot: DeliverySnapshot | undefined;
  #renewal: RenewalStatus = {
    state: "ok",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
  };
  #cancelled = false;
  #refreshing = false;
  #activeRefresh: Promise<void> | undefined;
  #activeRenewal: Promise<void> | undefined;
  #renewalBackoffMs = 1_000;
  #lastAttemptAt = new Date().toISOString();
  #lastSuccessAt: string | null = null;
  #renewalStopped = false;
  #refreshTimer: NodeJS.Timeout | undefined;
  #renewalTimer: NodeJS.Timeout | undefined;
  #stopResolve: ((code: number) => void) | undefined;
  #exitCode = 0;
  #child: ChildProcess | undefined;

  /**
   * @param options - Config, manifest, state, logger, and wrappers.
   */
  public constructor(options: AgentRunnerOptions) {
    this.#config = options.config;
    this.#manifest = options.manifest;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#wrapper = options.wrapper;
  }

  /**
   * Runs one startup cycle and returns the health exit code.
   *
   * @returns 0 ok, 1 degraded, 2 failed.
   */
  public async runOnce(): Promise<0 | 1 | 2> {
    try {
      await this.#initialize();
      const snapshot = await this.#delivery?.startup();
      if (snapshot === undefined) {
        return 2;
      }
      this.#snapshot = snapshot;
      this.#writeStatus(snapshot);
      await this.#heartbeat(snapshot.state);
      if (snapshot.state === "ok") {
        return 0;
      }
      return snapshot.state === "degraded" ? 1 : 2;
    } catch (error) {
      await this.#terminal(error);
      return 2;
    }
  }

  /**
   * Runs until a signal or a terminal failure.
   *
   * @returns The process exit code.
   */
  public async run(): Promise<number> {
    const stop = new Promise<number>((resolve) => {
      this.#stopResolve = resolve;
    });
    const onSignal = (): void => {
      void this.stop(0);
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
      await this.#initialize();
      this.#socket = await startLocalSocket({
        path: this.#config.socketPath,
        getSecret: (name) => this.#delivery?.getDelivered(name),
        getStatus: () => this.#statusDocument(),
        logger: this.#logger,
      });
      const snapshot = await this.#delivery?.startup();
      if (snapshot === undefined) {
        throw new AgentError("agent_internal", "Delivery did not initialize");
      }
      this.#snapshot = snapshot;
      this.#writeStatus(snapshot);
      await this.#heartbeat(snapshot.state);
      if (this.#wrapper !== undefined) {
        this.#startWrapperChild();
      }
      this.#scheduleRefresh();
      this.#scheduleRenewal();
      return await stop;
    } catch (error) {
      await this.#terminal(error);
      return this.#exitCode;
    } finally {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
  }

  /** Stops timers and the local socket, keeping delivered files. */
  public async stop(code = 0): Promise<void> {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.#exitCode = code;
    this.#clearTimers();
    this.#client?.cancel();
    await this.#terminateChild();
    await this.#socket?.close().catch(() => undefined);
    this.#socket = undefined;
    this.#stopResolve?.(code);
    this.#stopResolve = undefined;
  }

  /** Initializes join, client, delivery, and status. */
  async #initialize(): Promise<void> {
    this.#store.prepare();
    const caPem = readCaBundle(this.#config.caFile);
    const client = new VaultClient({ baseUrl: this.#config.url, caPem });
    this.#client = client;
    const identity = await joinAgent({
      config: this.#config,
      manifest: this.#manifest,
      store: this.#store,
      client,
      logger: this.#logger,
      now: this.#now,
      isCancelled: () => this.#cancelled,
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
    });
    this.#identity = identity;
    this.#delivery = new Delivery({
      config: this.#config,
      manifest: this.#manifest,
      store: this.#store,
      client,
      identity,
      logger: this.#logger,
      now: this.#now,
      isCancelled: () => this.#cancelled,
    });
    this.#statusWriter = new StatusWriter(this.#config.statusFile);
  }

  /** Sends one best-effort heartbeat. */
  async #heartbeat(state: AgentConsumerState): Promise<void> {
    if (this.#client === undefined || this.#identity === undefined) {
      return;
    }
    try {
      await this.#client.heartbeat(this.#identity, state);
    } catch (error) {
      this.#logger.warn("consumer_heartbeat_failed", { code: agentErrorCode(error) });
    }
  }

  /** Writes the status document for the current snapshot. */
  #writeStatus(snapshot: DeliverySnapshot, updateDeliveryTimes = true): void {
    if (updateDeliveryTimes) {
      this.#lastAttemptAt = new Date(this.#now()).toISOString();
      if (snapshot.state !== "failed") {
        this.#lastSuccessAt = this.#lastAttemptAt;
      }
    }
    this.#statusWriter?.write(this.#statusDocument(snapshot));
  }

  /** Builds the current value-free status document. */
  #statusDocument(
    snapshot: DeliverySnapshot = this.#snapshot ?? this.#emptySnapshot(),
  ): StatusDocument {
    const refreshMs = this.#manifest.refreshMs;
    const staleAfterMs = refreshMs * 3 + 60_000;
    return {
      version: 1,
      state: snapshot.state,
      requiredReady: snapshot.requiredReady,
      project: this.#manifest.project,
      service: this.#manifest.service,
      manifestHash: this.#manifest.hash,
      identityId: this.#identity?.identityId ?? "",
      certificateNotAfter: this.#identity?.notAfter ?? "",
      lastAttemptAt: this.#lastAttemptAt,
      lastSuccessAt: this.#lastSuccessAt,
      refreshMs,
      staleAfterMs,
      renewal: this.#renewal,
      entries: snapshot.entries.map((entry) => ({
        name: entry.name,
        required: entry.required,
        state: entry.state,
        versionId: entry.versionId,
        updatedAt: entry.updatedAt,
      })),
    };
  }

  /** Returns a failed snapshot before any fetch. */
  #emptySnapshot(): DeliverySnapshot {
    return {
      state: "failed",
      requiredReady: false,
      entries: this.#manifest.entries.map((entry) => ({
        name: entry.name,
        required: !entry.optional,
        state: "failed" as const,
        versionId: null,
        updatedAt: null,
      })),
    };
  }

  /** Schedules the next refresh. */
  #scheduleRefresh(): void {
    if (this.#cancelled) {
      return;
    }
    const delay = Math.floor(this.#manifest.refreshMs * (1 + this.#random() * 0.1));
    this.#refreshTimer = setTimeout(() => {
      void this.#runRefresh();
    }, delay);
    this.#refreshTimer.unref?.();
  }

  /** Runs one refresh and schedules the next. */
  async #runRefresh(): Promise<void> {
    if (this.#cancelled || this.#refreshing) {
      this.#scheduleRefresh();
      return;
    }
    this.#refreshing = true;
    const task = (async (): Promise<void> => {
      const snapshot = await this.#delivery?.refresh();
      if (snapshot === undefined || this.#cancelled) {
        return;
      }
      this.#snapshot = snapshot;
      this.#writeStatus(snapshot);
      await this.#heartbeat(snapshot.state);
    })();
    this.#activeRefresh = task;
    try {
      await task;
    } catch (error) {
      this.#activeRefresh = undefined;
      if (this.#cancelled) {
        return;
      }
      await this.#terminal(error);
      return;
    } finally {
      this.#activeRefresh = undefined;
      this.#refreshing = false;
    }
    this.#scheduleRefresh();
  }

  /** Schedules the next renewal attempt. */
  #scheduleRenewal(delayMs?: number): void {
    if (this.#cancelled || this.#renewalStopped || this.#identity === undefined) {
      return;
    }
    const target =
      delayMs === undefined
        ? renewalAt(this.#identity, this.#random() * 0.05)
        : this.#now() + delayMs;
    this.#renewal = {
      ...this.#renewal,
      nextAttemptAt: new Date(target).toISOString(),
    };
    this.#scheduleAt(target, () => {
      void this.#runRenewal();
    });
  }

  /** Schedules one callback at a target time using bounded timer chunks. */
  #scheduleAt(target: number, callback: () => void): void {
    const delay = Math.max(0, target - this.#now());
    this.#renewalTimer = setTimeout(
      () => {
        if (this.#now() < target) {
          this.#scheduleAt(target, callback);
          return;
        }
        callback();
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    this.#renewalTimer.unref?.();
  }

  /** Runs one renewal attempt. */
  async #runRenewal(): Promise<void> {
    if (
      this.#cancelled ||
      this.#renewalStopped ||
      this.#client === undefined ||
      this.#identity === undefined
    ) {
      return;
    }
    const task = this.#renewalTask();
    this.#activeRenewal = task;
    try {
      await task;
    } catch (error) {
      this.#activeRenewal = undefined;
      if (!this.#cancelled) {
        await this.#terminal(error);
      }
    } finally {
      this.#activeRenewal = undefined;
    }
  }

  /** One renewal attempt body. */
  async #renewalTask(): Promise<void> {
    if (
      this.#cancelled ||
      this.#renewalStopped ||
      this.#client === undefined ||
      this.#identity === undefined
    ) {
      return;
    }
    this.#renewal = { ...this.#renewal, lastAttemptAt: new Date(this.#now()).toISOString() };
    try {
      const outcome = await renewOnce({
        config: this.#config,
        manifest: this.#manifest,
        store: this.#store,
        client: this.#client,
        identity: this.#identity,
        logger: this.#logger,
        now: this.#now,
        isCancelled: () => this.#cancelled,
      });
      if (this.#cancelled) {
        return;
      }
      if (outcome.kind === "renewed" || outcome.kind === "adopted") {
        this.#renewalBackoffMs = 1_000;
        this.#identity = outcome.identity;
        this.#delivery?.updateIdentity(outcome.identity);
        this.#renewal = {
          state: "ok",
          lastAttemptAt: this.#renewal.lastAttemptAt,
          lastSuccessAt: new Date(this.#now()).toISOString(),
          nextAttemptAt: null,
        };
        this.#writeStatus(this.#snapshot ?? this.#emptySnapshot(), false);
        this.#scheduleRenewal();
        return;
      }
      if (outcome.kind === "not_due") {
        const delay = Math.max(30_000, renewalAt(this.#identity, 0) - this.#now());
        this.#scheduleRenewal(delay);
        return;
      }
      if (outcome.kind === "stale") {
        this.#renewalStopped = true;
        this.#renewal = { ...this.#renewal, state: "degraded", nextAttemptAt: null };
        this.#logger.warn("agent_renewal_stale", { identityId: this.#identity.identityId });
        this.#writeStatus(this.#snapshot ?? this.#emptySnapshot(), false);
        return;
      }
      this.#renewal = { ...this.#renewal, state: "degraded" };
      this.#writeStatus(this.#snapshot ?? this.#emptySnapshot(), false);
      const delay = this.#renewalBackoffMs + Math.floor(this.#random() * 1_000);
      this.#renewalBackoffMs = Math.min(this.#renewalBackoffMs * 2, 300_000);
      this.#scheduleRenewal(delay);
    } catch (error) {
      if (!this.#cancelled) {
        throw error;
      }
    }
  }

  /** Starts the wrapper child after the first successful fetch. */
  #startWrapperChild(): void {
    if (this.#wrapper === undefined || this.#cancelled) {
      return;
    }
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("OPENVAULT_") || key === "COMPOSE_PROJECT_NAME") {
        delete environment[key];
      }
    }
    for (const entry of this.#manifest.entries) {
      const delivered = this.#delivery?.getDelivered(entry.name);
      if (delivered === undefined || delivered.envError) {
        continue;
      }
      for (const target of entry.env) {
        environment[target.name] = new TextDecoder("utf-8", { fatal: true }).decode(
          delivered.value,
        );
      }
    }
    const child = spawn(this.#wrapper.command, [...this.#wrapper.args], {
      env: environment,
      stdio: "inherit",
      shell: false,
    });
    this.#child = child;
    child.once("error", (error) => {
      void this.#terminal(error);
    });
    child.once("exit", (code, signal) => {
      const exitCode = signal === null ? (code ?? 1) : 1;
      void this.stop(exitCode);
    });
  }

  /** Terminates the wrapper child with a bounded grace period. */
  async #terminateChild(): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    let grace: NodeJS.Timeout | undefined;
    const gracePromise = new Promise<void>((resolve) => {
      grace = setTimeout(resolve, 5_000);
      grace.unref?.();
    });
    await Promise.race([once(child, "exit").then(() => undefined), gracePromise]);
    if (grace !== undefined) {
      clearTimeout(grace);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      let killGrace: NodeJS.Timeout | undefined;
      const killPromise = new Promise<void>((resolve) => {
        killGrace = setTimeout(resolve, 2_000);
        killGrace.unref?.();
      });
      await Promise.race([once(child, "exit").then(() => undefined), killPromise]);
      if (killGrace !== undefined) {
        clearTimeout(killGrace);
      }
    }
  }

  /** Runs the terminal handler once. */
  async #terminal(error: unknown): Promise<void> {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.#exitCode = 1;
    this.#client?.cancel();
    this.#clearTimers();
    if (this.#activeRefresh !== undefined) {
      try {
        await this.#activeRefresh;
      } catch {
        // The active cycle observes the cancellation flag.
      }
      this.#activeRefresh = undefined;
    }
    if (this.#activeRenewal !== undefined) {
      try {
        await this.#activeRenewal;
      } catch {
        // The active renewal observes the cancellation flag.
      }
      this.#activeRenewal = undefined;
    }
    const code =
      error instanceof DeliveryTerminalError || error instanceof RenewalTerminalError
        ? error.code
        : agentErrorCode(error);
    const removeFiles =
      error instanceof DeliveryTerminalError || error instanceof RenewalTerminalError
        ? error.removeFiles
        : code !== "agent_state_write_failed";
    if (code === "agent_credential_rejected") {
      try {
        this.#store.clearIdentity();
      } catch {
        this.#logger.warn("agent_state_clear_failed", { code });
      }
    }
    if (removeFiles) {
      try {
        this.#delivery?.removeManagedFiles();
      } catch {
        this.#logger.error("agent_cleanup_failed", { code });
      }
    }
    this.#logger.error("agent_terminal", { code });
    this.#renewal = { ...this.#renewal, state: "failed" };
    try {
      this.#lastAttemptAt = new Date(this.#now()).toISOString();
      this.#statusWriter?.write({
        ...this.#statusDocument({
          ...(this.#snapshot ?? this.#emptySnapshot()),
          state: "failed",
          requiredReady: false,
        }),
        state: "failed",
      });
    } catch {
      // A status write failure cannot change the terminal outcome.
    }
    await this.#heartbeat("failed");
    await this.#terminateChild();
    await this.#socket?.close().catch(() => undefined);
    this.#socket = undefined;
    this.#stopResolve?.(this.#exitCode);
    this.#stopResolve = undefined;
  }

  /** Clears both timers. */
  #clearTimers(): void {
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (this.#renewalTimer !== undefined) {
      clearTimeout(this.#renewalTimer);
      this.#renewalTimer = undefined;
    }
  }
}

/** Re-exported for the health command. */
export { readHealth };

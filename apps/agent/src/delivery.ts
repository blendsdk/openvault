import type { AgentConsumerState, SecretValueResponse } from "@openvault/api-contract";
import type { VaultClient } from "./client.js";
import { VaultClientError } from "./client.js";
import type { AgentConfig } from "./config.js";
import { AgentError } from "./errors.js";
import { atomicWriteFile, ensureSecureDirectory, removeFile, safePath } from "./fs-utils.js";
import type { AgentLogger } from "./logger.js";
import type { AgentManifest, ManifestEntry } from "./manifest.js";
import type { AgentStateStore, ManagedFiles, StoredIdentity } from "./state.js";

/** One delivered value held in memory. */
export interface DeliveredEntry {
  /** Secret name. */
  readonly name: string;
  /** Decoded bytes. */
  readonly value: Buffer;
  /** Response encoding. */
  readonly encoding: "utf8" | "base64";
  /** Version identifier. */
  readonly versionId: string;
  /** Delivery time. */
  readonly deliveredAt: Date;
  /** Whether the entry is required. */
  readonly required: boolean;
  /** Manifest entry used for targets. */
  readonly entry: ManifestEntry;
}

/** One entry state in a delivery snapshot. */
export interface DeliveredEntryStatus {
  /** Secret name. */
  readonly name: string;
  /** Whether the entry is required. */
  readonly required: boolean;
  /** Current state. */
  readonly state: AgentConsumerState;
  /** Version identifier, when delivered. */
  readonly versionId: string | null;
  /** Last update time, when delivered. */
  readonly updatedAt: string | null;
}

/** The result of one startup or refresh cycle. */
export interface DeliverySnapshot {
  /** Aggregate state. */
  readonly state: AgentConsumerState;
  /** True when every required entry is delivered. */
  readonly requiredReady: boolean;
  /** Per-entry states in manifest order. */
  readonly entries: readonly DeliveredEntryStatus[];
}

/** A terminal delivery failure with the required file-removal policy. */
export class DeliveryTerminalError extends Error {
  /**
   * @param code - Stable agent error code.
   * @param removeFiles - Whether managed files must be removed.
   * @param message - Short static message.
   */
  public constructor(
    public readonly code:
      | "agent_credential_rejected"
      | "agent_secret_not_found"
      | "agent_request_rejected"
      | "agent_transient"
      | "agent_state_write_failed",
    public readonly removeFiles: boolean,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryTerminalError";
  }
}

/** Options for {@link Delivery}. */
export interface DeliveryOptions {
  readonly config: AgentConfig;
  readonly manifest: AgentManifest;
  readonly store: AgentStateStore;
  readonly client: VaultClient;
  readonly identity: StoredIdentity;
  readonly logger: AgentLogger;
  readonly now?: () => number;
}

/** Decodes the response value into bytes. */
function decodeValue(response: SecretValueResponse): Buffer {
  if (response.encoding === "base64") {
    return Buffer.from(response.value, "base64");
  }
  return Buffer.from(response.value, "utf8");
}

/** Decodes one env value, rejecting invalid UTF-8 and NUL bytes. */
function decodeEnvValue(bytes: Buffer): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\u0000")) {
      throw new Error("NUL");
    }
    return value;
  } catch {
    throw new Error("env value is not UTF-8");
  }
}

/** Maps a client failure to the aggregate state. */
function stateForFailure(error: VaultClientError, optional: boolean): AgentConsumerState {
  if (error.kind === "credential" || error.kind === "terminal") {
    return "failed";
  }
  if (error.kind === "not_found") {
    return optional ? "degraded" : "failed";
  }
  return "degraded";
}

/**
 * Fetches, writes, and reconciles manifest entries.
 *
 * The class owns the in-memory last-known-good values and the output-file
 * ledger. It never logs a value or response body.
 */
export class Delivery {
  readonly #config: AgentConfig;
  readonly #manifest: AgentManifest;
  readonly #store: AgentStateStore;
  readonly #client: VaultClient;
  #identity: StoredIdentity;
  readonly #logger: AgentLogger;
  readonly #now: () => number;
  readonly #delivered = new Map<string, DeliveredEntry>();
  #snapshot: DeliverySnapshot = { state: "ok", requiredReady: false, entries: [] };

  /**
   * @param options - Config, manifest, state, client, identity, and logger.
   */
  public constructor(options: DeliveryOptions) {
    this.#config = options.config;
    this.#manifest = options.manifest;
    this.#store = options.store;
    this.#client = options.client;
    this.#identity = options.identity;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** Returns the last delivered value for one manifest entry. */
  public getDelivered(name: string): DeliveredEntry | undefined {
    return this.#delivered.get(name);
  }

  /** Returns the last snapshot. */
  public getSnapshot(): DeliverySnapshot {
    return this.#snapshot;
  }

  /** Returns the identity used by this delivery instance. */
  public get identity(): StoredIdentity {
    return this.#identity;
  }

  /** Replaces the identity after a successful renewal or adoption. */
  public updateIdentity(identity: StoredIdentity): void {
    this.#identity = identity;
  }

  /**
   * Runs the all-or-nothing startup fetch.
   *
   * No managed file is written until every required entry has a value.
   *
   * @returns The startup snapshot.
   * @throws {DeliveryTerminalError} On a terminal or required failure.
   */
  public async startup(): Promise<DeliverySnapshot> {
    ensureSecureDirectory(this.#manifest.outputDir, "agent_config_invalid");
    const previous = this.#store.loadManagedFiles(this.#manifest.outputDir);
    const staged = new Map<string, DeliveredEntry>();
    const statuses = new Map<string, DeliveredEntryStatus>();
    let state: AgentConsumerState = "ok";

    for (const entry of this.#manifest.entries) {
      try {
        const response = await this.#read(entry, state);
        const value = decodeValue(response);
        if (entry.env.length > 0) {
          // Validate every env target now so startup does not write a mixed set.
          for (const target of entry.env) {
            void target;
            decodeEnvValue(value);
          }
        }
        const delivered: DeliveredEntry = {
          name: entry.name,
          value,
          encoding: response.encoding,
          versionId: response.version.id,
          deliveredAt: new Date(this.#now()),
          required: !entry.optional,
          entry,
        };
        staged.set(entry.name, delivered);
        statuses.set(entry.name, {
          name: entry.name,
          required: !entry.optional,
          state: "ok",
          versionId: response.version.id,
          updatedAt: delivered.deliveredAt.toISOString(),
        });
      } catch (error) {
        const failure = this.#asClientError(error);
        const mapped = stateForFailure(failure, entry.optional);
        if (!entry.optional && failure.kind === "transient") {
          throw new DeliveryTerminalError("agent_transient", false, "Startup delivery failed");
        }
        if (mapped === "failed") {
          throw new DeliveryTerminalError(
            failure.kind === "credential"
              ? "agent_credential_rejected"
              : failure.kind === "not_found"
                ? "agent_secret_not_found"
                : "agent_request_rejected",
            failure.kind === "credential" || failure.kind === "not_found",
            "Startup delivery failed",
          );
        }
        if (failure.kind === "not_found" || failure.kind === "transient") {
          this.#removeEntryFiles(entry);
        }
        state = "degraded";
        statuses.set(entry.name, {
          name: entry.name,
          required: !entry.optional,
          state: "degraded",
          versionId: null,
          updatedAt: null,
        });
      }
    }

    this.#delivered.clear();
    for (const [name, entry] of staged) {
      this.#delivered.set(name, entry);
    }
    this.#writeManagedFiles(previous, this.#fileTargets());
    this.#snapshot = this.#buildSnapshot(state, statuses);
    this.#logger.info("agent_startup_ok", {
      state: this.#snapshot.state,
      requiredReady: this.#snapshot.requiredReady,
      entries: this.#manifest.entries.length,
    });
    return this.#snapshot;
  }

  /**
   * Runs one refresh cycle.
   *
   * Transient failures keep last-known-good values; credential and required
   * not-found failures are terminal and remove every managed file.
   *
   * @returns The refresh snapshot.
   * @throws {DeliveryTerminalError} On a terminal or required failure.
   */
  public async refresh(): Promise<DeliverySnapshot> {
    ensureSecureDirectory(this.#manifest.outputDir, "agent_config_invalid");
    const previous = this.#store.loadManagedFiles(this.#manifest.outputDir);
    const next = new Map(this.#delivered);
    const statuses = new Map<string, DeliveredEntryStatus>();
    let state: AgentConsumerState = "ok";

    for (const entry of this.#manifest.entries) {
      const before = next.get(entry.name);
      try {
        const response = await this.#read(entry, state);
        const value = decodeValue(response);
        if (entry.env.length > 0) {
          for (const target of entry.env) {
            void target;
            decodeEnvValue(value);
          }
        }
        const delivered: DeliveredEntry = {
          name: entry.name,
          value,
          encoding: response.encoding,
          versionId: response.version.id,
          deliveredAt: new Date(this.#now()),
          required: !entry.optional,
          entry,
        };
        next.set(entry.name, delivered);
        statuses.set(entry.name, {
          name: entry.name,
          required: !entry.optional,
          state: "ok",
          versionId: response.version.id,
          updatedAt: delivered.deliveredAt.toISOString(),
        });
      } catch (error) {
        const failure = this.#asClientError(error);
        const mapped = stateForFailure(failure, entry.optional);
        if (mapped === "failed") {
          throw new DeliveryTerminalError(
            failure.kind === "credential"
              ? "agent_credential_rejected"
              : failure.kind === "not_found"
                ? "agent_secret_not_found"
                : "agent_request_rejected",
            true,
            "Refresh delivery failed",
          );
        }
        state = "degraded";
        if (failure.kind === "not_found") {
          next.delete(entry.name);
          this.#removeEntryFiles(entry);
          statuses.set(entry.name, {
            name: entry.name,
            required: !entry.optional,
            state: "degraded",
            versionId: null,
            updatedAt: null,
          });
        } else if (before !== undefined) {
          statuses.set(entry.name, {
            name: entry.name,
            required: !entry.optional,
            state: "degraded",
            versionId: before.versionId,
            updatedAt: before.deliveredAt.toISOString(),
          });
        } else {
          statuses.set(entry.name, {
            name: entry.name,
            required: !entry.optional,
            state: entry.optional ? "degraded" : "failed",
            versionId: null,
            updatedAt: null,
          });
        }
      }
    }

    this.#delivered.clear();
    for (const [name, entry] of next) {
      this.#delivered.set(name, entry);
    }
    try {
      this.#writeManagedFiles(previous, this.#fileTargets());
    } catch (error) {
      throw new DeliveryTerminalError(
        "agent_state_write_failed",
        true,
        error instanceof AgentError ? error.message : "Output write failed",
      );
    }
    this.#snapshot = this.#buildSnapshot(state, statuses);
    this.#logger.info("agent_refresh_ok", {
      state: this.#snapshot.state,
      requiredReady: this.#snapshot.requiredReady,
    });
    return this.#snapshot;
  }

  /** Removes every managed file known from the current and previous ledgers. */
  public removeManagedFiles(): void {
    const names = new Set<string>(this.#fileTargets());
    try {
      const previous = this.#store.loadManagedFiles(this.#manifest.outputDir);
      for (const name of previous?.files ?? []) {
        names.add(name);
      }
    } catch {
      // A corrupt ledger must not block the credential-failure cleanup.
    }
    for (const name of names) {
      removeFile(safePath(this.#manifest.outputDir, name));
    }
    this.#delivered.clear();
  }

  /** Removes the files for one entry. */
  #removeEntryFiles(entry: ManifestEntry): void {
    for (const target of entry.files) {
      removeFile(safePath(this.#manifest.outputDir, target.name));
    }
  }

  /** Reads one entry with the current aggregate state header. */
  async #read(entry: ManifestEntry, state: AgentConsumerState): Promise<SecretValueResponse> {
    return await this.#client.readSecret(
      this.#manifest.project,
      entry.name,
      this.#identity,
      state,
      entry.optional,
    );
  }

  /** Maps an unknown error to a client error. */
  #asClientError(error: unknown): VaultClientError {
    if (error instanceof VaultClientError) {
      return error;
    }
    return new VaultClientError("terminal", "Delivery request failed");
  }

  /** Returns the exact file targets for the current manifest. */
  #fileTargets(): readonly string[] {
    return this.#manifest.entries.flatMap((entry) => entry.files.map((file) => file.name));
  }

  /**
   * Writes staged files, removes old targets, and updates the ledger.
   *
   * The temporary files are created before any rename; a failure removes the
   * managed set so startup cannot leave a mixed old/new view.
   */
  #writeManagedFiles(previous: ManagedFiles | undefined, fileTargets: readonly string[]): void {
    const next = new Set(fileTargets);
    try {
      for (const entry of this.#manifest.entries) {
        const delivered = this.#delivered.get(entry.name);
        if (delivered === undefined) {
          continue;
        }
        for (const target of entry.files) {
          const path = safePath(this.#manifest.outputDir, target.name);
          atomicWriteFile(path, delivered.value, target.mode);
        }
      }
      for (const old of previous?.files ?? []) {
        if (!next.has(old)) {
          removeFile(safePath(this.#manifest.outputDir, old));
        }
      }
      this.#store.saveManagedFiles({
        version: 1,
        outputDir: this.#manifest.outputDir,
        manifestHash: this.#manifest.hash,
        files: [...next],
      });
    } catch (error) {
      this.removeManagedFiles();
      throw error instanceof AgentError
        ? error
        : new AgentError("agent_state_write_failed", "Output write failed", { cause: error });
    }
  }

  /** Builds a snapshot from per-entry statuses. */
  #buildSnapshot(
    state: AgentConsumerState,
    statuses: ReadonlyMap<string, DeliveredEntryStatus>,
  ): DeliverySnapshot {
    const entries = this.#manifest.entries.map(
      (entry) =>
        statuses.get(entry.name) ?? {
          name: entry.name,
          required: !entry.optional,
          state: "failed" as const,
          versionId: null,
          updatedAt: null,
        },
    );
    const requiredReady = entries.every((entry) => !entry.required || entry.state !== "failed");
    return { state, requiredReady, entries };
  }
}

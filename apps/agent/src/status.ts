import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentConsumerState } from "@openvault/api-contract";
import { AgentError } from "./errors.js";
import { atomicWriteFile, ensureSecureDirectory } from "./fs-utils.js";

/** Renewal state shown in the status document. */
export interface RenewalStatus {
  /** Renewal state. */
  readonly state: AgentConsumerState;
  /** Last renewal attempt. */
  readonly lastAttemptAt: string | null;
  /** Last successful renewal. */
  readonly lastSuccessAt: string | null;
  /** Next scheduled attempt. */
  readonly nextAttemptAt: string | null;
}

/** One entry in the status document. */
export interface StatusEntry {
  /** Secret name. */
  readonly name: string;
  /** Whether the entry is required. */
  readonly required: boolean;
  /** Current state. */
  readonly state: AgentConsumerState;
  /** Version identifier, or null. */
  readonly versionId: string | null;
  /** Last update, or null. */
  readonly updatedAt: string | null;
}

/** The value-free status document. */
export interface StatusDocument {
  /** Schema version. */
  readonly version: 1;
  /** Aggregate delivery state. */
  readonly state: AgentConsumerState;
  /** True when every required entry is delivered. */
  readonly requiredReady: boolean;
  /** Project name. */
  readonly project: string;
  /** Service name. */
  readonly service: string;
  /** Manifest hash. */
  readonly manifestHash: string;
  /** Identity identifier. */
  readonly identityId: string;
  /** Certificate expiry. */
  readonly certificateNotAfter: string;
  /** Last attempt. */
  readonly lastAttemptAt: string;
  /** Last successful cycle. */
  readonly lastSuccessAt: string | null;
  /** Refresh interval. */
  readonly refreshMs: number;
  /** Staleness threshold. */
  readonly staleAfterMs: number;
  /** Renewal state. */
  readonly renewal: RenewalStatus;
  /** Per-entry states. */
  readonly entries: readonly StatusEntry[];
}

/** Writes the status document atomically. */
export class StatusWriter {
  readonly #path: string;

  /**
   * @param path - Absolute status file path.
   */
  public constructor(path: string) {
    this.#path = path;
  }

  /** Persists one status document. */
  public write(document: StatusDocument): void {
    ensureSecureDirectory(dirname(this.#path), "agent_config_invalid");
    try {
      atomicWriteFile(this.#path, JSON.stringify(document), 0o600);
    } catch (error) {
      throw new AgentError("agent_state_write_failed", "Status file could not be written", {
        cause: error,
      });
    }
  }
}

/** The health state printed by `ov-agent health`. */
export type HealthState = AgentConsumerState;

/** Options for {@link readHealth}. */
export interface HealthOptions {
  /** Use required readiness instead of the full state. */
  readonly ready?: boolean;
  /** Override the staleness threshold. */
  readonly maxAgeMs?: number;
  /** Injectable clock. */
  readonly now?: () => number;
}

/** Reads and validates a status document. */
export function readStatus(path: string): StatusDocument | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const state = Reflect.get(raw, "state");
    if (state !== "ok" && state !== "degraded" && state !== "failed") {
      return undefined;
    }
    const requiredReady = Reflect.get(raw, "requiredReady");
    const lastAttemptAt = Reflect.get(raw, "lastAttemptAt");
    const staleAfterMs = Reflect.get(raw, "staleAfterMs");
    if (
      typeof requiredReady !== "boolean" ||
      typeof lastAttemptAt !== "string" ||
      typeof staleAfterMs !== "number"
    ) {
      return undefined;
    }
    return raw as StatusDocument;
  } catch {
    return undefined;
  }
}

/**
 * Computes the health state and exit code.
 *
 * @param path - Status file path.
 * @param options - Ready mode, max age override, and clock.
 * @returns State and exit code.
 */
export function readHealth(
  path: string,
  options: HealthOptions = {},
): { readonly state: HealthState; readonly exitCode: 0 | 1 | 2 } {
  const document = readStatus(path);
  if (document === undefined) {
    return { state: "failed", exitCode: 2 };
  }
  const now = (options.now ?? Date.now)();
  const maxAge = options.maxAgeMs ?? document.staleAfterMs;
  const attempted = Date.parse(document.lastAttemptAt);
  if (!Number.isFinite(attempted) || now - attempted > maxAge) {
    return { state: "failed", exitCode: 2 };
  }
  if (options.ready === true) {
    return document.requiredReady
      ? { state: document.state, exitCode: 0 }
      : { state: "failed", exitCode: 2 };
  }
  if (document.state === "ok") {
    return { state: "ok", exitCode: 0 };
  }
  if (document.state === "degraded") {
    return { state: "degraded", exitCode: 1 };
  }
  return { state: "failed", exitCode: 2 };
}

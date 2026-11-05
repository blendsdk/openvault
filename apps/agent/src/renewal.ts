import { X509Certificate } from "node:crypto";
import type { AgentConsumer } from "@openvault/api-contract";
import type { ClientIdentity, VaultClient } from "./client.js";
import { VaultClientError } from "./client.js";
import type { AgentConfig } from "./config.js";
import { AgentError } from "./errors.js";
import { consumerMetadata, generateKeyMaterial, storedIdentity } from "./join.js";
import type { AgentLogger } from "./logger.js";
import type { AgentManifest } from "./manifest.js";
import { type AgentStateStore, certificateWindow, type StoredIdentity } from "./state.js";

/** One renewal result. */
export type RenewalOutcome =
  | { readonly kind: "renewed"; readonly identity: StoredIdentity }
  | { readonly kind: "adopted"; readonly identity: StoredIdentity }
  | { readonly kind: "not_due" }
  | { readonly kind: "stale" }
  | { readonly kind: "transient" };

/** Options for {@link renewOnce}. */
export interface RenewalOptions {
  readonly config: AgentConfig;
  readonly manifest: AgentManifest;
  readonly store: AgentStateStore;
  readonly client: VaultClient;
  readonly identity: StoredIdentity;
  readonly logger: AgentLogger;
  readonly now?: () => number;
}

/** A terminal renewal failure that the runner must handle. */
export class RenewalTerminalError extends Error {
  /**
   * @param code - Stable agent code.
   * @param removeFiles - Whether managed files must be removed.
   * @param message - Short static message.
   */
  public constructor(
    public readonly code:
      | "agent_credential_rejected"
      | "agent_renewal_terminal"
      | "agent_secret_not_found",
    public readonly removeFiles: boolean,
    message: string,
  ) {
    super(message);
    this.name = "RenewalTerminalError";
  }
}

/** Returns the certificate window or throws a state error. */
function windowOf(identity: StoredIdentity): { readonly notBefore: Date; readonly notAfter: Date } {
  const window = certificateWindow(identity.certificatePem);
  if (window === undefined) {
    throw new AgentError("agent_state_insecure", "Stored certificate could not be parsed");
  }
  return window;
}

/**
 * Computes the first renewal time from the certificate's actual window.
 *
 * @param identity - Current identity.
 * @param jitter - Fraction of the lifetime added as positive jitter (0–0.05).
 * @returns Epoch milliseconds.
 */
export function renewalAt(identity: StoredIdentity, jitter = 0): number {
  const window = windowOf(identity);
  const lifetime = window.notAfter.getTime() - window.notBefore.getTime();
  const base = window.notBefore.getTime() + Math.ceil((lifetime * 2) / 3);
  const extra = Math.floor(lifetime * Math.min(Math.max(jitter, 0), 0.05));
  return Math.min(base + extra, window.notAfter.getTime() - 1);
}

/** Returns true when the certificate is at or past two thirds of its window. */
export function renewalDue(identity: StoredIdentity, now: number): boolean {
  return now >= renewalAt(identity, 0);
}

/** Maps a client error to a renewal outcome or throws a terminal error. */
function mapFailure(error: unknown): RenewalOutcome {
  if (error instanceof VaultClientError) {
    if (error.kind === "transient") {
      return { kind: "transient" };
    }
    if (error.kind === "renewal_not_due") {
      return { kind: "not_due" };
    }
    if (error.kind === "renewal_not_current") {
      return { kind: "stale" };
    }
    if (error.kind === "credential") {
      throw new RenewalTerminalError(
        "agent_credential_rejected",
        true,
        "Renewal credential was rejected",
      );
    }
    if (error.kind === "not_found") {
      throw new RenewalTerminalError("agent_secret_not_found", true, "Renewal resource not found");
    }
    throw new RenewalTerminalError("agent_renewal_terminal", true, "Renewal request failed");
  }
  throw new RenewalTerminalError("agent_renewal_terminal", true, "Renewal request failed");
}

/**
 * Performs one renewal attempt.
 *
 * Pending key/CSR material is reused for five minutes so a lost response can
 * be retried within the server's replay window. A successful response swaps
 * the identity atomically.
 *
 * @param options - Config, manifest, state, client, and identity.
 * @returns The renewal outcome.
 * @throws {RenewalTerminalError} On a credential or terminal failure.
 */
export async function renewOnce(options: RenewalOptions): Promise<RenewalOutcome> {
  const now = options.now ?? Date.now;
  let pending = options.store.loadPendingRenewal();
  if (pending === undefined) {
    const generated = await generateKeyMaterial();
    pending = {
      version: 1,
      privateKeyPem: generated.privateKeyPem,
      csrPem: generated.csrPem,
      createdAt: new Date(now()).toISOString(),
    };
    options.store.savePendingRenewal(pending);
  }

  const current: ClientIdentity = {
    certificatePem: options.identity.certificatePem,
    privateKeyPem: options.identity.privateKeyPem,
  };
  const consumer: AgentConsumer = consumerMetadata(options.config, options.manifest);
  let response: Awaited<ReturnType<VaultClient["renew"]>>;
  try {
    response = await options.client.renew(current, { csr: pending.csrPem, consumer });
  } catch (error) {
    const outcome = mapFailure(error);
    if (outcome.kind === "stale") {
      const stored = options.store.loadIdentity();
      if (stored !== undefined && stored.identityId === options.identity.identityId) {
        const oldWindow = windowOf(options.identity);
        const newWindow = windowOf(stored);
        if (newWindow.notBefore.getTime() > oldWindow.notBefore.getTime()) {
          options.logger.info("agent_renewal_adopted", { identityId: stored.identityId });
          return { kind: "adopted", identity: stored };
        }
      }
    }
    if (outcome.kind === "transient") {
      options.logger.warn("agent_renewal_retry", { identityId: options.identity.identityId });
      return outcome;
    }
    if (outcome.kind === "not_due") {
      options.logger.info("agent_renewal_not_due", { identityId: options.identity.identityId });
      return outcome;
    }
    return outcome;
  }

  const identity = storedIdentity(response, pending.privateKeyPem, now());
  options.store.saveIdentity(identity);
  options.store.deletePendingRenewal();
  options.logger.info("agent_renewed", { identityId: identity.identityId });
  return { kind: "renewed", identity };
}

/** Returns true when a stored certificate is newer than another. */
export function isNewerCertificate(candidate: StoredIdentity, current: StoredIdentity): boolean {
  const candidateWindow = certificateWindow(candidate.certificatePem);
  const currentWindow = certificateWindow(current.certificatePem);
  if (candidateWindow === undefined || currentWindow === undefined) {
    return false;
  }
  return (
    candidate.identityId === current.identityId &&
    candidateWindow.notBefore.getTime() > currentWindow.notBefore.getTime()
  );
}

/** Parses a certificate for tests and diagnostics. */
export function certificateSerial(identity: StoredIdentity): string {
  try {
    return new X509Certificate(identity.certificatePem).serialNumber;
  } catch {
    return "";
  }
}

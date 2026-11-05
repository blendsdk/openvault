import "reflect-metadata";
import { createPrivateKey } from "node:crypto";
import { hostname as systemHostname } from "node:os";
import type { AgentConsumer, AgentJoinRequest } from "@openvault/api-contract";
import * as x509 from "@peculiar/x509";
import type { VaultClient, VaultClientError } from "./client.js";
import type { AgentConfig } from "./config.js";
import { AgentError } from "./errors.js";
import type { AgentLogger } from "./logger.js";
import type { AgentManifest } from "./manifest.js";
import { type AgentStateStore, certificateMatchesKey, type StoredIdentity } from "./state.js";

/** Generated key material for a join or renewal request. */
export interface GeneratedKeyMaterial {
  /** Signature-ready key pair. */
  readonly keys: CryptoKeyPair;
  /** PKCS#8 private key PEM. */
  readonly privateKeyPem: string;
  /** PKCS#10 CSR PEM. */
  readonly csrPem: string;
}

/** Options for {@link joinAgent}. */
export interface JoinAgentOptions {
  readonly config: AgentConfig;
  readonly manifest: AgentManifest;
  readonly store: AgentStateStore;
  readonly client: VaultClient;
  readonly logger: AgentLogger;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Returns true when the runner has entered the terminal path. */
  readonly isCancelled?: () => boolean;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const RETRY_WINDOW_MS = 5 * 60_000;

/** Waits for a duration. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates an EC P-256 key pair and a PKCS#10 CSR.
 *
 * The subject is deliberately generic; the server derives the certificate
 * identity from the join token and never copies CSR extensions.
 *
 * @returns The key pair, PKCS#8 private key PEM, and CSR PEM.
 */
export async function generateKeyMaterial(): Promise<GeneratedKeyMaterial> {
  const keys = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=openvault-agent",
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  });
  const der = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyObject = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const exported = keyObject.export({ format: "pem", type: "pkcs8" });
  const privateKeyPem = typeof exported === "string" ? exported : exported.toString("utf8");
  return { keys, privateKeyPem, csrPem: request.toString("pem") };
}

/** Builds the self-reported consumer metadata. */
export function consumerMetadata(config: AgentConfig, manifest: AgentManifest): AgentConsumer {
  let host = systemHostname();
  host = host.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 255);
  if (host.length === 0) {
    host = "agent";
  }
  return {
    composeProject: config.composeProject,
    composeService: config.service,
    hostname: host,
    manifestHash: manifest.hash,
  };
}

/** Builds a stored identity from one certificate response. */
export function storedIdentity(
  response: {
    readonly certificatePem: string;
    readonly identityId: string;
    readonly serial: string;
    readonly notAfter: string;
  },
  privateKeyPem: string,
  now: number,
): StoredIdentity {
  return {
    version: 1,
    identityId: response.identityId,
    certificatePem: response.certificatePem,
    privateKeyPem,
    serial: response.serial,
    notAfter: response.notAfter,
    joinedAt: new Date(now).toISOString(),
  };
}

/** Returns true for a transient client failure. */
function isTransient(error: unknown): error is VaultClientError {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "name") === "VaultClientError" &&
    Reflect.get(error, "kind") === "transient"
  );
}

/**
 * Joins a service identity on first start.
 *
 * A valid stored identity is reused without a network call. Otherwise one
 * P-256 key/CSR is generated and the same request is retried on transient
 * failures; credential, validation, and not-found failures are terminal.
 *
 * @param options - Config, manifest, state, client, and clock seams.
 * @returns The usable stored identity.
 * @throws {AgentError} `agent_join_token_required` or `agent_join_failed`.
 */
export async function joinAgent(options: JoinAgentOptions): Promise<StoredIdentity> {
  if (options.isCancelled?.() === true) {
    throw new AgentError("agent_join_failed", "Join cancelled");
  }
  const existing = options.store.loadIdentity();
  if (existing !== undefined) {
    return existing;
  }
  if (options.config.joinToken === undefined) {
    throw new AgentError(
      "agent_join_token_required",
      "No valid certificate state; set OPENVAULT_JOIN_TOKEN and restart",
    );
  }

  const generated = await generateKeyMaterial();
  const request: AgentJoinRequest = {
    token: options.config.joinToken,
    csr: generated.csrPem,
    consumer: consumerMetadata(options.config, options.manifest),
  };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    if (options.isCancelled?.() === true) {
      throw new AgentError("agent_join_failed", "Join cancelled");
    }
    try {
      const response = await options.client.join(request);
      if (!certificateMatchesKey(response.certificatePem, generated.privateKeyPem)) {
        throw new AgentError("agent_join_failed", "Join returned a mismatched certificate");
      }
      const identity = storedIdentity(response, generated.privateKeyPem, now());
      options.store.saveIdentity(identity);
      options.logger.info("agent_joined", {
        identityId: identity.identityId,
        project: options.manifest.project,
        service: options.manifest.service,
      });
      return identity;
    } catch (error) {
      if (!isTransient(error) || now() - startedAt >= RETRY_WINDOW_MS) {
        throw new AgentError("agent_join_failed", "Join failed; issue a new join token", {
          cause: error,
        });
      }
      attempt += 1;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      options.logger.warn("agent_join_retry", { attempt, delayMs: delay });
      const deadline = now() + delay;
      while (now() < deadline) {
        if (options.isCancelled?.() === true) {
          throw new AgentError("agent_join_failed", "Join cancelled");
        }
        await sleep(Math.min(250, deadline - now()));
      }
      if (options.isCancelled?.() === true) {
        throw new AgentError("agent_join_failed", "Join cancelled");
      }
    }
  }
}

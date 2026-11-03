import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { OpenVaultConfig } from "../config/index.js";
import { createIdentityRuntime, type IdentityRuntime } from "../identity/identity-runtime.js";
import { CaSigner } from "../security/ca.js";
import type { KeyringProvider } from "../security/keyring.js";
import type { TlsMaterial } from "../transport/tls.js";
import { DatabaseAgentAuthenticator } from "./agent-authenticator.js";
import { AgentJoinService } from "./agent-join-service.js";
import {
  type AgentRateLimitOptions,
  type AgentRateLimitService,
  createAgentRateLimitService,
} from "./agent-rate-limits.js";
import { AgentRenewService, RenewalReplayCache } from "./agent-renew-service.js";
import { ConsumerRepository } from "./consumer-repository.js";
import { DatabaseProjectResolver } from "./project-resolver.js";

/** The Phase 3 agent runtime core shared by the application and tests. */
export interface AgentRuntimeCore {
  /** Loaded CA signer. */
  readonly caSigner: CaSigner;
  /** Live certificate authenticator. */
  readonly authenticator: DatabaseAgentAuthenticator;
  /** Active-project resolver for data routes. */
  readonly projectResolver: DatabaseProjectResolver;
  /** Single identity service owner. */
  readonly identityRuntime: IdentityRuntime;
  /** Join orchestration. */
  readonly joinService: AgentJoinService;
  /** Renewal orchestration. */
  readonly renewService: AgentRenewService;
  /** Per-application rate limiters. */
  readonly rateLimits: AgentRateLimitService;
  /** Process-local renewal replay cache. */
  readonly renewalCache: RenewalReplayCache;
}

/** Options for {@link createAgentRuntime}. */
export interface CreateAgentRuntimeOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Loaded keyring. */
  readonly keyring: KeyringProvider;
  /** Loaded TLS and internal CA material. */
  readonly tls: TlsMaterial;
  /** Validated runtime configuration. */
  readonly config: OpenVaultConfig;
  /** Injectable clock for authentication and renewal. */
  readonly now?: () => number;
  /** Test-only limiter thresholds; production leaves this empty. */
  readonly rateLimitOptions?: AgentRateLimitOptions;
}

/**
 * Builds the production agent runtime.
 *
 * The CA signer is loaded before the listeners bind, so a missing or
 * mismatched current row aborts startup. The identity runtime is created once
 * and owns the token service used by join and administrative issuance. Its
 * revoke hook clears both process-local positive caches after commit.
 *
 * @param options - Database, keyring, TLS material, config, and clock seam.
 * @returns The composed runtime.
 * @throws {CaSignerUnavailableError} When the internal CA cannot be loaded.
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntimeCore> {
  const caSigner = await CaSigner.load({
    database: options.database,
    keyring: options.keyring,
    caPem: options.tls.caPem,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const authenticator = new DatabaseAgentAuthenticator({
    database: options.database,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const projectResolver = new DatabaseProjectResolver(options.database);
  const consumers = new ConsumerRepository(options.database);
  const renewalCache = new RenewalReplayCache(
    options.now === undefined ? {} : { now: options.now },
  );
  const renewService = new AgentRenewService({
    database: options.database,
    consumers,
    signer: caSigner,
    config: options.config,
    cache: renewalCache,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const identityRuntime = createIdentityRuntime({
    database: options.database,
    config: options.config,
    onRevoked: (principalId) => {
      authenticator.invalidatePrincipal(principalId);
      renewService.invalidatePrincipal(principalId);
    },
  });
  const joinService = new AgentJoinService({
    database: options.database,
    tokens: identityRuntime.tokens,
    consumers,
    signer: caSigner,
    config: options.config,
  });

  return {
    caSigner,
    authenticator,
    projectResolver,
    identityRuntime,
    joinService,
    renewService,
    rateLimits: createAgentRateLimitService(options.rateLimitOptions),
    renewalCache,
  };
}

import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";
import type { OpenVaultConfig } from "../config/index.js";
import { createIdentityRuntime, type IdentityRuntime } from "../identity/identity-runtime.js";
import { createPolicyRuntime, type PolicyRuntime } from "../rbac/runtime.js";
import { CaSigner } from "../security/ca.js";
import type { KeyringProvider } from "../security/keyring.js";
import type { TlsMaterial } from "../transport/tls.js";
import { DatabaseAgentAuthenticator } from "./agent-authenticator.js";
import { AgentJoinService } from "./agent-join-service.js";
import {
  AgentMaintenanceService,
  DatabaseAgentMaintenanceRepository,
} from "./agent-maintenance.js";
import {
  type AgentRateLimitOptions,
  type AgentRateLimitService,
  createAgentRateLimitService,
} from "./agent-rate-limits.js";
import { AgentRenewService, RenewalReplayCache } from "./agent-renew-service.js";
import { ConsumerRepository } from "./consumer-repository.js";
import { DatabaseProjectResolver } from "./project-resolver.js";

/** The agent runtime core shared by the application and tests. */
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
  /** Shared policy runtime. */
  readonly policyRuntime: PolicyRuntime;
}

/** The complete agent runtime, including maintenance and disposal. */
export interface AgentRuntime extends AgentRuntimeCore {
  /** Bounded daily retention cleanup. */
  readonly maintenance: AgentMaintenanceService;
  /** Stops maintenance, clears caches, and drops the CA key references. */
  dispose(): Promise<void>;
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
  /** Shared structured logger; absent in unit-focused tests. */
  readonly logger?: Logger;
  /** Injectable clock for authentication and renewal. */
  readonly now?: () => number;
  /** Test-only limiter thresholds; production leaves this empty. */
  readonly rateLimitOptions?: AgentRateLimitOptions;
  /** Retention scheduler interval; tests may shorten it. */
  readonly maintenanceIntervalMs?: number;
  /** Rows deleted per table per cleanup run. */
  readonly maintenanceBatchSize?: number;
}

/** Keeps tests and offline listeners quiet without a logger dependency. */
const silentLogger: Logger = {
  info: async () => undefined,
  error: async () => undefined,
  warn: async () => undefined,
  debug: async () => undefined,
};

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
): Promise<AgentRuntime> {
  const policyRuntime = createPolicyRuntime({
    database: options.database,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
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
    policyService: policyRuntime.service,
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

  const maintenance = new AgentMaintenanceService({
    repository: new DatabaseAgentMaintenanceRepository(options.database),
    logger: options.logger ?? silentLogger,
    ...(options.maintenanceIntervalMs === undefined
      ? {}
      : { intervalMs: options.maintenanceIntervalMs }),
    ...(options.maintenanceBatchSize === undefined
      ? {}
      : { batchSize: options.maintenanceBatchSize }),
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
    policyRuntime,
    maintenance,
    async dispose(): Promise<void> {
      await maintenance.stop();
      authenticator.clear();
      renewService.clear();
      caSigner.destroy();
    },
  };
}

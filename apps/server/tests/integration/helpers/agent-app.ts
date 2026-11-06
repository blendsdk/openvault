import type { Writable } from "node:stream";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AgentRateLimitOptions } from "../../../src/agent/agent-rate-limits.js";
import { type AgentRuntime, createAgentRuntime } from "../../../src/agent/agent-runtime.js";
import { createApplication } from "../../../src/app.js";
import { createLoggerProvider } from "../../../src/observability/logger.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../../src/transport/secure-application.js";
import { TlsMaterial } from "../../../src/transport/tls.js";
import type { AgentCaFixture } from "./agent-tls.js";
import { seedCaKey, writeServerCertificateForCa } from "./agent-tls.js";
import type { ServerEnvironment } from "./server-environment.js";
import { createServerEnvironment } from "./server-environment.js";

export type { ServerEnvironment } from "./server-environment.js";

import type { TestDatabase } from "./test-database.js";

/** A running application backed by the real agent runtime. */
export interface AgentTestServer {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly runtime: AgentRuntime;
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly tls: TlsMaterial;
  stop(): Promise<void>;
}

/**
 * Creates a server environment whose server certificate is signed by the agent
 * test CA, and whose client trust bundle is that same CA.
 *
 * @param ca - Agent CA fixture.
 * @param overrides - Environment values that replace the defaults.
 * @returns A configured environment with matching server and client trust.
 */
export async function createAgentServerEnvironment(
  ca: AgentCaFixture,
  overrides: NodeJS.ProcessEnv = {},
): Promise<ServerEnvironment> {
  const environment = createServerEnvironment({
    ...overrides,
    OPENVAULT_INTERNAL_CA: ca.certPath,
  });
  await writeServerCertificateForCa(
    ca,
    environment.config.tlsCertPath,
    environment.config.tlsKeyPath,
  );
  Object.assign(environment.tls, { caPem: ca.certPem, caPath: ca.certPath });
  return environment;
}

/**
 * Starts the real agent runtime and both HTTPS listeners.
 *
 * @param options - Migrated database, environment, CA fixture, clock, and limiter overrides.
 * @returns The running server and its composed runtime.
 */
export async function startAgentTestServer(options: {
  readonly testDb: TestDatabase;
  readonly environment: ServerEnvironment;
  readonly ca: AgentCaFixture;
  readonly now?: () => number;
  readonly rateLimitOptions?: AgentRateLimitOptions;
  readonly maintenanceBatchSize?: number;
  readonly loggerDestination?: Writable;
  readonly seedCa?: boolean;
  /** Optional separate database/pool; defaults to the test database. */
  readonly database?: PostgreSQLDatabase;
  readonly configure?: (app: SecureWebApplication) => void;
}): Promise<AgentTestServer> {
  const keyring = await KeyringProvider.load(options.environment.keyringPath);
  const tls = TlsMaterial.load(options.environment.config);
  if (options.seedCa !== false) {
    await options.testDb.db.executeQuery("DELETE FROM ca_keys");
    await seedCaKey(options.testDb.db, keyring, options.ca);
  }
  const database = options.database ?? options.testDb.db;
  const logger =
    options.loggerDestination === undefined
      ? undefined
      : createLoggerProvider(options.environment.config, options.loggerDestination);
  const runtime = await createAgentRuntime({
    database,
    keyring,
    tls,
    config: options.environment.config,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.rateLimitOptions === undefined
      ? {}
      : { rateLimitOptions: options.rateLimitOptions }),
    ...(options.maintenanceBatchSize === undefined
      ? {}
      : { maintenanceBatchSize: options.maintenanceBatchSize }),
    ...(logger === undefined ? {} : { logger }),
  });
  const app = createApplication(options.environment.config, {
    database,
    tls,
    keyring,
    agentRuntime: runtime,
    ...(options.loggerDestination === undefined
      ? {}
      : { loggerDestination: options.loggerDestination }),
    ...(logger === undefined ? {} : { logger }),
  });
  options.configure?.(app);
  await app.prepare();
  // Resolve the runtime so WebAFX disposal owns it; integration tests need the
  // same dispose path as production.
  await app.getService<AgentRuntime>("agentRuntime");
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return {
    app,
    handle,
    runtime,
    database,
    keyring,
    tls,
    stop: () => handle.stop(),
  };
}

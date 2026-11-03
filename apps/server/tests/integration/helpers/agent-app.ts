import type { Writable } from "node:stream";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AgentRateLimitOptions } from "../../../src/agent/agent-rate-limits.js";
import { type AgentRuntime, createAgentRuntime } from "../../../src/agent/agent-runtime.js";
import { createApplication } from "../../../src/app.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../../src/transport/secure-application.js";
import { TlsMaterial } from "../../../src/transport/tls.js";
import type { AgentCaFixture } from "./agent-tls.js";
import { seedCaKey } from "./agent-tls.js";
import type { ServerEnvironment } from "./server-environment.js";
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
  });
  const app = createApplication(options.environment.config, {
    database,
    tls,
    keyring,
    agentRuntime: runtime,
    ...(options.loggerDestination === undefined
      ? {}
      : { loggerDestination: options.loggerDestination }),
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

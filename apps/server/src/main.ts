import { formatMigrationError, MigrationError, runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createAgentRuntime } from "./agent/agent-runtime.js";
import { bootstrapAgentRuntime } from "./agent/bootstrap.js";
import { createApplication } from "./app.js";
import { createAuditCore } from "./audit/runtime.js";
import { bootstrapAuthRuntime } from "./auth/bootstrap.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { migrationConfigPath } from "./db/config.js";
import { createLoggerProvider } from "./observability/logger.js";
import { KeyringProvider } from "./security/keyring.js";
import { TlsMaterial } from "./transport/tls.js";

let keyring: KeyringProvider | undefined;

/**
 * Runs startup migrations with the migrator URL when one is configured.
 *
 * The BlendSDK migration runner reads `OPENVAULT_DB_URL`, so this helper
 * temporarily supplies the migrator URL and restores the previous value even
 * when migration fails. The application database connection then uses the
 * runtime role from `config.database`.
 */
async function runStartupMigrations(
  databaseUrl: string,
  migrationDatabaseUrl: string | undefined,
  runAtStartup: boolean,
): Promise<void> {
  if (!runAtStartup) {
    return;
  }
  // The runner reads OPENVAULT_DB_URL. Pass the explicit value even when no
  // migration URL was configured, because a file-backed URL never appears in
  // process.env.
  const previous = process.env.OPENVAULT_DB_URL;
  process.env.OPENVAULT_DB_URL = migrationDatabaseUrl ?? databaseUrl;
  try {
    await runMigrations({ command: "up", configPath: migrationConfigPath });
  } finally {
    if (previous === undefined) {
      delete process.env.OPENVAULT_DB_URL;
    } else {
      process.env.OPENVAULT_DB_URL = previous;
    }
  }
}

try {
  const config = loadConfig(process.env);
  keyring = await KeyringProvider.load(config.keyringPath);
  const tls = TlsMaterial.load(config);

  await runStartupMigrations(
    config.databaseUrl,
    config.migrationDatabaseUrl,
    config.runMigrationsAtStartup,
  );

  const database = new PostgreSQLDatabase({
    ...config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });

  const logger = createLoggerProvider(config);
  const auditDatabase = new PostgreSQLDatabase({
    ...config.database,
    poolConfig: { max: 1, idleTimeoutMillis: 100 },
    enableGracefulShutdown: false,
  });
  const auditCore = createAuditCore({
    database,
    independentDatabase: auditDatabase,
    keyring,
  });
  const agentRuntime = await createAgentRuntime({
    database,
    keyring,
    tls,
    config,
    logger,
    auditCore,
  });
  const app = createApplication(config, {
    database,
    tls,
    keyring,
    logger,
    agentRuntime,
    auditRuntime: agentRuntime.auditRuntime,
  });
  app.registerService({
    name: "auditDatabase",
    type: "singleton",
    factory: () => auditDatabase,
    dispose: async (database) => {
      if (database instanceof PostgreSQLDatabase) {
        await database.disconnect();
      }
    },
  });
  // Resolve the singleton so the service container owns its shutdown.
  await app.getService("auditDatabase");
  await app.prepare();
  await bootstrapAuthRuntime(app);
  await bootstrapAgentRuntime(app);
  await app.startTransport();
} catch (error) {
  keyring?.destroy();

  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof MigrationError) {
    process.stderr.write(`${formatMigrationError(error)}\n`);
  } else {
    process.stderr.write(`Startup failed: ${error instanceof Error ? error.name : "unknown"}\n`);
  }
  process.exit(1);
}

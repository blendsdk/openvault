import { formatMigrationError, MigrationError, runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createAgentRuntime } from "./agent/agent-runtime.js";
import { bootstrapAgentRuntime } from "./agent/bootstrap.js";
import { createApplication } from "./app.js";
import { createAuditCore, createAuditRuntime } from "./audit/runtime.js";
import { bootstrapAuthRuntime } from "./auth/bootstrap.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { migrationConfigPath } from "./db/config.js";
import { createLoggerProvider } from "./observability/logger.js";
import { KeyringProvider } from "./security/keyring.js";
import { TlsMaterial } from "./transport/tls.js";

let keyring: KeyringProvider | undefined;

try {
  const config = loadConfig(process.env);
  keyring = await KeyringProvider.load(config.keyringPath);
  const tls = TlsMaterial.load(config);

  await runMigrations({ command: "up", configPath: migrationConfigPath });

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
    audit: auditCore.policyAudit,
  });
  const auditRuntime = createAuditRuntime({
    core: auditCore,
    policy: agentRuntime.policyRuntime.service,
    database,
    keyring,
  });
  const app = createApplication(config, {
    database,
    tls,
    keyring,
    logger,
    agentRuntime,
    auditRuntime,
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

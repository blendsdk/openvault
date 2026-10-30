import { formatMigrationError, MigrationError, runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createApplication } from "./app.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { migrationConfigPath } from "./db/config.js";
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

  const app = createApplication(config, { database, tls, keyring });
  await app.prepare();
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

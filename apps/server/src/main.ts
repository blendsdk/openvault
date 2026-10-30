import { formatMigrationError, MigrationError, runMigrations } from "blendsdk/codegen";
import { createApp } from "./app.js";
import { migrationConfigPath } from "./db/config.js";

try {
  await runMigrations({ command: "up", configPath: migrationConfigPath });
} catch (error) {
  if (error instanceof MigrationError) {
    process.stderr.write(`${formatMigrationError(error)}\n`);
  } else {
    process.stderr.write(
      `Startup migration failed: ${error instanceof Error ? error.name : "unknown"}\n`,
    );
  }
  process.exit(1);
}

const app = createApp();
await app.start();

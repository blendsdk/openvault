import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createApp } from "./app.js";
import { defaultMigrationsDirectory, migrate } from "./db/migrate.js";
import { parseDatabaseUrl } from "./db/url.js";

const databaseUrl = process.env.OPENVAULT_DB_URL;
if (!databaseUrl) {
  process.stderr.write("OPENVAULT_DB_URL is required.\n");
  process.exit(1);
}

const db = new PostgreSQLDatabase(parseDatabaseUrl(databaseUrl));
try {
  await migrate(db, defaultMigrationsDirectory);
} catch (error) {
  process.stderr.write(
    `Startup migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  await db.disconnect().catch(() => undefined);
  process.exit(1);
}

const app = createApp();
await app.start();

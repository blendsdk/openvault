import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { defaultMigrationsDirectory, migrate } from "./migrate.js";
import { parseDatabaseUrl } from "./url.js";

/**
 * Runs the migration command.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument: ${unknown[0]}\n`);
    return 2;
  }

  const databaseUrl = process.env.OPENVAULT_DB_URL;
  if (!databaseUrl) {
    process.stderr.write("OPENVAULT_DB_URL is required.\n");
    return 1;
  }

  const db = new PostgreSQLDatabase(parseDatabaseUrl(databaseUrl));
  try {
    const result = await migrate(db, defaultMigrationsDirectory, { dryRun });
    const ids = dryRun ? result.pending : result.applied;
    if (ids.length === 0) {
      process.stdout.write("No pending migrations.\n");
      return 0;
    }
    process.stdout.write(dryRun ? "Pending migrations:\n" : "Applied migrations:\n");
    for (const id of ids) {
      process.stdout.write(`  ${id} ${result.checksums[id] ?? ""}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    await db.disconnect().catch(() => undefined);
  }
}

const exitCode = await main();
process.exitCode = exitCode;

import {
  formatMigrationError,
  getMigrationStatus,
  MigrationError,
  runMigrations,
  validateMigrations,
} from "blendsdk/codegen";
import { migrationConfigPath } from "./config.js";

/**
 * Reports whether a migration status needs operator attention.
 *
 * @param status - Codegen migration status.
 * @returns True for invalid, locked, or unknown-outcome states.
 */
function isUnhealthy(status: string): boolean {
  return status === "INVALID_HISTORY" || status === "LOCKED" || status === "UNKNOWN_OUTCOME";
}

/**
 * Runs the migration command.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const allowed = new Set(["--dry-run", "--status", "--validate"]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown) {
    process.stderr.write(`Unknown argument: ${unknown}\n`);
    return 2;
  }

  try {
    if (args.includes("--status")) {
      const result = await getMigrationStatus({
        configPath: migrationConfigPath,
      });
      process.stdout.write(`${result.status}\n`);
      for (const migration of result.migrations) {
        process.stdout.write(`  ${migration.id}\n`);
      }
      return isUnhealthy(result.status) ? 1 : 0;
    }

    if (args.includes("--validate")) {
      const result = await validateMigrations({
        configPath: migrationConfigPath,
      });
      process.stdout.write(`${result.status}\n`);
      return isUnhealthy(result.status) ? 1 : 0;
    }

    const result = await runMigrations({
      command: "up",
      configPath: migrationConfigPath,
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${result.status}\n`);
    for (const migration of result.migrations) {
      process.stdout.write(`  ${migration.id}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      process.stderr.write(`${formatMigrationError(error)}\n`);
    } else {
      process.stderr.write(
        `Migration failed: ${error instanceof Error ? error.name : "unknown"}\n`,
      );
    }
    return 1;
  }
}

const exitCode = await main();
process.exitCode = exitCode;

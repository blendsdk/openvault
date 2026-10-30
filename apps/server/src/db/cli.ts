import { getMigrationStatus, runMigrations, validateMigrations } from "blendsdk/codegen";
import { migrationConfigPath } from "./config.js";

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
      return 0;
    }

    if (args.includes("--validate")) {
      const result = await validateMigrations({
        configPath: migrationConfigPath,
      });
      process.stdout.write(`${result.status}\n`);
      return result.status === "INVALID_HISTORY" ? 1 : 0;
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
    process.stderr.write(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const exitCode = await main();
process.exitCode = exitCode;

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { loadConfig } from "../config/index.js";
import { KeyringProvider } from "../security/keyring.js";
import { AuditPruner } from "./audit-prune.js";
import { AuditEventQuery } from "./audit-query.js";
import { AuditVerifier } from "./audit-verify.js";
import { AuditWriter } from "./audit-writer.js";
import { createPruneConnection } from "./prune-connection.js";

const USAGE = "Usage: audit:prune --out <absolute-path> [--dry-run]";

/** Parsed prune command arguments. */
interface PruneArguments {
  readonly outputPath: string;
  readonly dryRun: boolean;
}

/** Parses the command line, or throws a usage error. */
function parseArguments(argv: readonly string[]): PruneArguments {
  let outputPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(USAGE);
      }
      outputPath = value;
      index += 1;
    } else {
      throw new Error(USAGE);
    }
  }
  if (outputPath === undefined) {
    throw new Error(USAGE);
  }
  if (!isAbsolute(outputPath)) {
    throw new Error("--out must be an absolute path");
  }
  if (existsSync(outputPath)) {
    throw new Error("--out already exists");
  }
  return { outputPath, dryRun };
}

/** Runs the prune command. */
async function main(): Promise<number> {
  let args: PruneArguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : USAGE}\n`);
    return 2;
  }

  let keyring: KeyringProvider | undefined;
  let database: PostgreSQLDatabase | undefined;
  let prune: Awaited<ReturnType<typeof createPruneConnection>> | undefined;
  try {
    const config = loadConfig(process.env);
    keyring = await KeyringProvider.load(config.keyringPath);
    database = new PostgreSQLDatabase({
      ...config.database,
      enableGracefulShutdown: false,
    });
    const pruneConnection = await createPruneConnection(process.env.OPENVAULT_PRUNE_DB_URL);
    prune = pruneConnection;
    const writer = new AuditWriter({ database, keyring });
    const query = new AuditEventQuery({ database, keyring });
    const verifier = new AuditVerifier({ database, keyring });
    const pruner = new AuditPruner({
      database,
      writer,
      query,
      verifier,
      databaseName: config.database.database ?? "",
      deletePrefix: (lastEventId, expected) => pruneConnection.deletePrefix(lastEventId, expected),
      retentionDays: config.auditRetentionDays,
    });
    const result = await pruner.prune({
      outputPath: args.outputPath,
      dryRun: args.dryRun,
    });
    process.stdout.write(
      `pruned=${result.deletedCount} exported=${result.exportedCount} checkpoint=${result.checkpointId ?? "none"} dryRun=${result.dryRun}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Prune failed"}\n`);
    return 1;
  } finally {
    await prune?.close().catch(() => undefined);
    if (database !== undefined) {
      await database.disconnect().catch(() => undefined);
    }
    keyring?.destroy();
  }
}

if (process.argv[1]?.endsWith("cli.js") === true) {
  const code = await main();
  process.exitCode = code;
}

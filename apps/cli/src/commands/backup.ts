import { dirname, join, resolve } from "node:path";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { databaseUrlFromEnv } from "./database-url.js";
import { flagOption, requiredText, textOption } from "./options.js";
import { resolvePassphrase } from "./passphrase.js";

/** Resolves one required absolute environment path. */
function envPath(runtime: CliRuntime, name: string): string {
  const value = runtime.env[name];
  if (value === undefined || value.length === 0) {
    throw new CliError("usage_error", `${name} is required in the environment`, {
      exitCode: 2,
    });
  }
  return value;
}

/** Builds the backup group parser. */
export function createBackupParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov backup", version: "0.1.0", strict: true });
  parser.addCommand({
    name: "backup",
    description: "Create an encrypted logical backup",
    options: [
      { name: "out", type: "string", required: true, description: "Archive path" },
      { name: "passphrase-file", type: "string", description: "0600 passphrase file" },
      { name: "keyring", type: "string", description: "Keyring path (default: OPENVAULT_KEYRING)" },
      {
        name: "internal-ca",
        type: "string",
        description: "Public internal CA path (default: OPENVAULT_INTERNAL_CA)",
      },
      { name: "force", type: "boolean", description: "Replace an existing archive" },
    ],
    handler: async (options) => {
      const databaseUrl = databaseUrlFromEnv(runtime);
      const backupDatabaseUrl = databaseUrlFromEnv(runtime, "OPENVAULT_BACKUP_DB_URL");
      const keyringPath = resolve(
        runtime.cwd,
        textOption(options, "keyring") ?? envPath(runtime, "OPENVAULT_KEYRING"),
      );
      const tlsCertPath = runtime.env.OPENVAULT_TLS_CERT;
      const internalCaRaw =
        textOption(options, "internal-ca") ??
        runtime.env.OPENVAULT_INTERNAL_CA ??
        (tlsCertPath === undefined ? undefined : join(dirname(tlsCertPath), "ca.pem"));
      if (internalCaRaw === undefined) {
        throw new CliError(
          "usage_error",
          "OPENVAULT_INTERNAL_CA or OPENVAULT_TLS_CERT is required",
          { exitCode: 2 },
        );
      }
      const internalCaPath = resolve(runtime.cwd, internalCaRaw);
      const passphrase = await resolvePassphrase({
        flag: textOption(options, "passphrase-file"),
        envName: "OPENVAULT_BACKUP_PASSPHRASE_FILE",
        runtime,
        prompt: "Backup passphrase",
      });
      const runner = runtime.runBackup ?? (await import("@openvault/server/ops")).runBackup;
      const result = await runner({
        databaseUrl,
        backupDatabaseUrl,
        keyringPath,
        internalCaPath,
        ...(tlsCertPath === undefined ? {} : { tlsCertPath }),
        ...(runtime.env.OPENVAULT_TLS_KEY === undefined
          ? {}
          : { tlsKeyPath: runtime.env.OPENVAULT_TLS_KEY }),
        outPath: resolve(runtime.cwd, requiredText(options, "out")),
        passphrase,
        force: flagOption(options, "force"),
        env: runtime.env,
      });
      context.render(
        result,
        (value) =>
          `Wrote ${value.outPath} (${value.bytes} bytes, ${value.objectCount} rows)\nsha256: ${value.sha256}`,
      );
      return undefined;
    },
  });
  return parser;
}

/** The backup group definition. */
export const backupGroup: CommandGroup = {
  name: "backup",
  summary: "Create an encrypted logical backup",
  commands: ["backup"],
  createParser: createBackupParser,
};

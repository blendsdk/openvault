import { dirname, join, resolve } from "node:path";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { databaseUrlFromEnv } from "./database-url.js";
import { flagOption, requiredText, textOption } from "./options.js";
import { resolvePassphrase } from "./passphrase.js";

/** Builds the restore group parser. */
export function createRestoreParser(
  globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov restore", version: "1.2.0", strict: true });
  parser.addCommand({
    name: "restore",
    description: "Restore an encrypted backup into a migrated target",
    options: [
      { name: "archive", type: "string", required: true, description: "Archive path" },
      { name: "passphrase-file", type: "string", description: "0600 passphrase file" },
      { name: "keyring", type: "string", description: "Keyring path (default: OPENVAULT_KEYRING)" },
      {
        name: "internal-ca",
        type: "string",
        description: "Public internal CA path (default: OPENVAULT_INTERNAL_CA)",
      },
      { name: "ca-public-dir", type: "string", description: "Proxy CA directory for ca.pem" },
      {
        name: "agent-certificate",
        type: "string",
        description: "Pre-backup agent certificate PEM to verify after restore",
      },
      { name: "force", type: "boolean", description: "Replace a non-empty target" },
    ],
    handler: async (options) => {
      const archivePath = resolve(runtime.cwd, requiredText(options, "archive"));
      const databaseUrl = databaseUrlFromEnv(runtime);
      const restoreDatabaseUrl =
        databaseUrlFromEnv(runtime, "OPENVAULT_RESTORE_DB_URL", false) ??
        databaseUrlFromEnv(runtime, "OPENVAULT_MIGRATION_DB_URL", false);
      const keyringRaw = textOption(options, "keyring") ?? runtime.env.OPENVAULT_KEYRING;
      if (keyringRaw === undefined) {
        throw new CliError("usage_error", "OPENVAULT_KEYRING is required", { exitCode: 2 });
      }
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
      await context.confirm(
        `Restore ${archivePath}? This replaces the target database and keyring.`,
      );
      const passphrase = await resolvePassphrase({
        flag: textOption(options, "passphrase-file"),
        envName: "OPENVAULT_BACKUP_PASSPHRASE_FILE",
        runtime,
        prompt: "Backup passphrase",
      });
      const caPublicDir =
        textOption(options, "ca-public-dir") ?? runtime.env.OPENVAULT_CA_PUBLIC_DIR;
      const agentCertificateRaw =
        textOption(options, "agent-certificate") ?? runtime.env.OPENVAULT_RESTORE_AGENT_CERTIFICATE;
      const runner = runtime.runRestore ?? (await import("@openvault/server/ops")).runRestore;
      const result = await runner({
        archivePath,
        passphrase,
        databaseUrl,
        ...(restoreDatabaseUrl === undefined ? {} : { restoreDatabaseUrl }),
        keyringPath: resolve(runtime.cwd, keyringRaw),
        internalCaPath: resolve(runtime.cwd, internalCaRaw),
        ...(caPublicDir === undefined ? {} : { caPublicDir: resolve(runtime.cwd, caPublicDir) }),
        ...(agentCertificateRaw === undefined
          ? {}
          : { agentCertificatePath: resolve(runtime.cwd, agentCertificateRaw) }),
        force: flagOption(options, "force"),
      });
      context.render(
        result,
        (value) =>
          `Restored ${value.objectCount} rows across ${value.tables.length} tables\n` +
          `audit chain: ${value.auditOk ? "ok" : "broken"}\n` +
          `secrets verified: ${value.secretsVerified}\n` +
          `certificate private keys verified: ${value.certificatesVerified}\n` +
          `JWT signing key: ${value.signingKeyVerified ? "verified" : "failed"}\n` +
          `CA key: ${value.caVerified ? "verified" : "failed"}\n` +
          `pre-backup agent certificate: ${value.agentCertificateVerified ? "verified" : "not supplied"}\n` +
          `public CA: ${value.internalCaPath}`,
      );
      return undefined;
    },
  });
  return parser;
}

/** The restore group definition. */
export const restoreGroup: CommandGroup = {
  name: "restore",
  summary: "Restore an encrypted backup",
  commands: ["restore"],
  createParser: createRestoreParser,
};

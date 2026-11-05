import type { InitOptions } from "@openvault/server/init";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { flagOption, textOption } from "./options.js";

/**
 * Builds the init group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createInitParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov init",
    version: "0.1.0",
    strict: true,
  });

  parser.addCommand({
    name: "init",
    description: "Create or reuse the keyring, CA, TLS material, organization, and bootstrap admin",
    options: [
      { name: "prepare", type: "boolean", description: "Use reference-stack environment defaults" },
      { name: "keyring", type: "string", description: "Keyring file path" },
      { name: "internal-ca", type: "string", description: "Public internal CA path" },
      { name: "ca-public-dir", type: "string", description: "Directory that receives ca.pem" },
      { name: "tls-cert", type: "string", description: "Server certificate path" },
      { name: "tls-key", type: "string", description: "Server key path" },
      { name: "base-url", type: "string", description: "Public HTTPS origin" },
      { name: "admin-name", type: "string", description: "Administrator display name" },
      { name: "admin-email", type: "string", description: "Administrator email" },
      {
        name: "password-file",
        type: "string",
        description: "Operator-supplied 0600 password file",
      },
      { name: "generate-password", type: "boolean", description: "Generate a one-time password" },
      {
        name: "bootstrap-password-file",
        type: "string",
        description: "One-time generated password output path",
      },
      {
        name: "replace-ca-public",
        type: "boolean",
        description: "Replace a different public CA file",
      },
    ],
    handler: async (options) => {
      const env = runtime.env;
      const pick = (option: string, envName: string): string | undefined =>
        textOption(options, option) ?? env[envName];
      const databaseUrl = env.OPENVAULT_DB_URL;
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        throw new CliError("usage_error", "OPENVAULT_DB_URL is required in the environment", {
          exitCode: 2,
        });
      }
      const keyringPath = pick("keyring", "OPENVAULT_KEYRING");
      if (keyringPath === undefined || keyringPath.length === 0) {
        throw new CliError("usage_error", "OPENVAULT_KEYRING or --keyring is required", {
          exitCode: 2,
        });
      }
      const prepare = flagOption(options, "prepare");
      const internalCa = pick("internal-ca", "OPENVAULT_INTERNAL_CA");
      const caPublicDir = pick("ca-public-dir", "OPENVAULT_CA_PUBLIC_DIR");
      const tlsCert = pick("tls-cert", "OPENVAULT_TLS_CERT");
      const tlsKey = pick("tls-key", "OPENVAULT_TLS_KEY");
      const baseUrl = pick("base-url", "OPENVAULT_BASE_URL");
      const orgName = globals.org ?? runtime.env.OPENVAULT_ORG_NAME;
      const adminName = pick("admin-name", "OPENVAULT_BOOTSTRAP_ADMIN_NAME");
      const adminEmail = pick("admin-email", "OPENVAULT_BOOTSTRAP_ADMIN_EMAIL");
      const passwordFile = pick("password-file", "OPENVAULT_BOOTSTRAP_PASSWORD_FILE");
      const bootstrapPasswordFile = pick(
        "bootstrap-password-file",
        "OPENVAULT_BOOTSTRAP_PASSWORD_OUTPUT",
      );
      const migrationDatabaseUrl = env.OPENVAULT_MIGRATION_DB_URL;
      const initOptions: InitOptions = {
        databaseUrl,
        keyringPath,
        ...(migrationDatabaseUrl === undefined ? {} : { migrationDatabaseUrl }),
        ...(internalCa === undefined ? {} : { internalCaPath: internalCa }),
        ...(caPublicDir === undefined ? {} : { caPublicDir }),
        ...(tlsCert === undefined ? {} : { tlsCertPath: tlsCert }),
        ...(tlsKey === undefined ? {} : { tlsKeyPath: tlsKey }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(orgName === undefined ? {} : { orgName }),
        ...(adminName === undefined ? {} : { adminName }),
        ...(adminEmail === undefined ? {} : { adminEmail }),
        ...(passwordFile === undefined ? {} : { passwordFile }),
        ...(flagOption(options, "generate-password") || prepare ? { generatePassword: true } : {}),
        ...(bootstrapPasswordFile === undefined ? {} : { bootstrapPasswordFile }),
        ...(flagOption(options, "replace-ca-public") ? { replaceCaPublic: true } : {}),
      };
      const runner = runtime.runInit ?? (await import("@openvault/server/init")).runInit;
      const result = await runner(initOptions);
      for (const warning of result.warnings) {
        runtime.stderr(`warning: ${warning}\n`);
      }
      context.render(result, (value) =>
        [
          `keyring: ${value.keyringCreated ? "created" : "reused"}`,
          `CA: ${value.caCreated ? "created" : "reused"} (${value.internalCaPath})`,
          `server certificate: ${value.serverCertificateCreated ? "created" : "reused"}`,
          `organization: ${value.orgCreated ? "created" : "reused"}`,
          `administrator: ${value.adminCreated ? "created" : "reused"}`,
          `signing key: ${value.signingKeyCreated ? "created" : "reused"}`,
          ...(value.bootstrapPasswordFile === undefined
            ? []
            : [`one-time password file: ${value.bootstrapPasswordFile}`]),
        ].join("\n"),
      );
      return undefined;
    },
  });

  return parser;
}

/** The init group definition. */
export const initGroup: CommandGroup = {
  name: "init",
  summary: "Bootstrap the keyring, CA, TLS material, organization, and administrator",
  commands: ["init"],
  createParser: createInitParser,
};

import { resolve } from "node:path";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { databaseUrlFromEnv } from "./database-url.js";
import { flagOption, textOption } from "./options.js";

/** Builds the KEK group parser. */
export function createKekParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov kek", version: "1.1.0", strict: true });
  parser.addCommand({
    name: "rotate",
    description: "Rotate the KEK and rewrap every stored key",
    options: [
      { name: "dry-run", type: "boolean", description: "Report what would change" },
      { name: "keyring", type: "string", description: "Keyring path (default: OPENVAULT_KEYRING)" },
    ],
    handler: async (options) => {
      const databaseUrl = databaseUrlFromEnv(runtime);
      const keyringRaw = textOption(options, "keyring") ?? runtime.env.OPENVAULT_KEYRING;
      if (keyringRaw === undefined) {
        throw new CliError("usage_error", "OPENVAULT_KEYRING is required", { exitCode: 2 });
      }
      const dryRun = flagOption(options, "dry-run");
      if (!dryRun) {
        await context.confirm("Rotate the KEK and rewrap every stored key?");
      }
      const runner = runtime.runKekRotate ?? (await import("@openvault/server/ops")).runKekRotate;
      const result = await runner({
        databaseUrl,
        keyringPath: resolve(runtime.cwd, keyringRaw),
        dryRun,
      });
      context.render(result, (value) => {
        const header = value.dryRun
          ? `Would rotate ${value.oldKekId} -> ${value.newKekId}`
          : `Rotated ${value.oldKekId} -> ${value.newKekId}`;
        return [
          header,
          `secret versions: ${value.counts.secretVersions}`,
          `certificate versions: ${value.counts.certificateVersions}`,
          `audit keys: ${value.counts.auditKeys}`,
          `CA keys: ${value.counts.caKeys}`,
          `signing keys: ${value.counts.signingKeys}`,
          `old key removed: ${value.oldKeyRemoved ? "yes" : "no"}`,
        ].join("\n");
      });
      return undefined;
    },
  });
  return parser;
}

/** The kek group definition. */
export const kekGroup: CommandGroup = {
  name: "kek",
  summary: "Rotate the key encryption key",
  commands: ["rotate"],
  createParser: createKekParser,
};

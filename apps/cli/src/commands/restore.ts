import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { requiredText } from "./options.js";

const MESSAGE =
  "restore is delivered by RD-13 (backup, rotation, and operations); no server operation exists in this release";

/** Builds the restore group parser. */
export function createRestoreParser(
  globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov restore", version: "0.1.0", strict: true });
  parser.addCommand({
    name: "restore",
    description: "Restore an encrypted backup (RD-13)",
    options: [
      { name: "archive", type: "string", required: true, description: "Archive path" },
      { name: "passphrase-file", type: "string", description: "Passphrase file (0600)" },
    ],
    handler: async (options) => {
      const archive = requiredText(options, "archive");
      await context.confirm(`Restore ${archive}? This rewrites the database and keyring.`);
      throw new CliError("not_implemented", MESSAGE, { exitCode: 1 });
    },
  });
  return parser;
}

/** The restore group definition. */
export const restoreGroup: CommandGroup = {
  name: "restore",
  summary: "Restore an encrypted backup (gated on RD-13)",
  commands: ["restore"],
  createParser: createRestoreParser,
};

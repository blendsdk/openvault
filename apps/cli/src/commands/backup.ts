import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CommandGroup } from "../types.js";

const MESSAGE =
  "backup is delivered by RD-13 (backup, rotation, and operations); no server operation exists in this release";

/** Builds the backup group parser. */
export function createBackupParser(): CommandLineParser {
  const parser = new CommandLineParser({ name: "ov backup", version: "0.1.0", strict: true });
  parser.addCommand({
    name: "backup",
    description: "Create an encrypted backup (RD-13)",
    options: [
      { name: "out", type: "string", description: "Archive path" },
      { name: "passphrase-file", type: "string", description: "Passphrase file (0600)" },
    ],
    handler: () => {
      throw new CliError("not_implemented", MESSAGE, { exitCode: 1 });
    },
  });
  return parser;
}

/** The backup group definition. */
export const backupGroup: CommandGroup = {
  name: "backup",
  summary: "Encrypted backup (gated on RD-13)",
  commands: ["backup"],
  createParser: () => createBackupParser(),
};

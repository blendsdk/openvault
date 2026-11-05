import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";

const MESSAGE =
  "kek rotate is delivered by RD-13 (backup, rotation, and operations); no server operation exists in this release";

/** Builds the kek group parser. */
export function createKekParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov kek", version: "0.1.0", strict: true });
  parser.addCommand({
    name: "rotate",
    description: "Rotate the KEK and re-wrap every key (RD-13)",
    handler: async () => {
      await context.confirm("Rotate the KEK and re-wrap every key?");
      throw new CliError("not_implemented", MESSAGE, { exitCode: 1 });
    },
  });
  return parser;
}

/** The kek group definition. */
export const kekGroup: CommandGroup = {
  name: "kek",
  summary: "KEK rotation (gated on RD-13)",
  commands: ["rotate"],
  createParser: createKekParser,
};

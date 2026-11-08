import { ConfigError, loadConfig, toRedactedConfig } from "@openvault/server/ops";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { flagOption } from "./options.js";

/**
 * Builds the `ov config` group parser.
 *
 * The command reads the server environment, validates it with the same loader
 * the server uses, and prints the support-safe view. It never prints the raw
 * database URL, the database password, the OIDC client secret, or key bytes.
 *
 * @param globals - Parsed global options.
 * @param runtime - Process boundary, including the environment.
 * @returns The command parser.
 */
export function createConfigParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({ name: "ov config", version: "1.0.0", strict: true });
  parser.addCommand({
    name: "show",
    description: "Print the validated server configuration with secrets redacted",
    options: [
      {
        name: "redacted",
        type: "boolean",
        description: "Redact passwords and secrets (required)",
      },
    ],
    handler: async (options) => {
      if (!flagOption(options, "redacted")) {
        throw new CliError("usage_error", "--redacted is required", { exitCode: 2 });
      }
      try {
        const redacted = toRedactedConfig(loadConfig(runtime.env));
        context.render(redacted, (value) => JSON.stringify(value, null, 2));
      } catch (error) {
        if (error instanceof ConfigError) {
          throw new CliError("configuration_error", error.message, { exitCode: 2, cause: error });
        }
        throw error;
      }
      return undefined;
    },
  });
  return parser;
}

/** The config group definition. */
export const configGroup: CommandGroup = {
  name: "config",
  summary: "Inspect the validated server configuration",
  commands: ["show"],
  createParser: createConfigParser,
};

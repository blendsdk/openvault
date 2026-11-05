import { resolve } from "node:path";
import { readPassphraseFile } from "@openvault/server/ops";
import { readPassword } from "../credentials/password.js";
import { CliError } from "../errors.js";
import type { CliRuntime } from "../types.js";

/** Resolves a backup/restore passphrase from a 0600 file, environment, or TTY. */
export async function resolvePassphrase(options: {
  readonly flag: string | undefined;
  readonly envName: string;
  readonly runtime: CliRuntime;
  readonly prompt: string;
}): Promise<string> {
  const configured = options.flag ?? options.runtime.env[options.envName];
  if (configured !== undefined && configured.length > 0) {
    try {
      return readPassphraseFile(resolve(options.runtime.cwd, configured));
    } catch (error) {
      throw new CliError(
        "usage_error",
        error instanceof Error ? error.message : "The passphrase file is invalid",
        { exitCode: 2, cause: error },
      );
    }
  }
  if (!options.runtime.isTty) {
    throw new CliError(
      "usage_error",
      `Use --passphrase-file or ${options.envName} in a non-interactive session`,
      { exitCode: 2 },
    );
  }
  const value = await readPassword({
    stdin: options.runtime.stdin,
    isTty: true,
    prompt: `${options.prompt}: `,
    stderr: options.runtime.stderr,
  });
  if (value.length < 12) {
    throw new CliError("validation_error", "The passphrase must be at least 12 characters", {
      exitCode: 2,
    });
  }
  return value;
}

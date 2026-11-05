import { dispatch } from "./dispatcher.js";
import { asCliError, CliExit } from "./errors.js";
import { writeFailure } from "./output.js";
import type { CliRuntime } from "./types.js";
import { VERSION } from "./version.js";

/** Returns the production process boundary. */
export function defaultRuntime(): CliRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdin: process.stdin,
    isTty: process.stdin.isTTY === true,
    now: Date.now,
  };
}

/**
 * Runs one CLI invocation.
 *
 * @param argv - Arguments after the executable.
 * @param runtime - Process boundary; defaults to the real process.
 * @returns Process exit code.
 */
export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = defaultRuntime(),
): Promise<number> {
  try {
    return await dispatch(argv, runtime);
  } catch (error) {
    if (error instanceof CliExit) {
      if (error.output !== undefined) {
        runtime.stdout(error.output);
      }
      return error.exitCode;
    }
    const cli = asCliError(error);
    writeFailure(
      runtime,
      {
        json: argv.includes("--json"),
        yes: false,
        verbose: false,
        timeoutMs: 15_000,
      },
      cli,
    );
    return cli.exitCode;
  }
}

/** The CLI version. */
export { VERSION };

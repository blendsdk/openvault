import { resolve } from "node:path";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError, CliExit } from "../errors.js";
import { executeRun } from "../run/delivery.js";
import { loadRunManifest } from "../run/manifest.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";

const USAGE = `Usage: ov run [--manifest PATH] -- <command> [args...]

Runs a command with the manifest's secrets delivered through files or the child
environment. The command after -- is never parsed by ov.

Options:
  --manifest PATH   Run manifest (default: openvault.run.yaml)
  -h, --help        Show this help
`;

/** Parses the run arguments before and after `--`. */
function splitRunArguments(argv: readonly string[]): {
  readonly manifest: string | undefined;
  readonly child: readonly string[];
} {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    if (argv.includes("--help") || argv.includes("-h")) {
      throw new CliExit(0, USAGE);
    }
    throw new CliError("usage_error", USAGE, { exitCode: 2 });
  }
  const before = argv.slice(0, separator);
  const child = argv.slice(separator + 1);
  if (child.length === 0) {
    throw new CliError("usage_error", "-- requires a child command", { exitCode: 2 });
  }
  let manifest: string | undefined;
  for (let index = 0; index < before.length; index += 1) {
    const token = before[index];
    if (token === "--manifest") {
      const value = before[index + 1];
      if (value === undefined) {
        throw new CliError("usage_error", "--manifest requires a value", { exitCode: 2 });
      }
      manifest = value;
      index += 1;
      continue;
    }
    if (token === "-h" || token === "--help") {
      throw new CliError("help_requested", USAGE, { exitCode: 0 });
    }
    throw new CliError("usage_error", `Unknown run option: ${token ?? ""}`, { exitCode: 2 });
  }
  return { manifest, child };
}

/**
 * Executes the run group.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @param argv - Arguments after `run`.
 * @returns Never; exits with the child code.
 */
export async function runCommand(
  globals: GlobalOptions,
  runtime: CliRuntime,
  argv: readonly string[],
): Promise<never> {
  const parsed = splitRunArguments(argv);
  const command = parsed.child[0];
  if (command === undefined) {
    throw new CliError("usage_error", "-- requires a child command", { exitCode: 2 });
  }
  const manifestPath = resolve(runtime.cwd, parsed.manifest ?? "openvault.run.yaml");
  const manifest = loadRunManifest(manifestPath, globals.project);
  const context = createCommandContext(globals, runtime);
  const { client } = await context.client();
  await executeRun({
    manifest,
    client,
    runtime,
    command,
    args: parsed.child.slice(1),
  });
  throw new CliError("internal_error", "run exited without a code");
}

/** A placeholder parser used only for `ov run --help`. */
function createRunParser(): CommandLineParser {
  const parser = new CommandLineParser({
    name: "ov run",
    version: "1.2.0",
    strict: true,
  });
  parser.addCommand({
    name: "run",
    description: "Run a command with delivered secrets (use -- before the command)",
    handler: () => {
      throw new CliError("usage_error", USAGE, { exitCode: 2 });
    },
  });
  return parser;
}

/** The run group definition. */
export const runGroup: CommandGroup = {
  name: "run",
  summary: "Run a command with delivered secrets",
  commands: ["run"],
  createParser: createRunParser,
};

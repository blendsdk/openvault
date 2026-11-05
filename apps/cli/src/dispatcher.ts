import { GROUPS } from "./commands/index.js";
import { runCommand } from "./commands/run.js";
import { asCliError, CliError, CliExit } from "./errors.js";
import { writeFailure } from "./output.js";
import type { CliRuntime, GlobalOptions } from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const VALUE_OPTIONS = new Set(["--project", "--org", "--ca", "--url", "--timeout"]);
const FLAG_OPTIONS = new Set(["--json", "--yes", "--verbose"]);
const SINGLE_COMMAND_GROUPS: Readonly<Record<string, string>> = {
  init: "init",
  doctor: "doctor",
  backup: "backup",
  restore: "restore",
  completion: "completion",
  kek: "rotate",
};

const POSITIONALS: Readonly<Record<string, readonly string[]>> = {
  "project create": ["name"],
  "project delete": ["name"],
  "secret set": ["name"],
  "secret get": ["name"],
  "secret versions": ["name"],
  "secret delete": ["name"],
  "secret recover": ["name"],
  "secret purge": ["name"],
  "cert import": ["name"],
  "cert generate": ["name"],
  "cert get": ["name"],
  "cert delete": ["name"],
  "identity create": ["name"],
  "identity revoke": ["name"],
  "identity join-token": ["name"],
  "role grant": ["principal", "role"],
  "role revoke": ["principal", "role"],
  "access explain": ["target"],
  "docker scaffold": ["project-name", "service"],
  "restore restore": ["archive"],
  "completion completion": ["shell"],
};

/** One extracted global option set and the remaining tokens. */
export interface GlobalExtraction {
  readonly globals: GlobalOptions;
  readonly rest: readonly string[];
}

/** Reads one option value. */
function valueAt(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError("usage_error", `${name} requires a value`, { exitCode: 2 });
  }
  return value;
}

/**
 * Extracts global options from anywhere before `--`.
 *
 * Unknown options are preserved for the group parser. `--help` and `--version`
 * are preserved so a group can render its own help.
 *
 * @param argv - Arguments after the executable.
 * @returns Global options and the remaining tokens.
 */
export function extractGlobals(argv: readonly string[]): GlobalExtraction {
  let json = false;
  let yes = false;
  let verbose = false;
  let project: string | undefined;
  let org: string | undefined;
  let ca: string | undefined;
  let url: string | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_MS / 1_000;
  const seen = new Set<string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (FLAG_OPTIONS.has(token)) {
      if (seen.has(token)) {
        throw new CliError("usage_error", `${token} was supplied more than once`, { exitCode: 2 });
      }
      seen.add(token);
      if (token === "--json") {
        json = true;
      } else if (token === "--yes") {
        yes = true;
      } else {
        verbose = true;
      }
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (VALUE_OPTIONS.has(name)) {
      if (seen.has(name)) {
        throw new CliError("usage_error", `${name} was supplied more than once`, { exitCode: 2 });
      }
      seen.add(name);
      const value = equals === -1 ? valueAt(argv, index, name) : token.slice(equals + 1);
      if (equals === -1) {
        index += 1;
      }
      if (value.length === 0) {
        throw new CliError("usage_error", `${name} requires a value`, { exitCode: 2 });
      }
      if (name === "--project") {
        project = value;
      } else if (name === "--org") {
        org = value;
      } else if (name === "--ca") {
        ca = value;
      } else if (name === "--url") {
        url = value;
      } else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
          throw new CliError("usage_error", "--timeout must be between 1 and 120 seconds", {
            exitCode: 2,
          });
        }
        timeoutSeconds = parsed;
      }
      continue;
    }
    rest.push(token);
  }
  return {
    globals: {
      json,
      yes,
      verbose,
      ...(project === undefined ? {} : { project }),
      ...(org === undefined ? {} : { org }),
      ...(ca === undefined ? {} : { ca }),
      ...(url === undefined ? {} : { url }),
      timeoutMs: timeoutSeconds * 1_000,
    },
    rest,
  };
}

/** Renders root help. */
export function rootHelp(): string {
  const lines = [
    `OpenVault CLI ${VERSION}`,
    "",
    "Usage: ov [global options] <group> <command> [options]",
    "",
    "Global options:",
    "  --json                 Machine-readable output",
    "  --yes                  Skip destructive confirmations",
    "  --verbose              Structured request events on stderr",
    "  --project <name>       Project context",
    "  --org <name>           Organization context (reserved)",
    "  --ca <path>            CA bundle for server verification",
    "  --url <url>            Server base URL for login/doctor",
    "  --timeout <seconds>    Request timeout (1-120)",
    "  -h, --help             Root or group help",
    "  --version              Print the CLI version",
    "",
    "Groups:",
  ];
  for (const group of GROUPS) {
    lines.push(`  ${group.name.padEnd(12)} ${group.summary}`);
    lines.push(`               ${group.commands.join(", ")}`);
  }
  lines.push("", "Run `ov <group> --help` for group help.");
  return `${lines.join("\n")}\n`;
}

/** Renders help for a multi-command group. */
function groupHelp(group: import("./types.js").CommandGroup): string {
  return `${group.name} — ${group.summary}\n\nCommands:\n${group.commands
    .map((command) => `  ${command}`)
    .join("\n")}\n\nRun \`ov ${group.name} <command> --help\` for command options.\n`;
}

/** Rewrites leading positional operands into canonical options. */
function applyPositionals(group: string, argv: readonly string[]): string[] {
  let args = [...argv];
  const single = SINGLE_COMMAND_GROUPS[group];
  if (single !== undefined && args[0] !== single) {
    args = [single, ...args];
  }
  const command = args[0];
  if (command === undefined) {
    return args;
  }
  const names = POSITIONALS[`${group} ${command}`];
  if (names === undefined) {
    return args;
  }
  const result = [command];
  let index = 1;
  for (const name of names) {
    const value = args[index];
    if (value === undefined || value.startsWith("-")) {
      break;
    }
    result.push(`--${name}`, value);
    index += 1;
  }
  result.push(...args.slice(index));
  return result;
}

/**
 * Dispatches one invocation.
 *
 * @param argv - Arguments after the executable.
 * @param runtime - Process boundary.
 * @returns Process exit code.
 */
export async function dispatch(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    runtime.stdout(rootHelp());
    return 0;
  }
  if (argv[0] === "--version") {
    runtime.stdout(`${VERSION}\n`);
    return 0;
  }
  let extraction: GlobalExtraction;
  try {
    extraction = extractGlobals(argv);
  } catch (error) {
    const cli = asCliError(error);
    writeFailure(
      runtime,
      {
        json: argv.includes("--json"),
        yes: false,
        verbose: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      cli,
    );
    return cli.exitCode;
  }
  const { globals } = extraction;
  const rest = extraction.rest;
  const groupName = rest[0];
  if (groupName === undefined || groupName === "--help" || groupName === "-h") {
    runtime.stdout(rootHelp());
    return 0;
  }
  if (groupName === "--version") {
    runtime.stdout(`${VERSION}\n`);
    return 0;
  }
  if (groupName.startsWith("-")) {
    if (globals.json) {
      writeFailure(
        runtime,
        globals,
        new CliError("usage_error", `Unknown global option: ${groupName}`, { exitCode: 2 }),
      );
    } else {
      runtime.stderr(`Unknown global option: ${groupName}\n${rootHelp()}`);
    }
    return 2;
  }
  const group = GROUPS.find(
    (entry) =>
      entry.name === groupName ||
      ((groupName === "login" || groupName === "logout" || groupName === "whoami") &&
        entry.name === "auth"),
  );
  if (group === undefined) {
    if (globals.json) {
      writeFailure(
        runtime,
        globals,
        new CliError("usage_error", `Unknown group: ${groupName}`, { exitCode: 2 }),
      );
    } else {
      runtime.stderr(`Unknown group: ${groupName}\n${rootHelp()}`);
    }
    return 2;
  }
  const groupArgs =
    group.name === "auth" && groupName !== "auth" ? [groupName, ...rest.slice(1)] : rest.slice(1);
  const single = SINGLE_COMMAND_GROUPS[group.name];
  if (groupArgs[0] === "--help" || groupArgs[0] === "-h") {
    if (single === undefined) {
      runtime.stdout(groupHelp(group));
      return 0;
    }
  }
  if (group.name === "run") {
    try {
      await runCommand(globals, runtime, rest.slice(1));
    } catch (error) {
      if (error instanceof CliExit) {
        if (error.output !== undefined) {
          runtime.stdout(error.output);
        }
        return error.exitCode;
      }
      const cli = asCliError(error);
      writeFailure(runtime, globals, cli);
      return cli.exitCode;
    }
  }
  const parser = group.createParser(globals, runtime);
  const mapped = applyPositionals(group.name, groupArgs);
  const output: string[] = [];
  const flush = (write: (text: string) => void): void => {
    for (const line of output) {
      write(`${line}\n`);
    }
  };
  try {
    await parser.execute(
      { globals, runtime },
      {
        argv: mapped,
        write: (line: string) => output.push(line),
      },
    );
    flush(runtime.stdout);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) {
      flush(runtime.stdout);
      if (error.output !== undefined) {
        runtime.stdout(error.output);
      }
      return error.exitCode;
    }
    const cli = asCliError(error);
    if (!globals.json) {
      flush(runtime.stderr);
    }
    writeFailure(runtime, globals, cli);
    return cli.exitCode;
  }
}

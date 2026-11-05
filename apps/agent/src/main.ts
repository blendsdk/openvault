#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { type AgentConfig, loadAgentConfig } from "./config.js";
import { AgentError, agentErrorCode } from "./errors.js";
import { createAgentLogger } from "./logger.js";
import { loadAgentManifest, type ManifestMode } from "./manifest.js";
import { AgentRunner } from "./runner.js";
import { AgentStateStore } from "./state.js";
import { readHealth } from "./status.js";

/** Parsed CLI options. */
interface ParsedOptions {
  readonly command: "run" | "health";
  readonly once: boolean;
  readonly ready: boolean;
  readonly maxAgeMs: number | undefined;
  readonly manifest: string | undefined;
  readonly outputDir: string | undefined;
  readonly stateDir: string | undefined;
  readonly statusFile: string | undefined;
  readonly socket: string | undefined;
  readonly child: { readonly command: string; readonly args: readonly string[] } | undefined;
}

const USAGE = `Usage:
  ov-agent run [options] [-- <command> [args...]]
  ov-agent health [--status-file PATH] [--ready] [--max-age SECONDS]

Options for run:
  --manifest PATH      Manifest path
  --output-dir PATH    Output directory
  --state-dir PATH     State directory
  --status-file PATH   Status file
  --socket PATH        Unix socket path
  --once               Fetch once and exit with the health code
`;

/** Reads the value following one option. */
function optionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AgentError("agent_config_invalid", `${name} requires a value`);
  }
  return value;
}

/**
 * Parses the agent command line.
 *
 * @param argv - Arguments after the executable.
 * @returns Parsed options.
 * @throws {AgentError} `agent_config_invalid` for an invalid command line.
 */
export function parseArguments(argv: readonly string[]): ParsedOptions {
  const separator = argv.indexOf("--");
  const agentArgs = separator === -1 ? argv : argv.slice(0, separator);
  const childArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const command = agentArgs[0];
  if (command !== "run" && command !== "health") {
    throw new AgentError("agent_config_invalid", USAGE);
  }
  if (command === "health" && (childArgs.length > 0 || separator !== -1)) {
    throw new AgentError("agent_config_invalid", "health does not accept a child command");
  }
  if (command === "run" && separator !== -1 && childArgs.length === 0) {
    throw new AgentError("agent_config_invalid", "-- requires a child command");
  }

  let once = false;
  let ready = false;
  let maxAgeMs: number | undefined;
  let manifest: string | undefined;
  let outputDir: string | undefined;
  let stateDir: string | undefined;
  let statusFile: string | undefined;
  let socket: string | undefined;

  for (let index = 1; index < agentArgs.length; index += 1) {
    const arg = agentArgs[index];
    switch (arg) {
      case "--once":
        once = true;
        break;
      case "--ready":
        ready = true;
        break;
      case "--manifest":
        manifest = optionValue(agentArgs, index, arg);
        index += 1;
        break;
      case "--output-dir":
        outputDir = optionValue(agentArgs, index, arg);
        index += 1;
        break;
      case "--state-dir":
        stateDir = optionValue(agentArgs, index, arg);
        index += 1;
        break;
      case "--status-file":
        statusFile = optionValue(agentArgs, index, arg);
        index += 1;
        break;
      case "--socket":
        socket = optionValue(agentArgs, index, arg);
        index += 1;
        break;
      case "--max-age": {
        const value = Number(optionValue(agentArgs, index, arg));
        if (!Number.isFinite(value) || value <= 0) {
          throw new AgentError("agent_config_invalid", "--max-age must be a positive number");
        }
        maxAgeMs = value * 1_000;
        index += 1;
        break;
      }
      default:
        throw new AgentError("agent_config_invalid", `Unknown option: ${arg}`);
    }
  }

  if (command === "health" && (once || childArgs.length > 0)) {
    throw new AgentError("agent_config_invalid", "health does not accept run options");
  }
  if (
    command === "health" &&
    (manifest !== undefined ||
      outputDir !== undefined ||
      stateDir !== undefined ||
      socket !== undefined)
  ) {
    throw new AgentError(
      "agent_config_invalid",
      "health only accepts --status-file, --ready, and --max-age",
    );
  }
  if (command === "run" && (ready || maxAgeMs !== undefined)) {
    throw new AgentError("agent_config_invalid", "health-only option used with run");
  }

  return {
    command,
    once,
    ready,
    maxAgeMs,
    manifest,
    outputDir,
    stateDir,
    statusFile,
    socket,
    child:
      childArgs.length === 0
        ? undefined
        : { command: childArgs[0] ?? "", args: childArgs.slice(1) },
  };
}

/** Applies CLI overrides to an environment copy. */
function environmentWithOverrides(
  env: NodeJS.ProcessEnv,
  options: ParsedOptions,
): NodeJS.ProcessEnv {
  const result = { ...env };
  if (options.manifest !== undefined) {
    result.OPENVAULT_MANIFEST = options.manifest;
  }
  if (options.outputDir !== undefined) {
    result.OPENVAULT_OUTPUT_DIR = options.outputDir;
  }
  if (options.stateDir !== undefined) {
    result.OPENVAULT_STATE_DIR = options.stateDir;
  }
  if (options.statusFile !== undefined) {
    result.OPENVAULT_STATUS_FILE = options.statusFile;
  }
  if (options.socket !== undefined) {
    result.OPENVAULT_SOCKET_PATH = options.socket;
  }
  return result;
}

/**
 * Runs the CLI.
 *
 * @param argv - Arguments after the executable.
 * @param env - Process environment.
 * @param output - Standard output writer.
 * @returns Process exit code.
 */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: { write(text: string): unknown } = process.stdout,
): Promise<number> {
  const logger = createAgentLogger();
  try {
    const options = parseArguments(argv);
    if (options.command === "health") {
      const statusPath =
        options.statusFile ?? env.OPENVAULT_STATUS_FILE ?? "/run/openvault/status.json";
      const health = readHealth(statusPath, {
        ready: options.ready,
        ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      });
      output.write(`${health.state}\n`);
      return health.exitCode;
    }

    const effectiveEnv = environmentWithOverrides(env, options);
    const config: AgentConfig = loadAgentConfig(effectiveEnv);
    const mode: ManifestMode = options.child === undefined ? "sidecar" : "wrapper";
    const manifest = loadAgentManifest(config.manifestPath, {
      project: config.project,
      service: config.service,
      outputDir: config.outputDir,
      mode,
    });
    const store = new AgentStateStore(config.stateDir);
    const runner = new AgentRunner({
      config,
      manifest,
      store,
      logger,
      ...(options.child === undefined ? {} : { wrapper: options.child }),
    });
    if (options.once) {
      if (options.child !== undefined) {
        throw new AgentError(
          "agent_config_invalid",
          "--once cannot be combined with a wrapper command",
        );
      }
      return await runner.runOnce();
    }
    return await runner.run();
  } catch (error) {
    logger.error("agent_start_failed", { code: agentErrorCode(error) });
    const message = error instanceof AgentError ? error.message : "Agent failed to start";
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

/* c8 ignore start -- exercised only when the bin is executed directly. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
/* c8 ignore stop */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "blendsdk/api-client";
import { CliError, CliExit } from "../errors.js";
import type { OpenVaultClient } from "../generated/index.js";
import type { CliRuntime } from "../types.js";
import type { RunManifest } from "./manifest.js";

/** Options for {@link executeRun}. */
export interface ExecuteRunOptions {
  /** Validated manifest. */
  readonly manifest: RunManifest;
  /** Authenticated client. */
  readonly client: OpenVaultClient;
  /** Process boundary. */
  readonly runtime: CliRuntime;
  /** Child executable. */
  readonly command: string;
  /** Child arguments. */
  readonly args: readonly string[];
}

/** Decodes one response value into bytes. */
function decodeValue(value: string, encoding: "utf8" | "base64"): Buffer {
  return encoding === "base64" ? Buffer.from(value, "base64") : Buffer.from(value, "utf8");
}

/** Decodes one environment value. */
function decodeEnv(bytes: Buffer): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError("validation_error", "A secret value is not valid UTF-8 for env", {
      exitCode: 2,
    });
  }
  if (value.includes("\u0000")) {
    throw new CliError("validation_error", "A secret value contains NUL for env", { exitCode: 2 });
  }
  return value;
}

/**
 * Fetches, writes, and runs one child command.
 *
 * Files live only in a private temporary directory. The environment is copied
 * from the process, with every OpenVault and Compose variable removed, then the
 * manifest `env:` values are added. The child runs with `shell: false`.
 *
 * @param options - Manifest, client, runtime, and child command.
 * @throws {CliExit} With the child's exit code.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<never> {
  const directory = mkdtempSync(join(tmpdir(), "openvault-run-"));
  chmodSync(directory, 0o700);
  let child: ReturnType<typeof spawn> | undefined;
  const environment: NodeJS.ProcessEnv = { ...options.runtime.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OPENVAULT_") || key === "COMPOSE_PROJECT_NAME") {
      delete environment[key];
    }
  }
  // The child needs one stable, value-free path to the private delivery directory.
  environment.OPENVAULT_RUN_DIR = directory;
  try {
    for (const entry of options.manifest.entries) {
      let response: { readonly value: string; readonly encoding: "utf8" | "base64" };
      try {
        response = await options.client.secrets.getSecret({
          project: options.manifest.project,
          name: entry.name,
        });
      } catch (error) {
        if (entry.optional) {
          const code = error instanceof ApiError ? error.code : "request_failed";
          options.runtime.stderr(
            `warning: optional secret ${entry.name} is unavailable (${code})\n`,
          );
          continue;
        }
        if (error instanceof ApiError && error.statusCode === 404) {
          throw new CliError("secret_not_found", `Secret ${entry.name} was not found`, {
            exitCode: 1,
          });
        }
        throw error;
      }
      const bytes = decodeValue(response.value, response.encoding);
      for (const target of entry.targets) {
        if (target.kind === "file") {
          const path = join(directory, target.name);
          writeFileSync(path, bytes, { mode: target.mode, flag: "wx" });
          chmodSync(path, target.mode);
        } else {
          environment[target.name] = decodeEnv(bytes);
        }
      }
    }
    child = spawn(options.command, [...options.args], {
      env: environment,
      cwd: options.runtime.cwd,
      stdio: "inherit",
      shell: false,
    });
    const running = child;
    let killTimer: NodeJS.Timeout | undefined;
    let terminating = false;
    const forward = (signal: NodeJS.Signals): void => {
      if (running.exitCode !== null || running.signalCode !== null) {
        return;
      }
      running.kill(signal);
      if (!terminating) {
        terminating = true;
        killTimer = setTimeout(() => {
          if (running.exitCode === null && running.signalCode === null) {
            running.kill("SIGKILL");
          }
        }, 5_000);
        killTimer.unref();
      }
    };
    const onInt = (): void => forward("SIGINT");
    const onTerm = (): void => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    let code: number;
    try {
      code = await new Promise<number>((resolve, reject) => {
        running.once("error", (error) => {
          reject(
            new CliError("internal_error", "The child command could not start", { cause: error }),
          );
        });
        running.once("exit", (exitCode, signal) => {
          resolve(signal === null ? (exitCode ?? 1) : 1);
        });
      });
    } finally {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
    throw new CliExit(code);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

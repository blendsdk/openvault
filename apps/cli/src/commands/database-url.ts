import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CliError } from "../errors.js";
import type { CliRuntime } from "../types.js";

/** Reads a non-empty environment value after trimming. */
function envValue(runtime: CliRuntime, name: string): string | undefined {
  const value = runtime.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Resolves a database URL from `NAME` or `NAME_FILE`.
 *
 * `NAME_FILE` supports Docker secrets: the file may be mode `0444`, but it must
 * be a regular file and must not be group- or world-writable. Supplying both
 * forms is an error so an operator cannot silently override the secret.
 *
 * @param runtime - Process boundary.
 * @param name - Environment variable name, for example `OPENVAULT_DB_URL`.
 * @param required - Whether absence is an error.
 * @returns The trimmed URL, or undefined when optional and absent.
 */
export function databaseUrlFromEnv(runtime: CliRuntime): string;
export function databaseUrlFromEnv(runtime: CliRuntime, name: string): string;
export function databaseUrlFromEnv(
  runtime: CliRuntime,
  name: string,
  required: false,
): string | undefined;
export function databaseUrlFromEnv(
  runtime: CliRuntime,
  name = "OPENVAULT_DB_URL",
  required = true,
): string | undefined {
  const direct = envValue(runtime, name);
  const fileKey = `${name}_FILE`;
  const file = envValue(runtime, fileKey);
  if (direct !== undefined && file !== undefined) {
    throw new CliError("usage_error", `${name} and ${fileKey} cannot both be set`, {
      exitCode: 2,
    });
  }
  if (direct !== undefined) {
    return direct;
  }
  if (file === undefined) {
    if (required) {
      throw new CliError("usage_error", `${name} or ${fileKey} is required in the environment`, {
        exitCode: 2,
      });
    }
    return undefined;
  }
  const path = isAbsolute(file) ? file : resolve(runtime.cwd, file);
  let mode: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new Error("not a file");
    }
    mode = stats.mode & 0o777;
  } catch {
    throw new CliError("usage_error", `${fileKey} must reference a readable regular file`, {
      exitCode: 2,
    });
  }
  if ((mode & 0o022) !== 0) {
    throw new CliError("usage_error", `${fileKey} must not be group- or world-writable`, {
      exitCode: 2,
    });
  }
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new CliError("usage_error", `${fileKey} must be readable`, { exitCode: 2 });
  }
  if (value.length === 0) {
    throw new CliError("usage_error", `${fileKey} must not be empty`, { exitCode: 2 });
  }
  return value;
}

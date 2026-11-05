import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CliError } from "../errors.js";

/** Returns `lstat` or undefined when absent. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new CliError("file_exists", "The output path could not be inspected");
  }
}

/**
 * Writes one private output file atomically.
 *
 * @param path - Final path.
 * @param data - Bytes to write.
 * @param options - Overwrite policy.
 */
export function writeOutputFile(
  path: string,
  data: Buffer,
  options: { readonly force: boolean; readonly mode?: 0o600 | 0o644 },
): void {
  const target = resolve(path);
  const existing = lstatIfExists(target);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new CliError("file_exists", "The output path must be a regular file");
    }
    if (!options.force) {
      throw new CliError("file_exists", "The output file already exists; use --force");
    }
  }
  const temporary = resolve(
    dirname(target),
    `.openvault-out-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", options.mode ?? 0o600);
    writeSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    rmSync(temporary, { force: true });
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("internal_error", "The output file could not be written", { cause: error });
  }
}

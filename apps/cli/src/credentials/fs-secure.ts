import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { CliError } from "../errors.js";

/** Returns the current numeric uid when the platform exposes one. */
export function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Ensures one private directory exists with the expected owner and mode. */
export function ensureSecureDirectory(path: string): void {
  let stat = lstatIfExists(path);
  if (stat === undefined) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      throw new CliError(
        "credential_store_unavailable",
        "The credential directory could not be created",
      );
    }
    stat = lstatIfExists(path);
  }
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError(
      "credential_store_insecure",
      "The credential directory must be a real directory",
    );
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new CliError(
      "credential_store_insecure",
      "The credential directory must be owned by the current user",
    );
  }
  if ((Number(stat.mode) & 0o777) !== 0o700) {
    throw new CliError("credential_store_insecure", "The credential directory mode must be 0700");
  }
}

/** Returns `lstat` or undefined when the path does not exist. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new CliError(
      "credential_store_unavailable",
      "The credential path could not be inspected",
    );
  }
}

/** Flushes one directory entry after a rename. */
function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Best effort; the file itself is already durable.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/**
 * Writes one private file atomically.
 *
 * @param path - Final path.
 * @param data - Complete file contents.
 * @param mode - Final mode; credentials use `0600`.
 */
export function writeFileAtomic(path: string, data: string, mode: 0o600): void {
  const directory = dirname(path);
  ensureSecureDirectory(directory);
  const temporary = resolve(directory, `.credentials-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, data, "utf8");
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original failure.
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("credential_store_unavailable", "The credential file could not be written", {
      cause: error,
    });
  }
}

/**
 * Reads one private file without following symlinks.
 *
 * @param path - Absolute path.
 * @returns The bytes, or undefined when absent.
 */
export function readPrivateFile(path: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new CliError("credential_store_insecure", "The credential file must not be a symlink", {
      cause: error,
    });
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new CliError("credential_store_insecure", "The credential path must be a regular file");
    }
    const uid = currentUid();
    if (uid !== undefined && stat.uid !== uid) {
      throw new CliError(
        "credential_store_insecure",
        "The credential file must be owned by the current user",
      );
    }
    if ((Number(stat.mode) & 0o777) !== 0o600) {
      throw new CliError("credential_store_insecure", "The credential file mode must be 0600");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Removes one file if present. */
export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    throw new CliError("credential_store_unavailable", "The credential file could not be removed");
  }
}

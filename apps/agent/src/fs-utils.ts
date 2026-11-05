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
import { AgentError } from "./errors.js";

/** Returns the current numeric uid when the platform exposes one. */
export function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Creates or validates a private directory.
 *
 * The directory must be a real directory, not a symlink, owned by the current
 * user where the platform exposes a uid, and exactly mode `0700`.
 *
 * @param path - Absolute directory path.
 * @param code - Error code to use on failure.
 * @returns The same path.
 * @throws {AgentError} When the directory is missing and cannot be created, or is insecure.
 */
export function ensureSecureDirectory(
  path: string,
  code: "agent_state_insecure" | "agent_config_invalid" = "agent_state_insecure",
): string {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new AgentError(code, "Directory could not be created");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new AgentError(code, "Directory could not be inspected");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentError(code, "Path must be a real directory, not a symlink");
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new AgentError(code, "Directory must be owned by the current user");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new AgentError(code, "Directory mode must be 0700");
  }
  return path;
}

/** Resolves a safe file name below one root. */
export function safePath(root: string, name: string): string {
  const path = resolve(root, name);
  if (dirname(path) !== resolve(root)) {
    throw new AgentError("agent_manifest_invalid", "File target escapes the output directory");
  }
  return path;
}

/** One staged temporary file. */
export interface StagedFile {
  /** Temporary path in the target directory. */
  readonly temporary: string;
  /** Final target path. */
  readonly target: string;
}

/**
 * Stages one file without touching the target.
 *
 * @param path - Final target path.
 * @param data - Bytes to write.
 * @param mode - Final mode applied to the temporary file.
 * @returns The staged descriptor.
 */
export function stageFile(path: string, data: Buffer | string, mode: number): StagedFile {
  const temporary = resolve(dirname(path), `.openvault-${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return { temporary, target: path };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw new AgentError("agent_state_write_failed", "File staging failed", { cause: error });
  }
}

/** Removes staged temporary files. */
export function abortStaged(files: readonly StagedFile[]): void {
  for (const file of files) {
    try {
      rmSync(file.temporary, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
  }
}

/** Commits every staged file in order and flushes each directory. */
export function commitStaged(files: readonly StagedFile[]): void {
  const directories = new Set<string>();
  try {
    for (const file of files) {
      renameSync(file.temporary, file.target);
      directories.add(dirname(file.target));
    }
  } finally {
    for (const directory of directories) {
      fsyncDirectory(directory);
    }
  }
}

/** Flushes a directory entry after a rename. */
function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fsyncSync(fd);
  } catch {
    // A best-effort directory flush. The file itself is already durable.
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Atomically writes one file with a final mode.
 *
 * The temporary file is created mode `0600` in the same directory, written,
 * `fchmod`ed, `fsync`ed, and renamed over the target. A failure before the
 * rename leaves the previous target untouched; a failure after the rename
 * leaves the new complete file in place.
 *
 * @param path - Absolute target path.
 * @param data - Bytes to write.
 * @param mode - Final file mode.
 * @throws {AgentError} `agent_state_write_failed` on any filesystem failure.
 */
export function atomicWriteFile(path: string, data: Buffer | string, mode: number): void {
  const directory = dirname(path);
  const temporary = resolve(directory, `.openvault-${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore a close failure while reporting the original error.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Ignore cleanup failure; the temporary name is not a managed artifact.
    }
    throw new AgentError("agent_state_write_failed", "File write failed", { cause: error });
  }
}

/**
 * Reads a regular file without following symlinks.
 *
 * @param path - Absolute path.
 * @returns The file bytes, or undefined when the file does not exist.
 * @throws {AgentError} When the path is a symlink, a non-regular file, or unreadable.
 */
export function readRegularFile(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new AgentError("agent_state_insecure", "State file could not be opened", {
      cause: error,
    });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new AgentError("agent_state_insecure", "State path must be a regular file");
    }
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof AgentError) {
      throw error;
    }
    throw new AgentError("agent_state_insecure", "State file could not be read", { cause: error });
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes a file if it exists.
 *
 * @param path - Absolute path.
 */
export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    throw new AgentError("agent_state_write_failed", "Managed file could not be removed");
  }
}

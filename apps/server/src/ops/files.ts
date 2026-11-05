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
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { OpsError } from "./errors.js";

/** Maximum accepted backup passphrase file size. */
const MAX_PASSPHRASE_BYTES = 4_096;

/** Returns `lstat` or undefined when absent. */
export function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new OpsError("ops_configuration", "The operations path could not be inspected", {
      cause: error,
    });
  }
}

/** Ensures one directory is private enough for key material. */
export function ensurePrivateDirectory(path: string): void {
  const existing = lstatIfExists(path);
  if (existing === undefined) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new OpsError("ops_configuration", "The operations directory could not be created", {
        cause: error,
      });
    }
    return;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new OpsError("ops_configuration", "The operations directory must be a real directory");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && existing.uid !== uid) {
    throw new OpsError(
      "ops_configuration",
      "The operations directory must be owned by the current user",
    );
  }
  if ((Number(existing.mode) & 0o022) !== 0) {
    throw new OpsError(
      "ops_configuration",
      "The operations directory must not be group- or world-writable",
    );
  }
}

/** Best-effort directory fsync after a rename. */
function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // The rename is durable on most filesystems; this is best effort.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Writes one private file atomically. */
export function writePrivateFileAtomic(
  path: string,
  data: Buffer,
  mode: 0o600 | 0o644 = 0o600,
): void {
  const directory = dirname(resolve(path));
  ensurePrivateDirectory(directory);
  const temporary = resolve(directory, `.openvault-ops-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(descriptor, data, offset, data.length - offset);
      if (written <= 0) {
        throw new Error("short write");
      }
      offset += written;
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const target = resolve(path);
    renameSync(temporary, target);
    fsyncDirectory(dirname(target));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    rmSync(temporary, { force: true });
    throw new OpsError("ops_configuration", "The operations file could not be written", {
      cause: error,
    });
  }
}

/** Reads one regular file through an open descriptor with a hard bound. */
export function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  mode: 0o600 | 0o644,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new OpsError("ops_configuration", "The operations path must be a regular file");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new OpsError(
        "ops_configuration",
        "The operations file must be owned by the current user",
      );
    }
    if ((Number(stat.mode) & 0o777) !== mode) {
      throw new OpsError(
        "ops_configuration",
        `The operations file mode must be 0${mode.toString(8)}`,
      );
    }
    if (stat.size === 0 || stat.size > maxBytes) {
      throw new OpsError("ops_configuration", "The operations file size is invalid");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(65_536);
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        throw new OpsError("ops_configuration", "The operations file is too large");
      }
      const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytes === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
      total += bytes;
    }
    if (total > maxBytes) {
      throw new OpsError("ops_configuration", "The operations file is too large");
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError("ops_configuration", "The operations file could not be read", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
  }
}

/** Reads one 0600 passphrase file and trims one trailing newline. */
export function readPassphraseFile(path: string): string {
  const value = readBoundedRegularFile(path, MAX_PASSPHRASE_BYTES, 0o600)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (value.length < 12) {
    throw new OpsError("ops_configuration", "The backup passphrase must be at least 12 characters");
  }
  return value;
}

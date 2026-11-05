import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "../errors.js";
import { ensureSecureDirectory } from "./fs-secure.js";

/** Lock wait before a clear failure. */
const LOCK_TIMEOUT_MS = 5_000;
/** A dead lock is only reclaimed after this age. */
const STALE_AFTER_MS = 60_000;

interface LockDocument {
  readonly pid: number;
  readonly createdAt: string;
  readonly owner: string;
}

/** Returns true when a process id is alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH");
  }
}

/** Reads a lock document, or undefined when unreadable. */
function readLock(path: string): LockDocument | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const pid = Reflect.get(parsed, "pid");
    const createdAt = Reflect.get(parsed, "createdAt");
    const owner = Reflect.get(parsed, "owner");
    if (typeof pid !== "number" || typeof createdAt !== "string" || typeof owner !== "string") {
      return undefined;
    }
    return { pid, createdAt, owner };
  } catch {
    return undefined;
  }
}

/** One observed lock inode. */
interface LockIdentity {
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
}

/** Returns the lock inode, or undefined when absent. */
function lockIdentity(path: string): LockIdentity | undefined {
  try {
    const stat = lstatSync(path);
    return { device: stat.dev, inode: stat.ino, modifiedMs: stat.mtimeMs };
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

/** Returns true when a lock is stale. */
function isStale(
  lock: LockDocument | undefined,
  identity: LockIdentity | undefined,
  now: number,
): boolean {
  if (lock !== undefined) {
    const created = Date.parse(lock.createdAt);
    if (!Number.isFinite(created)) {
      return identity !== undefined && now - identity.modifiedMs >= STALE_AFTER_MS;
    }
    return !processAlive(lock.pid) && now - created >= STALE_AFTER_MS;
  }
  // An unparseable lock is recoverable only after the stale window, so a
  // process that has just created the file but not yet written it is safe.
  return identity !== undefined && now - identity.modifiedMs >= STALE_AFTER_MS;
}

/**
 * Runs one action while holding `credentials.lock`.
 *
 * The lock file is `0600` and carries a random owner token. A stale lock is
 * reclaimed only when its PID is dead and it is older than 60 seconds; cleanup
 * is serialized by a directory guard so a live lock is never moved.
 *
 * @param lockPath - Absolute lock path.
 * @param action - Critical section.
 * @returns The action result.
 * @throws {CliError} `credential_store_locked` on timeout.
 */
export async function withFileLock<T>(lockPath: string, action: () => Promise<T> | T): Promise<T> {
  ensureSecureDirectory(dirname(lockPath));
  const owner = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      created = true;
      try {
        writeFileSync(
          descriptor,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner }),
          "utf8",
        );
      } finally {
        closeSync(descriptor);
        descriptor = undefined;
      }
      acquired = true;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original failure.
        }
      }
      if (created) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Preserve the original failure.
        }
      }
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "EEXIST") {
        throw new CliError(
          "credential_store_unavailable",
          "The credential lock could not be created",
        );
      }
      const observed = lockIdentity(lockPath);
      const current = readLock(lockPath);
      if (isStale(current, observed, Date.now())) {
        // Serialize stale cleanup with a directory guard. While the stale lock
        // exists no process can create a replacement, so the re-check below is
        // safe: a live lock is never renamed or unlinked.
        const guard = `${lockPath}.reclaim`;
        let guarded = false;
        while (!guarded) {
          try {
            mkdirSync(guard, { mode: 0o700 });
            guarded = true;
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              Reflect.get(error, "code") !== "EEXIST"
            ) {
              throw new CliError(
                "credential_store_unavailable",
                "The credential lock cleanup guard could not be created",
              );
            }
            if (Date.now() >= deadline) {
              throw new CliError(
                "credential_store_locked",
                `A stale credential-lock cleanup is in progress; remove ${guard} if no ov process is running`,
              );
            }
            await delay(20 + Math.floor(Math.random() * 30));
          }
        }
        try {
          const rechecked = readLock(lockPath);
          const recheckedIdentity = lockIdentity(lockPath);
          if (isStale(rechecked, recheckedIdentity, Date.now())) {
            rmSync(lockPath, { force: true });
          }
        } finally {
          if (guarded) {
            rmSync(guard, { recursive: true, force: true });
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          "credential_store_locked",
          "The credential file is locked by another ov process",
        );
      }
      await delay(50 + Math.floor(Math.random() * 150));
    }
  }
  try {
    return await action();
  } finally {
    const current = readLock(lockPath);
    if (current?.owner === owner) {
      rmSync(lockPath, { force: true });
    }
  }
}

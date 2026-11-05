import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { InitError } from "./errors.js";

const LOCK_TIMEOUT_MS = 60_000;
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

/** Reads one lock document, or undefined. */
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

/** Returns the lock inode, or undefined. */
function lockIdentity(path: string): LockIdentity | undefined {
  try {
    const stat = lstatSync(path);
    return { device: stat.dev, inode: stat.ino, modifiedMs: stat.mtimeMs };
  } catch {
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
  return identity !== undefined && now - identity.modifiedMs >= STALE_AFTER_MS;
}

/** Runs one action under the bootstrap file lock. */
export async function withInitLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
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
        rmSync(lockPath, { force: true });
      }
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "EEXIST") {
        throw new InitError("init_insecure", "The bootstrap lock could not be created");
      }
      const observed = lockIdentity(lockPath);
      const current = readLock(lockPath);
      if (isStale(current, observed, Date.now())) {
        const stale = `${lockPath}.stale-${owner}`;
        try {
          renameSync(lockPath, stale);
          const moved = lockIdentity(stale);
          if (
            observed !== undefined &&
            moved !== undefined &&
            moved.device === observed.device &&
            moved.inode === observed.inode
          ) {
            rmSync(stale, { force: true });
            continue;
          }
          try {
            linkSync(stale, lockPath);
            rmSync(stale, { force: true });
          } catch {
            // A newer lock already appeared; leave the moved file in place.
          }
        } catch {
          // Another process won the takeover.
        }
      }
      if (Date.now() >= deadline) {
        throw new InitError("init_insecure", "Another init process holds the bootstrap lock");
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

/** Fixed advisory-lock key for database bootstrap. */
const INIT_ADVISORY_LOCK = 783_927_465;

/**
 * Runs one action under a PostgreSQL advisory lock.
 *
 * The file lock serializes processes on one host; this lock also serializes
 * bootstrap across hosts that share the same database. Only lock acquisition
 * and release failures are wrapped; action errors propagate unchanged so a
 * keyring, CA, or TLS failure keeps its own code.
 *
 * @param databaseUrl - Application database URL.
 * @param action - Bootstrap action.
 * @returns The action result.
 */
export async function withInitDatabaseLock<T>(
  databaseUrl: string,
  action: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new InitError("init_database", "The bootstrap database lock could not connect", {
      cause: error,
    });
  }
  try {
    try {
      await client.query("SELECT pg_advisory_lock($1)", [INIT_ADVISORY_LOCK]);
    } catch (error) {
      throw new InitError("init_database", "The bootstrap database lock could not be acquired", {
        cause: error,
      });
    }
    try {
      return await action();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [INIT_ADVISORY_LOCK]);
      } catch {
        // The connection may already be closed; the lock is released with it.
      }
    }
  } finally {
    await client.end();
  }
}

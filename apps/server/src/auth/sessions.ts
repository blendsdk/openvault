import { createHash, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { CacheProvider } from "blendsdk/webafx-cache";
import type { OpenVaultConfig } from "../config/index.js";
import type { AuthMethod, SessionRecord } from "./types.js";

export type { SessionRecord } from "./types.js";

const SECRET_BYTES = 32;
const CSRF_BYTES = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_KEY_PREFIX = "session:";
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const ROTATION_RECEIPT_MS = 10_000;

/** Options for {@link SessionService}. */
export interface SessionServiceOptions {
  /** Validated runtime configuration; `sessionTtlHours` sets the absolute lifetime. */
  readonly config: OpenVaultConfig;
  /** Cache provider that stores session records under `session:<sha256>`. */
  readonly cache: CacheProvider;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Index sweeper interval in milliseconds; `0` disables the sweeper. */
  readonly sweepIntervalMs?: number;
}

/** A created or rotated session and the secret cookie value. */
export interface IssuedSession {
  /** The 32-byte secret cookie value. */
  readonly secretId: string;
  /** The stored session record. */
  readonly record: SessionRecord;
}

/**
 * Stores opaque browser sessions in an in-memory cache.
 *
 * The cache key is the SHA-256 hash of the secret cookie value; the session
 * cache never stores the raw cookie secret. A small in-process index supports
 * listing and revocation without scanning the cache, which has no enumeration
 * API. A completed rotation is remembered for ten seconds so a concurrent or
 * retried refresh receives the same new secret; the old secret never resolves
 * through {@link get}, and the receipt is dropped on revoke, supersession, or
 * expiry.
 */
export class SessionService {
  readonly #cache: CacheProvider;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #principalIndex = new Map<string, Set<string>>();
  readonly #publicIndex = new Map<
    string,
    { secretHash: string; principalId: string; expiresAt: number }
  >();
  readonly #rotations = new Map<string, Promise<IssuedSession | undefined>>();
  readonly #rotationReceipts = new Map<
    string,
    {
      result: IssuedSession;
      publicId: string;
      secretHash: string;
      expiresAt: number;
    }
  >();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #sweeper: ReturnType<typeof setInterval> | undefined;

  /**
   * Creates the service and starts the optional index sweeper.
   *
   * @param options - Cache, clock, and lifetime settings.
   */
  public constructor(options: SessionServiceOptions) {
    this.#cache = options.cache;
    this.#ttlMs = options.config.sessionTtlHours * 3_600_000;
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

    if (sweepIntervalMs > 0) {
      this.#sweeper = setInterval(() => {
        this.#sweep();
      }, sweepIntervalMs);
      this.#sweeper.unref?.();
    }
  }

  /**
   * Creates a new session.
   *
   * @param input - Principal id and authentication method.
   * @returns The secret cookie value and the stored record.
   */
  public async create(input: {
    readonly principalId: string;
    readonly authMethod: AuthMethod;
  }): Promise<IssuedSession> {
    const secretId = randomBytes(SECRET_BYTES).toString("base64url");
    const record = this.#newRecord(input.principalId, input.authMethod);
    await this.#store(secretId, record);
    return { secretId, record };
  }

  /**
   * Resolves a session by its secret cookie value.
   *
   * A malformed value returns `undefined` without touching the cache. An
   * expired record is deleted before returning `undefined`.
   *
   * @param secretId - Secret cookie value.
   * @returns The live record, or `undefined`.
   */
  public async get(secretId: string): Promise<SessionRecord | undefined> {
    if (!isSecretId(secretId)) {
      return undefined;
    }
    return this.#read(secretId);
  }

  /**
   * Rotates the secret and CSRF token while preserving the public identity and
   * absolute expiry.
   *
   * Concurrent rotations for the same old secret share one result. A result is
   * remembered for ten seconds so a request that arrives after the first
   * rotation commits still receives the same new secret. The receipt is
   * returned only while its new secret is the session's current key; a
   * revoked, superseded, or expired session yields `undefined`.
   *
   * @param secretId - Current secret cookie value.
   * @returns The new secret and record, or `undefined` when the session is gone.
   */
  public rotate(secretId: string): Promise<IssuedSession | undefined> {
    if (!isSecretId(secretId)) {
      return Promise.resolve(undefined);
    }

    const oldHash = hashSecret(secretId);
    const inFlight = this.#rotations.get(oldHash);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const receipt = this.#liveReceipt(oldHash);
    if (receipt !== undefined) {
      return Promise.resolve(receipt.result);
    }

    const rotation = this.#rotate(secretId, oldHash).finally(() => {
      this.#rotations.delete(oldHash);
    });
    this.#rotations.set(oldHash, rotation);
    return rotation;
  }

  /**
   * Rotates the current secret for a public session id without a receipt.
   *
   * Password change uses this instead of {@link rotate}: if another request
   * refreshed the same session concurrently, this method rotates the newest
   * live secret and deletes it, so a pre-change cookie holder cannot follow the
   * rotation. The result is never cached as a receipt.
   *
   * @param publicId - Public session identifier.
   * @param principalId - Principal that must own the session.
   * @returns The new secret and record, or `undefined` when the session is gone.
   */
  public rotateCurrent(publicId: string, principalId: string): Promise<IssuedSession | undefined> {
    return this.#withLock(publicId, async () => {
      const entry = this.#publicIndex.get(publicId);
      if (
        entry === undefined ||
        entry.principalId !== principalId ||
        entry.expiresAt <= this.#now()
      ) {
        return undefined;
      }

      const record = await this.#cache.get<SessionRecord>(
        `${SESSION_KEY_PREFIX}${entry.secretHash}`,
      );
      if (record === undefined) {
        this.#removeIndex(publicId);
        return undefined;
      }

      const secretIdNext = randomBytes(SECRET_BYTES).toString("base64url");
      const rotated: SessionRecord = {
        ...record,
        csrfToken: randomBytes(CSRF_BYTES).toString("base64url"),
      };
      await this.#store(secretIdNext, rotated);
      await this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`);
      return { secretId: secretIdNext, record: rotated };
    });
  }

  /**
   * Removes any rotation receipt for an old secret.
   *
   * Password change uses this after rotating so the pre-change cookie cannot
   * obtain the post-change secret through a late refresh.
   *
   * @param secretId - Old secret cookie value.
   */
  public clearRotationReceipt(secretId: string): void {
    if (isSecretId(secretId)) {
      this.#rotationReceipts.delete(hashSecret(secretId));
    }
  }

  /**
   * Reports whether an old secret has a live rotation receipt.
   *
   * The session middleware uses this to avoid clearing a cookie that a
   * concurrent refresh has just rotated. The old secret still never resolves
   * through {@link get}; only {@link rotate} can use the receipt.
   *
   * @param secretId - Old secret cookie value.
   * @returns True when a valid, unexpired receipt exists.
   */
  public hasRecentRotation(secretId: string): boolean {
    if (!isSecretId(secretId)) {
      return false;
    }
    return this.#liveReceipt(hashSecret(secretId)) !== undefined;
  }

  /**
   * Reports whether a public session id still belongs to a live session.
   *
   * The check uses the in-process index and the absolute expiry; it does not
   * read the cache value. The session middleware already resolved the value.
   *
   * @param publicId - Public session identifier.
   * @param principalId - Principal that must own the session.
   * @returns True when the session is live and owned by the principal.
   */
  public has(publicId: string, principalId: string): boolean {
    const entry = this.#publicIndex.get(publicId);
    return (
      entry !== undefined && entry.principalId === principalId && entry.expiresAt > this.#now()
    );
  }

  /**
   * Remaining cookie lifetime in seconds for a record.
   *
   * @param record - Session record.
   * @returns Seconds until the absolute expiry, never negative.
   */
  public remainingSeconds(record: SessionRecord): number {
    return Math.max(0, Math.ceil((record.expiresAt - this.#now()) / 1_000));
  }

  /**
   * Revokes one session owned by the principal.
   *
   * @param publicId - Public session identifier.
   * @param principalId - Principal that must own the session.
   * @returns True when a session was removed.
   */
  public async revoke(publicId: string, principalId: string): Promise<boolean> {
    const entry = this.#publicIndex.get(publicId);
    if (entry === undefined || entry.principalId !== principalId) {
      return false;
    }

    return this.#withLock(publicId, async () => {
      const latest = this.#publicIndex.get(publicId);
      if (latest === undefined || latest.principalId !== principalId) {
        return false;
      }
      await this.#cache.delete(`${SESSION_KEY_PREFIX}${latest.secretHash}`);
      this.#removeIndex(publicId);
      return true;
    });
  }

  /**
   * Revokes every session owned by the principal.
   *
   * @param principalId - Principal whose sessions should be removed.
   * @returns The number of sessions removed.
   */
  public async revokeAllForPrincipal(principalId: string): Promise<number> {
    const publicIds = this.#principalIndex.get(principalId);
    if (publicIds === undefined) {
      return 0;
    }

    let removed = 0;
    for (const publicId of [...publicIds]) {
      if (await this.revoke(publicId, principalId)) {
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Lists the principal's live sessions, oldest first.
   *
   * Expired entries are removed from the index during the scan. The returned
   * records never contain the secret cookie value.
   *
   * @param principalId - Principal whose sessions should be listed.
   * @returns Live session records.
   */
  public async list(principalId: string): Promise<SessionRecord[]> {
    const publicIds = this.#principalIndex.get(principalId);
    if (publicIds === undefined) {
      return [];
    }

    const now = this.#now();
    const records: SessionRecord[] = [];
    for (const publicId of [...publicIds]) {
      const entry = this.#publicIndex.get(publicId);
      if (entry === undefined) {
        publicIds.delete(publicId);
        continue;
      }
      if (entry.expiresAt <= now) {
        await this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`);
        this.#removeIndex(publicId);
        continue;
      }

      const record = await this.#cache.get<SessionRecord>(
        `${SESSION_KEY_PREFIX}${entry.secretHash}`,
      );
      if (record === undefined) {
        const latest = this.#publicIndex.get(publicId);
        if (latest === undefined || latest.secretHash === entry.secretHash) {
          this.#removeIndex(publicId);
        }
        continue;
      }
      records.push(record);
    }

    records.sort((left, right) => left.createdAt - right.createdAt);
    return records;
  }

  /** Stops the sweeper and shuts down the cache owned by this service. */
  public async destroy(): Promise<void> {
    if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper);
    }
    this.#principalIndex.clear();
    this.#publicIndex.clear();
    this.#rotations.clear();
    this.#rotationReceipts.clear();
    this.#locks.clear();
    await this.#cache.shutdown();
  }

  #liveReceipt(oldHash: string):
    | {
        result: IssuedSession;
        publicId: string;
        secretHash: string;
        expiresAt: number;
      }
    | undefined {
    const receipt = this.#rotationReceipts.get(oldHash);
    if (receipt === undefined) {
      return undefined;
    }

    const current = this.#publicIndex.get(receipt.publicId);
    const live =
      receipt.expiresAt > this.#now() &&
      current !== undefined &&
      current.secretHash === receipt.secretHash &&
      current.expiresAt > this.#now();
    if (live) {
      return receipt;
    }

    this.#rotationReceipts.delete(oldHash);
    return undefined;
  }

  async #rotate(secretId: string, oldHash: string): Promise<IssuedSession | undefined> {
    const initial = await this.#read(secretId);
    if (initial === undefined) {
      return undefined;
    }

    return this.#withLock(initial.publicId, async () => {
      const record = await this.#read(secretId);
      if (record === undefined) {
        return undefined;
      }

      const secretIdNext = randomBytes(SECRET_BYTES).toString("base64url");
      const rotated: SessionRecord = {
        ...record,
        csrfToken: randomBytes(CSRF_BYTES).toString("base64url"),
      };

      await this.#store(secretIdNext, rotated);
      await this.#cache.delete(`${SESSION_KEY_PREFIX}${oldHash}`);
      const result = { secretId: secretIdNext, record: rotated };
      this.#rotationReceipts.set(oldHash, {
        result,
        publicId: rotated.publicId,
        secretHash: hashSecret(secretIdNext),
        expiresAt: this.#now() + ROTATION_RECEIPT_MS,
      });
      return result;
    });
  }

  async #read(secretId: string): Promise<SessionRecord | undefined> {
    const key = `${SESSION_KEY_PREFIX}${hashSecret(secretId)}`;
    const record = await this.#cache.get<SessionRecord>(key);
    if (record === undefined) {
      return undefined;
    }

    if (record.expiresAt <= this.#now()) {
      await this.#cache.delete(key);
      this.#removeIndex(record.publicId);
      return undefined;
    }
    return record;
  }

  async #store(secretId: string, record: SessionRecord): Promise<void> {
    const secretHash = hashSecret(secretId);
    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - this.#now()) / 1_000));
    await this.#cache.set(`${SESSION_KEY_PREFIX}${secretHash}`, record, ttlSeconds);

    const existing = this.#publicIndex.get(record.publicId);
    if (existing !== undefined && existing.secretHash !== secretHash) {
      await this.#cache.delete(`${SESSION_KEY_PREFIX}${existing.secretHash}`);
    }

    this.#publicIndex.set(record.publicId, {
      secretHash,
      principalId: record.principalId,
      expiresAt: record.expiresAt,
    });
    let principalSessions = this.#principalIndex.get(record.principalId);
    if (principalSessions === undefined) {
      principalSessions = new Set();
      this.#principalIndex.set(record.principalId, principalSessions);
    }
    principalSessions.add(record.publicId);
  }

  #newRecord(principalId: string, authMethod: AuthMethod): SessionRecord {
    const createdAt = this.#now();
    return {
      publicId: newUlid(createdAt),
      principalId,
      csrfToken: randomBytes(CSRF_BYTES).toString("base64url"),
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      authMethod,
    };
  }

  #removeIndex(publicId: string): void {
    const entry = this.#publicIndex.get(publicId);
    this.#publicIndex.delete(publicId);
    if (entry !== undefined) {
      const principalSessions = this.#principalIndex.get(entry.principalId);
      principalSessions?.delete(publicId);
      if (principalSessions !== undefined && principalSessions.size === 0) {
        this.#principalIndex.delete(entry.principalId);
      }
    }
    for (const [hash, receipt] of this.#rotationReceipts) {
      if (receipt.publicId === publicId) {
        this.#rotationReceipts.delete(hash);
      }
    }
  }

  /**
   * Runs one mutation at a time for a public session id.
   *
   * The lock is a promise chain: a caller waits for the previous action to
   * release, then runs its own action. `finally` releases even when the action
   * throws. The methods that use it (`rotate` and `revoke`) never call each
   * other while holding it, so the chain cannot deadlock.
   */
  async #withLock<T>(publicId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(publicId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(publicId, queued);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#locks.get(publicId) === queued) {
        this.#locks.delete(publicId);
      }
    }
  }

  #sweep(): void {
    const now = this.#now();
    for (const [publicId, entry] of this.#publicIndex) {
      if (entry.expiresAt <= now) {
        void this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`).catch(() => undefined);
        this.#removeIndex(publicId);
      }
    }
    for (const [hash, receipt] of this.#rotationReceipts) {
      if (receipt.expiresAt <= now) {
        this.#rotationReceipts.delete(hash);
      }
    }
  }
}

function isSecretId(value: string): boolean {
  return SECRET_PATTERN.test(value) && Buffer.from(value, "base64url").length === SECRET_BYTES;
}

function hashSecret(secretId: string): string {
  return createHash("sha256").update(secretId, "utf8").digest("hex");
}

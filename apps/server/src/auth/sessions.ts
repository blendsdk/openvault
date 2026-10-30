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
 * The cache key is the SHA-256 hash of the secret cookie value. The raw secret
 * is never stored. A small in-process index supports listing and revocation
 * without scanning the cache, which has no enumeration API.
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
   * Concurrent rotations for the same old secret share one result.
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

    const rotation = this.#rotate(secretId, oldHash).finally(() => {
      this.#rotations.delete(oldHash);
    });
    this.#rotations.set(oldHash, rotation);
    return rotation;
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

    await this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`);
    this.#removeIndex(publicId);
    return true;
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
      const entry = this.#publicIndex.get(publicId);
      if (entry !== undefined) {
        await this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`);
        this.#removeIndex(publicId);
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
        this.#removeIndex(publicId);
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
    await this.#cache.shutdown();
  }

  async #rotate(secretId: string, oldHash: string): Promise<IssuedSession | undefined> {
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
    return { secretId: secretIdNext, record: rotated };
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
  }

  #sweep(): void {
    const now = this.#now();
    for (const [publicId, entry] of this.#publicIndex) {
      if (entry.expiresAt <= now) {
        void this.#cache.delete(`${SESSION_KEY_PREFIX}${entry.secretHash}`);
        this.#removeIndex(publicId);
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

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { importJWK } from "jose";
import type { CliAccessClaims } from "../auth/cli-jwt.js";
import {
  CLI_ACCESS_TOKEN_TTL_SECONDS,
  signCliAccessToken,
  verifyCliAccessToken,
} from "../auth/cli-jwt.js";
import { CLOCK_SKEW_SECONDS } from "./clock.js";
import type { KeyringProvider } from "./keyring.js";

/** Status of one JWT signing key. */
export type SigningKeyStatus = "current" | "previous" | "retired";

/** A signing-key row as stored in PostgreSQL. */
export interface SigningKeyRow {
  /** Key identifier carried in the JWT header. */
  readonly kid: string;
  /** 32-byte Ed25519 public key. */
  readonly publicKey: Buffer;
  /** 32-byte Ed25519 private seed encrypted under a KEK. */
  readonly wrappedSeed: Buffer;
  /** AES-GCM nonce for the wrapped seed. */
  readonly wrapNonce: Buffer;
  /** AES-GCM authentication tag for the wrapped seed. */
  readonly wrapTag: Buffer;
  /** KEK that wrapped the seed. */
  readonly kekId: string;
  /** Lifecycle state. */
  readonly status: SigningKeyStatus;
  /** Row creation time. */
  readonly createdAt: Date;
  /** Time the key became current. */
  readonly activatedAt: Date;
  /** Time the key was retired, or null while current/previous. */
  readonly retiredAt: Date | null;
}

/** Wrapped seed fields produced for one key identifier. */
export interface WrappedSigningSeed {
  /** Ciphertext of the 32-byte seed. */
  readonly wrappedSeed: Buffer;
  /** AES-GCM nonce. */
  readonly wrapNonce: Buffer;
  /** AES-GCM authentication tag. */
  readonly wrapTag: Buffer;
  /** KEK identifier used for the wrap. */
  readonly kekId: string;
}

/** Raised when signing-key material cannot be loaded or unwrapped. */
export class SigningKeyUnavailableError extends Error {
  public constructor(message = "Signing key is unavailable") {
    super(message);
    this.name = "SigningKeyUnavailableError";
  }
}

/** Raised when a rotation would invalidate a still-live previous key. */
export class SigningKeyRotationError extends Error {
  public constructor(message = "Signing key rotation is not safe yet") {
    super(message);
    this.name = "SigningKeyRotationError";
  }
}

/** How long a previous key may verify tokens after it stopped being current. */
export const SIGNING_KEY_OVERLAP_MS = (CLI_ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS) * 1_000;

/** Maximum age of the in-process key snapshot before it is refreshed. */
export const SIGNING_KEY_CACHE_TTL_MS = CLOCK_SKEW_SECONDS * 1_000;

const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAP_ALGORITHM = "aes-256-gcm";
const SIGNING_KEY_LOCK = "openvault:signing_keys";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Builds the authentication context for one wrapped seed.
 *
 * The AAD binds the ciphertext to the key identifier, so moving a wrapped seed
 * to another `kid` row fails authentication.
 *
 * @param kid - Key identifier.
 * @returns UTF-8 AAD bytes.
 */
function seedAad(kid: string): Buffer {
  return Buffer.from(`ov:jwt:v1:${kid}`, "utf8");
}

/**
 * Generates an Ed25519 key pair and returns the seed and public key.
 *
 * The seed is returned as a mutable Buffer for immediate wrapping. The caller
 * owns it and must zero it. This function does not convert the seed to JSON,
 * base64url, or a string, and never logs it.
 *
 * @param nowMs - Time used to create the ULID key identifier.
 * @returns The key identifier and raw key material.
 * @throws {Error} When the runtime cannot export a 32-byte Ed25519 key pair.
 */
export function generateSigningKey(nowMs: number = Date.now()): {
  readonly kid: string;
  readonly publicKey: Buffer;
  readonly seed: Buffer;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  try {
    if (
      privateDer.length !== PKCS8_PREFIX.length + SEED_BYTES ||
      publicDer.length !== SPKI_PREFIX.length + PUBLIC_KEY_BYTES ||
      !privateDer.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX) ||
      !publicDer.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)
    ) {
      throw new Error("Ed25519 key export produced an unexpected encoding");
    }

    return {
      kid: newUlid(nowMs),
      publicKey: Buffer.from(publicDer.subarray(SPKI_PREFIX.length)),
      seed: Buffer.from(privateDer.subarray(PKCS8_PREFIX.length)),
    };
  } finally {
    privateDer.fill(0);
    publicDer.fill(0);
  }
}

/**
 * Wraps a 32-byte Ed25519 seed with the current KEK.
 *
 * @param keyring - Loaded keyring provider.
 * @param kid - Key identifier bound into the AAD.
 * @param seed - 32-byte private seed. The caller retains ownership.
 * @returns Ciphertext, nonce, tag, and KEK identifier.
 * @throws {SigningKeyUnavailableError} When the keyring is unavailable or the seed is malformed.
 */
export function wrapSigningSeed(
  keyring: KeyringProvider,
  kid: string,
  seed: Buffer,
): WrappedSigningSeed {
  if (seed.length !== SEED_BYTES) {
    throw new SigningKeyUnavailableError();
  }

  try {
    const kekId = keyring.currentId;
    if (kekId === undefined) {
      throw new SigningKeyUnavailableError();
    }

    return keyring.withCurrentKey((kek) => {
      const nonce = randomBytes(WRAP_NONCE_BYTES);
      const cipher = createCipheriv(WRAP_ALGORITHM, kek, nonce);
      cipher.setAAD(seedAad(kid));
      const wrappedSeed = Buffer.concat([cipher.update(seed), cipher.final()]);
      const wrapTag = cipher.getAuthTag();
      if (wrappedSeed.length !== SEED_BYTES || wrapTag.length !== WRAP_TAG_BYTES) {
        throw new SigningKeyUnavailableError();
      }
      return { wrappedSeed, wrapNonce: nonce, wrapTag, kekId };
    });
  } catch (error) {
    if (error instanceof SigningKeyUnavailableError) {
      throw error;
    }
    throw new SigningKeyUnavailableError();
  }
}

/**
 * Unwraps a signing-key seed with the KEK recorded on its row.
 *
 * The returned buffer is owned by the caller and must be zeroed after use. Any
 * keyring, length, or authentication failure is reported as one generic error
 * so a caller cannot distinguish a missing key from a tampered ciphertext.
 *
 * @param keyring - Loaded keyring provider.
 * @param row - Stored key row.
 * @returns The 32-byte private seed.
 * @throws {SigningKeyUnavailableError} When the seed cannot be authenticated.
 */
export function unwrapSigningSeed(keyring: KeyringProvider, row: SigningKeyRow): Buffer {
  try {
    if (
      row.wrappedSeed.length !== SEED_BYTES ||
      row.wrapNonce.length !== WRAP_NONCE_BYTES ||
      row.wrapTag.length !== WRAP_TAG_BYTES
    ) {
      throw new SigningKeyUnavailableError();
    }

    return keyring.withKey(row.kekId, (kek) => {
      const decipher = createDecipheriv(WRAP_ALGORITHM, kek, row.wrapNonce);
      decipher.setAAD(seedAad(row.kid));
      decipher.setAuthTag(row.wrapTag);
      let head: Buffer | undefined;
      let tail: Buffer | undefined;
      try {
        head = decipher.update(row.wrappedSeed);
        tail = decipher.final();
        const seed = Buffer.concat([head, tail]);
        if (seed.length !== SEED_BYTES) {
          seed.fill(0);
          throw new SigningKeyUnavailableError();
        }
        return seed;
      } finally {
        head?.fill(0);
        tail?.fill(0);
      }
    });
  } catch (error) {
    if (error instanceof SigningKeyUnavailableError) {
      throw error;
    }
    throw new SigningKeyUnavailableError();
  }
}

/** Minimal query surface used by the signing-key repository and its transactions. */
export interface SigningKeyQuery {
  /** Executes a parameterized query and returns its records. */
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}

/**
 * Raw database row shape for a signing key.
 *
 * PostgreSQL returns snake_case column names; the repository maps them to the
 * public camelCase {@link SigningKeyRow} once so the rest of the server never
 * depends on the storage spelling.
 */
interface SigningKeyDbRow {
  /** Key identifier. */
  readonly kid: string;
  /** 32-byte public key. */
  readonly public_key: Buffer;
  /** 32-byte wrapped seed. */
  readonly wrapped_seed: Buffer;
  /** AES-GCM nonce. */
  readonly wrap_nonce: Buffer;
  /** AES-GCM authentication tag. */
  readonly wrap_tag: Buffer;
  /** KEK identifier. */
  readonly kek_id: string;
  /** Lifecycle status text from the check constraint. */
  readonly status: string;
  /** Row creation time. */
  readonly created_at: Date;
  /** Time the key became current. */
  readonly activated_at: Date;
  /** Retirement time. */
  readonly retired_at: Date | null;
}

/** Input used to insert a current signing key. */
export interface InsertSigningKeyInput {
  /** Key identifier. */
  readonly kid: string;
  /** 32-byte public key. */
  readonly publicKey: Buffer;
  /** 32-byte wrapped seed. */
  readonly wrappedSeed: Buffer;
  /** AES-GCM nonce. */
  readonly wrapNonce: Buffer;
  /** AES-GCM authentication tag. */
  readonly wrapTag: Buffer;
  /** KEK identifier. */
  readonly kekId: string;
  /** Activation time. */
  readonly activatedAt: Date;
}

/**
 * Narrows a stored status string to the lifecycle union.
 *
 * @param value - Raw database status.
 * @returns The validated status.
 * @throws {SigningKeyUnavailableError} When the database contains an unknown value.
 */
function toSigningKeyStatus(value: string): SigningKeyStatus {
  if (value === "current" || value === "previous" || value === "retired") {
    return value;
  }
  throw new SigningKeyUnavailableError();
}

/**
 * Maps one database row to the server-facing key shape.
 *
 * @param row - Raw PostgreSQL row.
 * @returns The camelCase key row.
 */
function toSigningKeyRow(row: SigningKeyDbRow): SigningKeyRow {
  return {
    kid: row.kid,
    publicKey: row.public_key,
    wrappedSeed: row.wrapped_seed,
    wrapNonce: row.wrap_nonce,
    wrapTag: row.wrap_tag,
    kekId: row.kek_id,
    status: toSigningKeyStatus(row.status),
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  };
}

/**
 * Stores and transitions signing-key rows.
 *
 * Lifecycle mutations run under one transaction-scoped advisory lock. The lock
 * is deliberately database-wide, so two server processes cannot both create a
 * current key or rotate at the same time.
 */
export class SigningKeyRepository {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param database - Connected PostgreSQL database.
   */
  public constructor(database: PostgreSQLDatabase) {
    this.#database = database;
  }

  /**
   * Runs an action inside the signing-key advisory lock.
   *
   * @param action - Work that must observe a stable key lifecycle.
   * @returns The action result.
   */
  public withLock<T>(action: (database: SigningKeyQuery) => Promise<T>): Promise<T> {
    return this.#database.withTransaction(async (tx) => {
      await tx.executeQuery("SELECT pg_advisory_xact_lock(hashtext(:lockName))", {
        lockName: SIGNING_KEY_LOCK,
      });
      return action(tx);
    });
  }

  /**
   * Loads the current key.
   *
   * @param database - Transaction or pool handle. Defaults to the pool.
   * @returns The current row, or `undefined`.
   */
  public async findCurrent(
    database: SigningKeyQuery = this.#database,
  ): Promise<SigningKeyRow | undefined> {
    return this.#findByStatus(database, "current");
  }

  /**
   * Loads the previous key.
   *
   * @param database - Transaction or pool handle. Defaults to the pool.
   * @returns The previous row, or `undefined`.
   */
  public async findPrevious(
    database: SigningKeyQuery = this.#database,
  ): Promise<SigningKeyRow | undefined> {
    return this.#findByStatus(database, "previous");
  }

  /**
   * Loads the current and previous keys from one consistent database snapshot.
   *
   * A single statement avoids the torn pair that two independent reads can
   * produce while another process rotates the keys.
   *
   * @param database - Transaction or pool handle. Defaults to the pool.
   * @returns The current and previous rows, each optional independently.
   * @throws {SigningKeyUnavailableError} When more than one row has either status.
   */
  public async findLifecycle(database: SigningKeyQuery = this.#database): Promise<{
    readonly current: SigningKeyRow | undefined;
    readonly previous: SigningKeyRow | undefined;
  }> {
    const result = await database.executeQuery<SigningKeyDbRow>(
      `SELECT kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status,
              created_at, activated_at, retired_at
         FROM signing_keys
        WHERE status IN ('current', 'previous')`,
    );

    let current: SigningKeyRow | undefined;
    let previous: SigningKeyRow | undefined;
    for (const raw of result.records) {
      const row = toSigningKeyRow(raw);
      if (row.status === "current") {
        if (current !== undefined) {
          throw new SigningKeyUnavailableError();
        }
        current = row;
      } else if (row.status === "previous") {
        if (previous !== undefined) {
          throw new SigningKeyUnavailableError();
        }
        previous = row;
      }
    }
    return { current, previous };
  }

  /**
   * Inserts a current key row.
   *
   * @param database - Transaction or pool handle.
   * @param input - Wrapped key material and activation time.
   * @returns The inserted row.
   */
  public async insertCurrent(
    database: SigningKeyQuery,
    input: InsertSigningKeyInput,
  ): Promise<SigningKeyRow> {
    const result = await database.executeQuery<SigningKeyDbRow>(
      `INSERT INTO signing_keys
         (kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status, activated_at)
       VALUES
         (:kid, :publicKey, :wrappedSeed, :wrapNonce, :wrapTag, :kekId, 'current', :activatedAt)
       RETURNING kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status,
                 created_at, activated_at, retired_at`,
      {
        kid: input.kid,
        publicKey: input.publicKey,
        wrappedSeed: input.wrappedSeed,
        wrapNonce: input.wrapNonce,
        wrapTag: input.wrapTag,
        kekId: input.kekId,
        activatedAt: input.activatedAt,
      },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new SigningKeyUnavailableError();
    }
    return toSigningKeyRow(row);
  }

  /**
   * Moves the current key to the previous slot.
   *
   * @param database - Transaction handle.
   * @param kid - Current key identifier.
   */
  public async promoteCurrentToPrevious(database: SigningKeyQuery, kid: string): Promise<void> {
    await database.executeQuery(
      `UPDATE signing_keys
          SET status = 'previous'
        WHERE kid = :kid AND status = 'current'`,
      { kid },
    );
  }

  /**
   * Marks a previous key retired.
   *
   * @param database - Transaction handle.
   * @param kid - Previous key identifier.
   * @param retiredAt - Retirement time.
   */
  public async retirePrevious(
    database: SigningKeyQuery,
    kid: string,
    retiredAt: Date,
  ): Promise<void> {
    await database.executeQuery(
      `UPDATE signing_keys
          SET status = 'retired', retired_at = :retiredAt
        WHERE kid = :kid AND status = 'previous'`,
      { kid, retiredAt },
    );
  }

  async #findByStatus(
    database: SigningKeyQuery,
    status: SigningKeyStatus,
  ): Promise<SigningKeyRow | undefined> {
    const result = await database.executeQuery<SigningKeyDbRow>(
      `SELECT kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status,
              created_at, activated_at, retired_at
         FROM signing_keys
        WHERE status = :status
        LIMIT 1`,
      { status },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSigningKeyRow(row);
  }
}

/** Options required by {@link SigningKeyService}. */
export interface SigningKeyServiceOptions {
  /** Database-backed key repository. */
  readonly repository: SigningKeyRepository;
  /** Loaded KEK provider. */
  readonly keyring: KeyringProvider;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Optional structured warning when an unauthenticated previous row is ignored. */
  readonly onPreviousKeyRejected?: (kid: string) => void;
}

interface CachedCurrentKey {
  readonly row: SigningKeyRow;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

interface CachedPreviousKey {
  readonly row: SigningKeyRow;
  readonly publicKey: CryptoKey;
}

/**
 * Owns signing-key lifecycle decisions and cached key material.
 *
 * The service creates the first key under the repository advisory lock, rotates
 * only when the previous key is outside its overlap window, retires due keys,
 * and signs/verifies access tokens. Raw seeds exist during generation/wrapping
 * and during unwrapping; they are handled as mutable buffers and zeroed after
 * the imported key is created. A warm snapshot is refreshed at most every
 * {@link SIGNING_KEY_CACHE_TTL_MS} so a rotation in another process is observed
 * without a restart.
 */
export class SigningKeyService {
  readonly #repository: SigningKeyRepository;
  readonly #keyring: KeyringProvider;
  readonly #now: () => number;
  readonly #onPreviousKeyRejected: ((kid: string) => void) | undefined;
  #current: CachedCurrentKey | undefined;
  #previous: CachedPreviousKey | undefined;
  #loadedAt: number | undefined;
  #reloadChain: Promise<void> = Promise.resolve();

  /**
   * @param options - Repository, keyring, and clock.
   */
  public constructor(options: SigningKeyServiceOptions) {
    this.#repository = options.repository;
    this.#keyring = options.keyring;
    this.#now = options.now ?? Date.now;
    this.#onPreviousKeyRejected = options.onPreviousKeyRejected;
  }

  /**
   * Creates the first current key when absent and loads current/previous state.
   *
   * The operation is idempotent and safe across concurrent servers because the
   * repository holds a database-wide advisory lock and the table enforces one
   * current row.
   */
  public async ensure(): Promise<void> {
    await this.#repository.withLock(async (database) => {
      const current = await this.#repository.findCurrent(database);
      if (current !== undefined) {
        return;
      }
      await this.#createCurrent(database, this.#now());
    });
    await this.#reload();
  }

  /**
   * Rotates to a new current key.
   *
   * A rotation is rejected while a previous key would still be inside its
   * verification overlap. When no previous key exists, the first rotation is
   * allowed immediately.
   *
   * @returns The new current key identifier.
   * @throws {SigningKeyRotationError} When retiring the previous key would invalidate live tokens.
   */
  public async rotate(): Promise<{ readonly kid: string }> {
    const created = await this.#repository.withLock(async (database) => {
      const now = this.#now();
      const current = await this.#repository.findCurrent(database);
      if (current === undefined) {
        return this.#createCurrent(database, now);
      }

      const previous = await this.#repository.findPrevious(database);
      if (previous !== undefined && !this.#isPreviousOverlapElapsed(current, now)) {
        throw new SigningKeyRotationError();
      }
      if (previous !== undefined) {
        await this.#repository.retirePrevious(database, previous.kid, new Date(now));
      }
      await this.#repository.promoteCurrentToPrevious(database, current.kid);
      return this.#createCurrent(database, now);
    });
    await this.#reload();
    return { kid: created.kid };
  }

  /**
   * Retires a previous key whose overlap window has ended.
   *
   * @returns The number of rows retired (0 or 1).
   */
  public async retireDue(): Promise<number> {
    const retired = await this.#repository.withLock(async (database) => {
      const now = this.#now();
      const current = await this.#repository.findCurrent(database);
      const previous = await this.#repository.findPrevious(database);
      if (
        current === undefined ||
        previous === undefined ||
        !this.#isPreviousOverlapElapsed(current, now)
      ) {
        return 0;
      }
      await this.#repository.retirePrevious(database, previous.kid, new Date(now));
      return 1;
    });
    if (retired > 0) {
      await this.#reload();
    }
    return retired;
  }

  /**
   * Signs a CLI access token with the current key.
   *
   * @param input - Principal, family, and current time.
   * @returns The compact JWT and its absolute expiry.
   * @throws {SigningKeyUnavailableError} When no current key can be loaded.
   */
  public async signAccessToken(input: {
    readonly principalId: string;
    readonly familyId: string;
    readonly nowMs: number;
  }): Promise<{ readonly token: string; readonly expiresAt: number }> {
    await this.#ensureCurrent();
    const current = this.#current;
    if (current === undefined) {
      throw new SigningKeyUnavailableError();
    }
    return signCliAccessToken({
      privateKey: current.privateKey,
      kid: current.row.kid,
      principalId: input.principalId,
      familyId: input.familyId,
      nowMs: input.nowMs,
    });
  }

  /**
   * Verifies a CLI access token against the current and previous keys.
   *
   * A previous key is accepted only while its overlap window is open, even if
   * its row has not yet been retired.
   *
   * @param token - Compact JWT.
   * @returns The validated claims.
   * @throws {CliTokenError} When the token or key is not acceptable.
   * @throws {SigningKeyUnavailableError} When the current key cannot be loaded.
   */
  public async verifyAccessToken(token: string): Promise<CliAccessClaims> {
    await this.#ensureCurrent();
    const current = this.#current;
    if (current === undefined) {
      throw new SigningKeyUnavailableError();
    }

    const now = this.#now();
    const previous = this.#previous;
    return verifyCliAccessToken(
      token,
      async (kid) => {
        if (kid === current.row.kid) {
          return current.publicKey;
        }
        if (previous === undefined || previous.row.kid !== kid) {
          return undefined;
        }
        return this.#isPreviousOverlapElapsed(current.row, now) ? undefined : previous.publicKey;
      },
      now,
    );
  }

  /** Clears cached key references. The operation is idempotent. */
  public destroy(): void {
    this.#current = undefined;
    this.#previous = undefined;
    this.#loadedAt = undefined;
  }

  /**
   * Ensures the current key is present and the cached snapshot is fresh.
   *
   * A missing current key triggers the lazy `ensure()` bootstrap. A warm
   * snapshot older than {@link SIGNING_KEY_CACHE_TTL_MS} is reloaded through
   * the serialized reload chain. A reload failure clears the cache before the
   * error escapes, so the next use retries or fails closed rather than signing
   * or verifying with a retired key.
   */
  async #ensureCurrent(): Promise<void> {
    const now = this.#now();
    const stale = this.#loadedAt === undefined || now - this.#loadedAt >= SIGNING_KEY_CACHE_TTL_MS;
    if (this.#current === undefined || stale) {
      try {
        await this.#reload();
      } catch (error) {
        this.destroy();
        throw error;
      }
    }
    if (this.#current === undefined) {
      await this.ensure();
    }
  }

  /**
   * Serializes cache refreshes and publishes one consistent key snapshot.
   *
   * A caller that starts after a rotation waits for any in-flight refresh and
   * then reads the committed state. A failed refresh clears the cache so the
   * next use retries or fails closed rather than trusting a stale key.
   */
  async #reload(): Promise<void> {
    const next = this.#reloadChain.then(() => this.#reloadNow());
    this.#reloadChain = next.catch(() => undefined);
    await next;
  }

  /**
   * Reads one key snapshot and publishes it atomically.
   *
   * The snapshot is read in one statement. The cache is updated only after all
   * imports succeed; any failure clears it so the next use fails closed or
   * retries rather than trusting a partial state.
   */
  async #reloadNow(): Promise<void> {
    try {
      const snapshot = await this.#repository.findLifecycle();
      const current = snapshot.current;
      if (current === undefined) {
        this.#current = undefined;
        this.#previous = undefined;
        this.#loadedAt = this.#now();
        return;
      }

      const currentKeys = await this.#importCurrentKeys(current);
      const previousKey =
        snapshot.previous === undefined
          ? undefined
          : await this.#importPreviousKey(snapshot.previous);
      this.#current = { row: current, ...currentKeys };
      this.#previous =
        snapshot.previous === undefined || previousKey === undefined
          ? undefined
          : { row: snapshot.previous, publicKey: previousKey };
      this.#loadedAt = this.#now();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Generates, wraps, and inserts one current key inside an existing lock.
   *
   * The caller must already hold the repository advisory lock. The raw seed is
   * zeroed after wrapping, even when the insert fails.
   *
   * @param database - Transaction handle that holds the lifecycle lock.
   * @param nowMs - Activation time for the new key.
   * @returns The inserted current row.
   */
  async #createCurrent(database: SigningKeyQuery, nowMs: number): Promise<SigningKeyRow> {
    const generated = generateSigningKey(nowMs);
    try {
      const wrapped = wrapSigningSeed(this.#keyring, generated.kid, generated.seed);
      return await this.#repository.insertCurrent(database, {
        kid: generated.kid,
        publicKey: generated.publicKey,
        wrappedSeed: wrapped.wrappedSeed,
        wrapNonce: wrapped.wrapNonce,
        wrapTag: wrapped.wrapTag,
        kekId: wrapped.kekId,
        activatedAt: new Date(nowMs),
      });
    } finally {
      generated.seed.fill(0);
    }
  }

  /**
   * Imports the current row's private and public keys.
   *
   * `jose` requires a JWK, so the seed is converted to a base64url string for
   * the import. The mutable seed buffer is zeroed afterwards; the transient
   * immutable string cannot be erased and is treated as best-effort memory
   * hygiene. A malformed key or import failure is reported as one generic
   * unavailable error.
   *
   * @param row - Current key row.
   * @returns Imported signing and verification keys.
   */
  async #importCurrentKeys(
    row: SigningKeyRow,
  ): Promise<{ readonly privateKey: CryptoKey; readonly publicKey: CryptoKey }> {
    const seed = unwrapSigningSeed(this.#keyring, row);
    try {
      const privateKey = await importJWK(
        {
          kty: "OKP",
          crv: "Ed25519",
          x: row.publicKey.toString("base64url"),
          d: seed.toString("base64url"),
        },
        "EdDSA",
      );
      const publicKey = await this.#importPublicKey(row);
      if (publicKey === undefined) {
        throw new SigningKeyUnavailableError();
      }
      return { privateKey, publicKey };
    } catch (error) {
      if (error instanceof SigningKeyUnavailableError) {
        throw error;
      }
      throw new SigningKeyUnavailableError();
    } finally {
      seed.fill(0);
    }
  }

  /**
   * Imports a previous key only when its public bytes derive from its wrapped seed.
   *
   * The previous row is not authenticated by encryption alone: an attacker with
   * database write access could replace the public key while leaving a valid
   * wrapped seed in place. Unwrapping the seed and deriving the public key
   * closes that mismatch. A failure is treated as an unavailable previous key,
   * not as a service-wide failure, so current-key verification keeps working.
   *
   * @param row - Previous key row.
   * @returns The verification key, or `undefined` when the row is not authentic.
   */
  async #importPreviousKey(row: SigningKeyRow): Promise<CryptoKey | undefined> {
    let seed: Buffer | undefined;
    try {
      seed = unwrapSigningSeed(this.#keyring, row);
      // Node's JWK importer requires `x`, which is the value being checked.
      // Build the PKCS#8 envelope directly from the seed so the derived public
      // key is independent of the stored public bytes.
      const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const der = Buffer.concat([pkcs8Prefix, seed]);
      let privateKey: ReturnType<typeof createPrivateKey>;
      try {
        privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      } finally {
        der.fill(0);
      }
      const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
      if (!Buffer.isBuffer(spki) || spki.length < 32) {
        throw new SigningKeyUnavailableError();
      }
      const derived = spki.subarray(spki.length - 32);
      if (derived.length !== 32 || !timingSafeEqual(derived, row.publicKey)) {
        throw new SigningKeyUnavailableError();
      }
      return await this.#importPublicKey(row);
    } catch {
      this.#onPreviousKeyRejected?.(row.kid);
      return undefined;
    } finally {
      seed?.fill(0);
    }
  }

  /**
   * Imports a public key for verification.
   *
   * @param row - Key row containing the raw 32-byte public key.
   * @returns The verification key, or `undefined` when the row is malformed.
   */
  async #importPublicKey(row: SigningKeyRow): Promise<CryptoKey | undefined> {
    try {
      return await importJWK(
        { kty: "OKP", crv: "Ed25519", x: row.publicKey.toString("base64url") },
        "EdDSA",
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Reports whether the previous key's verification overlap has elapsed.
   *
   * The current key's `activatedAt` is the moment the previous key stopped
   * being current, so it is also the start of the previous key's overlap.
   * Once this returns true, the previous key must no longer verify and a new
   * rotation may retire it.
   */
  #isPreviousOverlapElapsed(current: SigningKeyRow, nowMs: number): boolean {
    return nowMs >= current.activatedAt.getTime() + SIGNING_KEY_OVERLAP_MS;
  }
}

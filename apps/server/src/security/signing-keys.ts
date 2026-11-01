import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
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

/** A newly generated Ed25519 key pair and its wrapped representation. */
export interface GeneratedSigningKey {
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
export const SIGNING_KEY_OVERLAP_MS = (15 * 60 + 30) * 1_000;

const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAP_ALGORITHM = "aes-256-gcm";
const SIGNING_KEY_LOCK = "openvault:signing_keys";

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
 * The caller owns the returned seed and must zero it after wrapping. The seed
 * is never serialized or logged by this function.
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
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const encodedSeed = privateJwk.d;
  const encodedPublic = publicJwk.x;
  if (typeof encodedSeed !== "string" || typeof encodedPublic !== "string") {
    throw new Error("Ed25519 key export did not produce the required fields");
  }

  const seed = Buffer.from(encodedSeed, "base64url");
  const rawPublic = Buffer.from(encodedPublic, "base64url");
  if (seed.length !== SEED_BYTES || rawPublic.length !== PUBLIC_KEY_BYTES) {
    seed.fill(0);
    rawPublic.fill(0);
    throw new Error("Ed25519 key export produced an unexpected key length");
  }

  return {
    kid: newUlid(nowMs),
    publicKey: rawPublic,
    seed,
  };
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
      const seed = Buffer.concat([decipher.update(row.wrappedSeed), decipher.final()]);
      if (seed.length !== SEED_BYTES) {
        seed.fill(0);
        throw new SigningKeyUnavailableError();
      }
      return seed;
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

interface SigningKeyDbRow {
  readonly kid: string;
  readonly public_key: Buffer;
  readonly wrapped_seed: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
  readonly status: string;
  readonly created_at: Date;
  readonly activated_at: Date;
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

function toSigningKeyStatus(value: string): SigningKeyStatus {
  if (value === "current" || value === "previous" || value === "retired") {
    return value;
  }
  throw new SigningKeyUnavailableError();
}

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

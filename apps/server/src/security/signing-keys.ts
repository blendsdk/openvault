import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
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

const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAP_ALGORITHM = "aes-256-gcm";

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

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Keyring } from "./keyring.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

/** Identity fields bound to ciphertext so a value cannot be moved to another object. */
export interface EnvelopeAad {
  /** Project that owns the object. */
  readonly projectId: string;
  /** Secret or certificate identifier. */
  readonly objectId: string;
  /** Immutable version identifier. */
  readonly version: string;
}

/** Serialized envelope stored in PostgreSQL. All binary fields are base64 strings. */
export interface EncryptedValue {
  /** Identifier of the KEK that wrapped the data key. */
  readonly kekId: string;
  /** 96-bit AES-GCM nonce for the value. */
  readonly nonce: string;
  /** AES-GCM ciphertext of the value. */
  readonly ciphertext: string;
  /** AES-GCM authentication tag for the value. */
  readonly tag: string;
  /** 96-bit AES-GCM nonce for the wrapped data key. */
  readonly wrapNonce: string;
  /** AES-GCM ciphertext of the wrapped data key. */
  readonly wrappedDek: string;
  /** AES-GCM authentication tag for the wrapped data key. */
  readonly wrapTag: string;
}

/** Raised when an envelope is malformed before any cryptography runs. */
export class CryptoInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CryptoInputError";
  }
}

/** Raised when authentication fails. The message never contains plaintext or key material. */
export class CryptoIntegrityError extends Error {
  public constructor() {
    super("Encrypted value failed integrity verification");
    this.name = "CryptoIntegrityError";
  }
}

function valueAad(aad: EnvelopeAad): Buffer {
  return Buffer.from(`ov:v1:${aad.projectId}:${aad.objectId}:${aad.version}`, "utf8");
}

function wrapAad(kekId: string, aad: EnvelopeAad): Buffer {
  return Buffer.from(`ov:dek:v1:${kekId}:${aad.objectId}:${aad.version}`, "utf8");
}

function decodeField(name: string, value: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new CryptoInputError(`Envelope field ${name} is missing`);
  }
  const decoded = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new CryptoInputError(`Envelope field ${name} has the wrong length`);
  }
  return decoded;
}

/**
 * Encrypts a value with a fresh data key and wraps that key with the current KEK.
 *
 * The value's AAD binds the ciphertext to its project, object, and version. The
 * wrapped data key has its own AAD, so copying either part onto another record
 * fails on decrypt. The KEK is only read inside the keyring's callback scope.
 */
export function encryptValue(
  plaintext: Buffer,
  keyring: Keyring,
  aad: EnvelopeAad,
): EncryptedValue {
  const kekId = keyring.currentId;

  return keyring.withKey(kekId, (kek) => {
    const dek = randomBytes(DEK_BYTES);

    try {
      const nonce = randomBytes(NONCE_BYTES);
      const valueCipher = createCipheriv(ALGORITHM, dek, nonce);
      valueCipher.setAAD(valueAad(aad));
      const ciphertext = Buffer.concat([valueCipher.update(plaintext), valueCipher.final()]);
      const tag = valueCipher.getAuthTag();

      const wrapNonce = randomBytes(NONCE_BYTES);
      const wrapCipher = createCipheriv(ALGORITHM, kek, wrapNonce);
      wrapCipher.setAAD(wrapAad(kekId, aad));
      const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
      const wrapTag = wrapCipher.getAuthTag();

      return {
        kekId,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: tag.toString("base64"),
        wrapNonce: wrapNonce.toString("base64"),
        wrappedDek: wrappedDek.toString("base64"),
        wrapTag: wrapTag.toString("base64"),
      };
    } finally {
      dek.fill(0);
    }
  });
}

/**
 * Decrypts an envelope produced by {@link encryptValue}.
 *
 * Throws {@link CryptoInputError} for malformed fields and
 * {@link CryptoIntegrityError} when either authentication tag fails. The KEK is
 * only read inside the keyring's callback scope.
 */
export function decryptValue(envelope: EncryptedValue, keyring: Keyring, aad: EnvelopeAad): Buffer {
  const nonce = decodeField("nonce", envelope.nonce, NONCE_BYTES);
  const ciphertext = decodeField("ciphertext", envelope.ciphertext);
  const tag = decodeField("tag", envelope.tag, TAG_BYTES);
  const wrapNonce = decodeField("wrapNonce", envelope.wrapNonce, NONCE_BYTES);
  const wrappedDek = decodeField("wrappedDek", envelope.wrappedDek, DEK_BYTES);
  const wrapTag = decodeField("wrapTag", envelope.wrapTag, TAG_BYTES);

  return keyring.withKey(envelope.kekId, (kek) => {
    let dek: Buffer | undefined;

    try {
      const unwrapCipher = createDecipheriv(ALGORITHM, kek, wrapNonce);
      unwrapCipher.setAAD(wrapAad(envelope.kekId, aad));
      unwrapCipher.setAuthTag(wrapTag);
      dek = Buffer.concat([unwrapCipher.update(wrappedDek), unwrapCipher.final()]);

      const valueCipher = createDecipheriv(ALGORITHM, dek, nonce);
      valueCipher.setAAD(valueAad(aad));
      valueCipher.setAuthTag(tag);
      return Buffer.concat([valueCipher.update(ciphertext), valueCipher.final()]);
    } catch {
      throw new CryptoIntegrityError();
    } finally {
      dek?.fill(0);
    }
  });
}

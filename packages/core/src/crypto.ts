import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ULID_PATTERN } from "./ids.js";
import { KeyringError } from "./keyring.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_KEYS = [
  "kekId",
  "nonce",
  "ciphertext",
  "tag",
  "wrapNonce",
  "wrappedDek",
  "wrapTag",
] as const;

/** Object families that share the envelope format. */
export type EnvelopeObjectType = "secret" | "certificate";

/** Identity fields bound to ciphertext so a value cannot be moved to another object. */
export interface EnvelopeAad {
  /** Object family. */
  readonly objectType: EnvelopeObjectType;
  /** Project that owns the object. */
  readonly projectId: string;
  /** Secret or certificate identifier. */
  readonly objectId: string;
  /** Immutable version identifier. */
  readonly version: string;
}

/** Bounds applied when decrypting an envelope. */
export interface EnvelopeLimits {
  /** Maximum accepted ciphertext bytes. */
  readonly maxCiphertextBytes: number;
}

/**
 * Keyring surface used by envelope encryption.
 *
 * Both the core `Keyring` and the server's redacted provider satisfy this
 * interface, so the crypto code never depends on a concrete keyring class.
 */
export interface EnvelopeKeyring {
  /** Identifier of the current key, or undefined when unloaded. */
  readonly currentId: string | undefined;
  /** True after the keyring has been destroyed or unloaded. */
  readonly destroyed: boolean;
  /** Runs one action with the current key. */
  withCurrentKey<T>(action: (key: Readonly<Buffer>) => T): T;
  /** Runs one action with a named key. */
  withKey<T>(id: string, action: (key: Readonly<Buffer>) => T): T;
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
  return Buffer.from(
    `ov:v2:${aad.objectType}:${aad.projectId}:${aad.objectId}:${aad.version}`,
    "utf8",
  );
}

function wrapAad(kekId: string, aad: EnvelopeAad): Buffer {
  return Buffer.from(
    `ov:dek:v2:${kekId}:${aad.objectType}:${aad.projectId}:${aad.objectId}:${aad.version}`,
    "utf8",
  );
}

/** Validates the AAD identifiers before any key lookup or string interpolation. */
function assertAad(aad: EnvelopeAad): void {
  if (aad.objectType !== "secret" && aad.objectType !== "certificate") {
    throw new CryptoInputError("Envelope object type is invalid");
  }
  for (const value of [aad.projectId, aad.objectId, aad.version]) {
    if (!ULID_PATTERN.test(value)) {
      throw new CryptoInputError("Envelope identifier is invalid");
    }
  }
}

/** Decodes one canonical base64 field and validates its byte length. */
function decodeField(
  name: string,
  value: string,
  expectedBytes?: number,
  allowEmpty = false,
): Buffer {
  if (typeof value !== "string" || (value.length === 0 && !allowEmpty)) {
    throw new CryptoInputError(`Envelope field ${name} is not canonical base64`);
  }
  if (value.length > 0 && !CANONICAL_BASE64.test(value)) {
    throw new CryptoInputError(`Envelope field ${name} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (encodedCanonical(decoded) !== value) {
    throw new CryptoInputError(`Envelope field ${name} is not canonical base64`);
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new CryptoInputError(`Envelope field ${name} has the wrong length`);
  }
  return decoded;
}

/** Re-encodes bytes as canonical base64 for comparison with the supplied field. */
function encodedCanonical(value: Buffer): string {
  return value.toString("base64");
}

/** Rejects unknown or missing envelope keys before any key lookup. */
function assertEnvelopeShape(envelope: EncryptedValue): void {
  const keys = Object.keys(envelope).sort();
  const expected = [...ENVELOPE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CryptoInputError("Envelope fields are invalid");
  }
}

/**
 * Encrypts a value with a fresh data key and wraps that key with the current KEK.
 *
 * The value's AAD binds the object type, project, object, and version. The
 * wrapped data key has its own AAD, so copying either part onto another record
 * fails on decrypt. The KEK is only read inside the keyring's callback scope.
 */
export function encryptValue(
  plaintext: Buffer,
  keyring: EnvelopeKeyring,
  aad: EnvelopeAad,
): EncryptedValue {
  assertAad(aad);
  const kekId = keyring.currentId;
  if (kekId === undefined) {
    throw new KeyringError("Keyring provider is not loaded");
  }

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
 * Throws {@link CryptoInputError} for malformed fields and an over-limit
 * ciphertext, and {@link CryptoIntegrityError} when either authentication tag
 * fails or the envelope names an unknown key. A destroyed keyring keeps its own
 * {@link KeyringError} so an operational shutdown is not reported as data
 * corruption. The KEK is only read inside the keyring's callback scope.
 */
export function decryptValue(
  envelope: EncryptedValue,
  keyring: EnvelopeKeyring,
  aad: EnvelopeAad,
  limits: EnvelopeLimits = { maxCiphertextBytes: 65_536 },
): Buffer {
  assertAad(aad);
  assertEnvelopeShape(envelope);
  if (!Number.isSafeInteger(limits.maxCiphertextBytes) || limits.maxCiphertextBytes < 0) {
    throw new CryptoInputError("Envelope ciphertext limit is invalid");
  }
  const nonce = decodeField("nonce", envelope.nonce, NONCE_BYTES);
  const ciphertext = decodeField("ciphertext", envelope.ciphertext, undefined, true);
  if (ciphertext.length > limits.maxCiphertextBytes) {
    throw new CryptoInputError("Envelope ciphertext exceeds the limit");
  }
  const tag = decodeField("tag", envelope.tag, TAG_BYTES);
  const wrapNonce = decodeField("wrapNonce", envelope.wrapNonce, NONCE_BYTES);
  const wrappedDek = decodeField("wrappedDek", envelope.wrappedDek, DEK_BYTES);
  const wrapTag = decodeField("wrapTag", envelope.wrapTag, TAG_BYTES);
  const kekId = envelope.kekId;
  if (typeof kekId !== "string" || kekId.length === 0 || kekId.length > 64) {
    throw new CryptoInputError("Envelope KEK identifier is invalid");
  }

  try {
    return keyring.withKey(kekId, (kek) => {
      let dek: Buffer | undefined;

      try {
        const unwrapCipher = createDecipheriv(ALGORITHM, kek, wrapNonce);
        unwrapCipher.setAAD(wrapAad(kekId, aad));
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
  } catch (error) {
    if (error instanceof KeyringError) {
      if (keyring.destroyed) {
        throw error;
      }
      throw new CryptoIntegrityError();
    }
    throw error;
  }
}

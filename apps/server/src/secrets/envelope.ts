import type { SecretEncoding } from "@openvault/api-contract";
import type { EncryptedValue } from "@openvault/core";
import { CryptoInputError, CryptoIntegrityError } from "@openvault/core";
import { SecretServiceError } from "./errors.js";
import type { SecretVersionRecord } from "./repository.js";

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

/** One decoded request value. */
export interface DecodedValue {
  /** Decoded bytes. */
  readonly bytes: Buffer;
  /** Supplied encoding. */
  readonly encoding: SecretEncoding;
}

/** Returns true when every byte is ASCII whitespace. */
function isWhitespaceOnly(bytes: Buffer): boolean {
  if (bytes.length === 0) {
    return true;
  }
  for (const byte of bytes) {
    if (!WHITESPACE.has(byte)) {
      return false;
    }
  }
  return true;
}

/**
 * Decodes and validates one request value.
 *
 * @param value - Request value.
 * @param encoding - Declared encoding.
 * @param maximumBytes - Decoded size limit.
 * @returns The decoded bytes.
 * @throws {SecretServiceError} 422 for malformed/empty values, 413 for an
 *   over-limit value.
 */
export function decodeRequestValue(
  value: string,
  encoding: SecretEncoding,
  maximumBytes: number,
): DecodedValue {
  let bytes: Buffer;
  if (encoding === "utf8") {
    bytes = Buffer.from(value, "utf8");
  } else {
    if (value.length === 0 || !CANONICAL_BASE64.test(value)) {
      throw new SecretServiceError(422, "validation_error", "Validation failed");
    }
    bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) {
      throw new SecretServiceError(422, "validation_error", "Validation failed");
    }
  }
  if (isWhitespaceOnly(bytes)) {
    throw new SecretServiceError(422, "validation_error", "Validation failed");
  }
  if (bytes.length > maximumBytes) {
    throw new SecretServiceError(413, "secret_too_large", "Secret value is too large");
  }
  return { bytes, encoding };
}

/** Returns true when text contains no disallowed control characters. */
function isSafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return false;
    }
  }
  return true;
}

/**
 * Encodes stored bytes for a response.
 *
 * @param bytes - Decrypted bytes.
 * @returns UTF-8 text when it round-trips safely, otherwise base64.
 */
export function encodeResponseValue(bytes: Buffer): {
  readonly value: string;
  readonly encoding: SecretEncoding;
} {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes) && isSafeText(text)) {
    return { value: text, encoding: "utf8" };
  }
  return { value: bytes.toString("base64"), encoding: "base64" };
}

/**
 * Maps an encrypted envelope to the database columns.
 *
 * @param encrypted - Core envelope.
 * @returns The column values.
 */
export function toStoredEnvelope(encrypted: EncryptedValue): {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
  readonly kekId: string;
} {
  return {
    ciphertext: Buffer.from(encrypted.ciphertext, "base64"),
    nonce: Buffer.from(encrypted.nonce, "base64"),
    tag: Buffer.from(encrypted.tag, "base64"),
    wrappedDek: Buffer.from(encrypted.wrappedDek, "base64"),
    wrapNonce: Buffer.from(encrypted.wrapNonce, "base64"),
    wrapTag: Buffer.from(encrypted.wrapTag, "base64"),
    kekId: encrypted.kekId,
  };
}

/**
 * Rebuilds the core envelope from a stored version row.
 *
 * @param row - Stored version.
 * @returns The canonical envelope shape.
 */
export function fromStoredEnvelope(row: SecretVersionRecord): EncryptedValue {
  return {
    kekId: row.kekId,
    nonce: row.nonce.toString("base64"),
    ciphertext: row.ciphertext.toString("base64"),
    tag: row.tag.toString("base64"),
    wrapNonce: row.wrapNonce.toString("base64"),
    wrappedDek: row.wrappedDek.toString("base64"),
    wrapTag: row.wrapTag.toString("base64"),
  };
}

/** Maps a crypto failure to the public secret integrity error. */
export function integrityError(error: unknown): SecretServiceError {
  if (error instanceof CryptoInputError || error instanceof CryptoIntegrityError) {
    return new SecretServiceError(500, "secret_integrity_failed", "Secret value is unavailable");
  }
  return error instanceof SecretServiceError
    ? error
    : new SecretServiceError(500, "secret_integrity_failed", "Secret value is unavailable");
}

import type { EncryptedValue } from "@openvault/core";
import type { CertificateVersionRecord } from "./repository.js";

/** Maps a core envelope to the certificate version columns. */
export function toStoredCertificateEnvelope(encrypted: EncryptedValue): {
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

/** Rebuilds the core envelope from a stored certificate version. */
export function fromStoredCertificateEnvelope(row: CertificateVersionRecord): EncryptedValue {
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

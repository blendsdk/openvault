import { describe, expect, it } from "vitest";
import {
  CryptoInputError,
  CryptoIntegrityError,
  decryptValue,
  type EncryptedValue,
  type EnvelopeAad,
  encryptValue,
  Keyring,
  KeyringError,
} from "../src/index.js";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const objectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const version = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

const aad: EnvelopeAad = {
  objectType: "secret",
  projectId,
  objectId,
  version,
};

const limits = { maxCiphertextBytes: 65_536 };

describe("envelope AAD binding", () => {
  it("should round-trip a value with the same AAD", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(decryptValue(envelope, keyring, aad, limits).toString("utf8")).toBe("value");
  });

  it("should reject a different object type", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() =>
      decryptValue(envelope, keyring, { ...aad, objectType: "certificate" }, limits),
    ).toThrow(CryptoIntegrityError);
  });

  it("should reject a different project, object, or version", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    for (const changed of [
      { projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
      { objectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
      { version: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
    ]) {
      expect(() => decryptValue(envelope, keyring, { ...aad, ...changed }, limits)).toThrow(
        CryptoIntegrityError,
      );
    }
  });

  it("should reject a non-canonical base64 field", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() => decryptValue({ ...envelope, nonce: "AA" }, keyring, aad, limits)).toThrow(
      CryptoInputError,
    );
  });

  it("should reject an unknown envelope field", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    const extra = { ...envelope, extra: "unexpected" } as EncryptedValue;
    expect(() => decryptValue(extra, keyring, aad, limits)).toThrow(CryptoInputError);
  });

  it("should reject a ciphertext above the supplied limit", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.alloc(32, 1), keyring, aad);
    expect(() => decryptValue(envelope, keyring, aad, { maxCiphertextBytes: 1 })).toThrow(
      CryptoInputError,
    );
  });

  it("should reject a non-ULID AAD field", () => {
    const keyring = Keyring.generate();
    expect(() =>
      encryptValue(Buffer.from("value"), keyring, { ...aad, projectId: "project-1" }),
    ).toThrow(CryptoInputError);
  });

  it("should support an authenticated empty ciphertext", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.alloc(0), keyring, aad);
    expect(decryptValue(envelope, keyring, aad, limits)).toHaveLength(0);
  });

  it("should preserve a destroyed-keyring error", () => {
    const keyring = Keyring.generate("k1");
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    keyring.destroy();
    expect(() => decryptValue(envelope, keyring, aad, limits)).toThrow(KeyringError);
  });
});

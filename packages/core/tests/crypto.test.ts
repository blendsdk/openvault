import { randomBytes } from "node:crypto";
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

const aad: EnvelopeAad = {
  projectId: "project-1",
  objectId: "secret-1",
  version: "version-1",
};

function withCiphertext(envelope: EncryptedValue, mutate: (bytes: Buffer) => void): EncryptedValue {
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  mutate(bytes);
  return { ...envelope, ciphertext: bytes.toString("base64") };
}

describe("Keyring", () => {
  it("round-trips through JSON", () => {
    const keyring = Keyring.generate("k1");
    const parsed = Keyring.fromJSON(keyring.toJSON());
    expect(parsed.current.id).toBe("k1");
    expect(parsed.current.key.equals(keyring.current.key)).toBe(true);
  });

  it("rejects a missing current key", () => {
    expect(() => new Keyring({ k1: randomBytes(32) }, "k2")).toThrow(KeyringError);
  });

  it("rejects wrong key lengths", () => {
    expect(() => new Keyring({ k1: randomBytes(16) }, "k1")).toThrow(KeyringError);
  });
});

describe("envelope encryption", () => {
  it("round-trips a value", () => {
    const keyring = Keyring.generate();
    const plaintext = Buffer.from("correct horse battery staple", "utf8");
    const envelope = encryptValue(plaintext, keyring, aad);
    expect(decryptValue(envelope, keyring, aad).toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("rejects a tampered ciphertext", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    const tampered = withCiphertext(envelope, (bytes) => {
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    });
    expect(() => decryptValue(tampered, keyring, aad)).toThrow(CryptoIntegrityError);
  });

  it("rejects a different AAD", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() => decryptValue(envelope, keyring, { ...aad, projectId: "project-2" })).toThrow(
      CryptoIntegrityError,
    );
  });

  it("rejects a different KEK with the same id", () => {
    const envelope = encryptValue(Buffer.from("value"), Keyring.generate("k1"), aad);
    expect(() => decryptValue(envelope, Keyring.generate("k1"), aad)).toThrow(CryptoIntegrityError);
  });

  it("rejects moving an envelope to another object", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() => decryptValue(envelope, keyring, { ...aad, objectId: "secret-2" })).toThrow(
      CryptoIntegrityError,
    );
  });

  it("rejects malformed envelopes before decryption", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() => decryptValue({ ...envelope, nonce: "AA==" }, keyring, aad)).toThrow(
      CryptoInputError,
    );
  });
});

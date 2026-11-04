import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
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
  objectType: "secret",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  objectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  version: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};

const limits = { maxCiphertextBytes: 65_536 };

function withCiphertext(envelope: EncryptedValue, mutate: (bytes: Buffer) => void): EncryptedValue {
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  mutate(bytes);
  return { ...envelope, ciphertext: bytes.toString("base64") };
}

const fixtureKey = Buffer.alloc(32, 9).toString("base64");

describe("Keyring", () => {
  it("loads a base64 fixture and encrypts with the current key", () => {
    const keyring = Keyring.fromJSON({
      version: 1,
      current: "k1",
      keys: { k1: fixtureKey },
    });

    expect(keyring.currentId).toBe("k1");
    expect(keyring.withCurrentKey((key) => key.equals(Buffer.alloc(32, 9)))).toBe(true);
  });

  it("redacts serialization and inspection", () => {
    const keyring = Keyring.fromJSON({
      version: 1,
      current: "k1",
      keys: { k1: fixtureKey },
    });

    expect(JSON.stringify(keyring)).toBe('{"version":1,"current":"k1","keyIds":["k1"]}');
    expect(inspect(keyring)).toBe("Keyring(current=k1, keys=1, redacted)");
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
    expect(decryptValue(envelope, keyring, aad, limits).toString("utf8")).toBe(
      plaintext.toString("utf8"),
    );
  });

  it("rejects a tampered ciphertext", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    const tampered = withCiphertext(envelope, (bytes) => {
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    });
    expect(() => decryptValue(tampered, keyring, aad, limits)).toThrow(CryptoIntegrityError);
  });

  it("rejects a different AAD", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() =>
      decryptValue(envelope, keyring, { ...aad, projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }, limits),
    ).toThrow(CryptoIntegrityError);
  });

  it("rejects a different KEK with the same id", () => {
    const envelope = encryptValue(Buffer.from("value"), Keyring.generate("k1"), aad);
    expect(() => decryptValue(envelope, Keyring.generate("k1"), aad, limits)).toThrow(
      CryptoIntegrityError,
    );
  });

  it("rejects moving an envelope to another object", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() =>
      decryptValue(envelope, keyring, { ...aad, objectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }, limits),
    ).toThrow(CryptoIntegrityError);
  });

  it("rejects malformed envelopes before decryption", () => {
    const keyring = Keyring.generate();
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    expect(() => decryptValue({ ...envelope, nonce: "AA==" }, keyring, aad, limits)).toThrow(
      CryptoInputError,
    );
  });

  it("maps an unknown key identifier to an integrity error", () => {
    const keyring = Keyring.generate("k1");
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);

    expect(() => decryptValue({ ...envelope, kekId: "k9" }, keyring, aad, limits)).toThrow(
      CryptoIntegrityError,
    );
  });

  it("keeps a destroyed-keyring error distinct from integrity failure", () => {
    const keyring = Keyring.generate("k1");
    const envelope = encryptValue(Buffer.from("value"), keyring, aad);
    keyring.destroy();

    expect(() => decryptValue(envelope, keyring, aad, limits)).toThrow(KeyringError);
  });
});

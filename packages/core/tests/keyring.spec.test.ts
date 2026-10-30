import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Keyring, KeyringError } from "../src/index.js";

function base64Key(fill = 1): string {
  return Buffer.alloc(32, fill).toString("base64");
}

function validKeyringJson(): Record<string, unknown> {
  return {
    version: 1,
    current: "k1",
    keys: { k1: base64Key(1) },
  };
}

describe("ST-11 keyring validation", () => {
  it("rejects malformed JSON shapes and versions", () => {
    expect(() => Keyring.fromJSON(null)).toThrow(KeyringError);
    expect(() => Keyring.fromJSON("not-an-object")).toThrow(KeyringError);
    expect(() => Keyring.fromJSON({ ...validKeyringJson(), version: 2 })).toThrow(KeyringError);
    expect(() => Keyring.fromJSON({ version: 1, keys: { k1: base64Key() } })).toThrow(
      KeyringError,
    );
    expect(() => Keyring.fromJSON({ version: 1, current: "k1" })).toThrow(KeyringError);
    expect(() =>
      Keyring.fromJSON({ version: 1, current: "k1", keys: {} }),
    ).toThrow(KeyringError);
  });

  it("rejects a missing current key and wrong key lengths", () => {
    expect(() =>
      Keyring.fromJSON({ version: 1, current: "k2", keys: { k1: base64Key() } }),
    ).toThrow(KeyringError);
    expect(() =>
      Keyring.fromJSON({ version: 1, current: "k1", keys: { k1: randomBytes(16).toString("base64") } }),
    ).toThrow(KeyringError);
  });

  it("rejects unsafe and malformed key identifiers", () => {
    for (const id of ["__proto__", "constructor", "prototype", "", "bad id", "x".repeat(65)]) {
      const value = JSON.parse(
        JSON.stringify({ version: 1, current: "k1", keys: { k1: base64Key(), [id]: base64Key() } }),
      );

      expect(() => Keyring.fromJSON(value)).toThrow(KeyringError);
    }
  });

  it("rejects non-canonical or malformed base64", () => {
    for (const encoded of ["not base64!", "AAAA", `${base64Key()}garbage`]) {
      expect(() =>
        Keyring.fromJSON({ version: 1, current: "k1", keys: { k1: encoded } }),
      ).toThrow(KeyringError);
    }
  });
});

describe("ST-12 redacted serialization and inspection", () => {
  it("never emits key bytes from JSON.stringify", () => {
    const keyring = Keyring.fromJSON(validKeyringJson());
    const serialized = JSON.stringify(keyring);

    expect(serialized).not.toContain(base64Key(1));
    expect(serialized).not.toContain("Buffer");
    expect(serialized).not.toContain("keys");
    expect(JSON.parse(serialized)).toEqual({ version: 1, current: "k1", keyIds: ["k1"] });
  });

  it("never emits key bytes or the internal map from util.inspect", () => {
    const keyring = Keyring.fromJSON(validKeyringJson());
    const printed = inspect(keyring);

    expect(printed).toBe("Keyring(current=k1, keys=1, redacted)");
    expect(printed).not.toContain(base64Key(1));
  });
});

describe("ST-13 callback access and destruction", () => {
  it("provides scoped access to the current and historical keys", () => {
    const keyring = Keyring.fromJSON({
      version: 1,
      current: "k2",
      keys: { k1: base64Key(1), k2: base64Key(2) },
    });

    expect(keyring.currentId).toBe("k2");
    expect(keyring.withCurrentKey((key) => key[0])).toBe(2);
    expect(keyring.withKey("k1", (key) => key[0])).toBe(1);
    expect(keyring.has("k1")).toBe(true);
    expect(keyring.has("missing")).toBe(false);
    expect(() => keyring.withKey("missing", () => undefined)).toThrow(KeyringError);
  });

  it("makes destroy idempotent and rejects later access", () => {
    const keyring = Keyring.fromJSON(validKeyringJson());

    keyring.destroy();
    keyring.destroy();

    expect(() => keyring.withCurrentKey(() => undefined)).toThrow(KeyringError);
    expect(() => keyring.withKey("k1", () => undefined)).toThrow(KeyringError);
    expect(keyring.has("k1")).toBe(false);
  });

  it("does not return a buffer that the caller can retain", () => {
    const keyring = Keyring.fromJSON(validKeyringJson());
    let observedLength = 0;

    const result = keyring.withCurrentKey((key) => {
      observedLength = key.length;
      return key.toString("hex");
    });

    expect(observedLength).toBe(32);
    expect(result).toBe(Buffer.alloc(32, 1).toString("hex"));
  });
});

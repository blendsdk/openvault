import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Keyring, KeyringError } from "../src/index.js";

function keyring(): Keyring {
  return Keyring.fromJSON({
    version: 1,
    current: "k1",
    keys: { k1: Buffer.alloc(32, 3).toString("base64") },
  });
}

describe("keyring internals", () => {
  it("rejects a prototype key identifier on direct access", () => {
    const ring = keyring();

    expect(() => ring.withKey("__proto__", () => undefined)).toThrow(KeyringError);
  });

  it("clears the serialized key list after destroy", () => {
    const ring = keyring();

    ring.destroy();

    expect(ring.toJSON()).toEqual({ version: 1, current: "k1", keyIds: [] });
    expect(inspect(ring)).toBe("Keyring(current=k1, keys=0, redacted)");
  });

  it("rejects base64 without canonical padding", () => {
    const unpadded = Buffer.alloc(32, 3).toString("base64").replace(/=+$/, "");

    expect(() => Keyring.fromJSON({ version: 1, current: "k1", keys: { k1: unpadded } })).toThrow(
      KeyringError,
    );
  });

  it("rejects access after destroy without exposing key state", () => {
    const ring = keyring();
    ring.destroy();

    expect(() => ring.withCurrentKey(() => undefined)).toThrow(/destroyed/i);
    expect(ring.has("k1")).toBe(false);
  });

  it("does not expose key bytes through generic inspection or cloning", () => {
    const ring = keyring();
    const encoded = Buffer.alloc(32, 3).toString("base64");

    expect(inspect(ring, { customInspect: false })).not.toContain(encoded);
    expect(JSON.stringify(structuredClone(ring))).not.toContain(encoded);
  });
});

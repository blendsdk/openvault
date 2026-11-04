import { describe, expect, it } from "vitest";
import { type CanonicalValue, canonicalJson } from "../../src/audit/canonical-json.js";
import { CanonicalJsonError } from "../../src/audit/errors.js";
import { computeEventHash, computeEventHmac } from "../../src/audit/hashing.js";

/** Nests objects to the requested number of container levels. */
function nest(levels: number): CanonicalValue {
  let value: CanonicalValue = "leaf";
  for (let index = 0; index < levels; index += 1) {
    value = { child: value };
  }
  return value;
}

describe("canonical JSON", () => {
  it("should sort object keys when serializing", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("should serialize nested arrays and objects without whitespace", () => {
    expect(canonicalJson({ z: [{ b: true, a: null }], a: "x" })).toBe(
      '{"a":"x","z":[{"a":null,"b":true}]}',
    );
  });

  it("should escape a quote inside a string", () => {
    expect(canonicalJson({ s: 'a"b' })).toBe('{"s":"a\\"b"}');
  });

  it("should reject a lone surrogate", () => {
    expect(() => canonicalJson({ s: "\uD800" })).toThrow(CanonicalJsonError);
  });

  it("should reject undefined, functions, and bigints", () => {
    expect(() => canonicalJson(undefined as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson((() => undefined) as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1n as never)).toThrow(CanonicalJsonError);
  });

  it("should reject non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(CanonicalJsonError);
  });

  it("should reject an object nested nine levels deep", () => {
    expect(canonicalJson(nest(8))).toBeTypeOf("string");
    expect(() => canonicalJson(nest(9))).toThrow(CanonicalJsonError);
  });

  it("should hash the raw previous-hash bytes followed by the canonical UTF-8 string", () => {
    const canonical = '{"a":1}';
    const previousHash = Buffer.alloc(32, 0);
    const key = Buffer.alloc(32, 1);

    const hash = computeEventHash(canonical, previousHash);
    const hmac = computeEventHmac(key, hash);

    expect(hash.toString("hex")).toBe(
      "b06a229070741292512e8760f470dd7a4c46ccfdf253df781d88dabe58c1ccb1",
    );
    expect(hmac.toString("hex")).toBe(
      "8c7b84a570485cb48ee49ba770b376011aa92022a3e866b8a62bc0fc494093e0",
    );
  });
});

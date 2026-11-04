import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/audit/canonical-json.js";
import { CanonicalJsonError } from "../../src/audit/errors.js";

describe("canonical JSON internals", () => {
  it("should order uppercase and lowercase keys with the default comparison", () => {
    expect(canonicalJson({ B: 1, a: 2, A: 3, b: 4 })).toBe('{"A":3,"B":1,"a":2,"b":4}');
  });

  it("should escape control characters and newlines", () => {
    const value = "a\n\t\u0001";
    expect(canonicalJson({ s: value })).toBe(`{"s":${JSON.stringify(value)}}`);
  });

  it("should serialize arrays without whitespace and in input order", () => {
    expect(canonicalJson([3, { b: 1, a: 2 }, true, null])).toBe('[3,{"a":2,"b":1},true,null]');
  });

  it("should reject a self-referencing object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it("should reject non-plain objects", () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Uint8Array([1, 2]))).toThrow(CanonicalJsonError);
  });

  it("should reject a null character", () => {
    expect(() => canonicalJson({ s: "a\u0000b" })).toThrow(CanonicalJsonError);
  });

  it("should reject output above the 64 KiB bound", () => {
    expect(() => canonicalJson("x".repeat(70_000))).toThrow(CanonicalJsonError);
  });
});

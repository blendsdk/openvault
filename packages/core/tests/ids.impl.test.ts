import { describe, expect, it } from "vitest";
import { isUlid, newUlid, ULID_PATTERN } from "../src/index.js";

describe("ULID boundaries", () => {
  it("should accept the lower and upper ends of the allowed alphabet", () => {
    expect(isUlid("0".repeat(26))).toBe(true);
    expect(isUlid("Z".repeat(26))).toBe(true);
  });

  it("should reject whitespace, lowercase, and Unicode lookalikes", () => {
    expect(isUlid(" 01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV ")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV\n")).toBe(false);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA\u0130")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA\u{1F512}")).toBe(false);
  });

  it("should not keep state between checks when the shared pattern is reused", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(ULID_PATTERN.test("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });
});

const MAX_TIMESTAMP = (1n << 48n) - 1n;

describe("newUlid implementation", () => {
  it("should encode the maximum 48-bit timestamp", () => {
    const value = newUlid(Number(MAX_TIMESTAMP));

    expect(isUlid(value)).toBe(true);
    expect(value.slice(0, 10)).toBe("7ZZZZZZZZZ");
  });

  it("should reject a timestamp above the 48-bit range", () => {
    expect(() => newUlid(Number(MAX_TIMESTAMP) + 1)).toThrow(/48-bit/);
  });

  it("should floor a fractional timestamp", () => {
    const value = newUlid(1_700_000_000_000.9);
    const integer = newUlid(1_700_000_000_000);

    expect(value.slice(0, 10)).toBe(integer.slice(0, 10));
  });

  it("should produce a random suffix rather than a fixed value", () => {
    const values = new Set(Array.from({ length: 32 }, () => newUlid(1_700_000_000_000)));

    expect(values.size).toBe(32);
  });

  it("should reject NaN and infinities", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => newUlid(value)).toThrow();
    }
  });
});

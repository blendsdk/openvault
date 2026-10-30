import { describe, expect, it } from "vitest";
import { isUlid, newUlid } from "../src/index.js";

describe("isUlid", () => {
  it("should accept a canonical 26-character ULID when the value uses the allowed alphabet", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  it("should reject non-string values", () => {
    for (const value of [null, undefined, 123, {}, [], true]) {
      expect(isUlid(value)).toBe(false);
    }
  });

  it("should reject values that contain an ambiguous alphabet character", () => {
    for (const character of ["I", "L", "O", "U"]) {
      expect(isUlid(`01ARZ3NDEKTSV4RRFFQ69G5FA${character}`)).toBe(false);
    }
  });

  it("should reject values that are shorter or longer than 26 characters", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVX")).toBe(false);
  });

  it("should reject an empty string", () => {
    expect(isUlid("")).toBe(false);
  });
});

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Decodes the 10-character Crockford timestamp prefix of a ULID into milliseconds. */
function decodeTimestampPrefix(ulid: string): number {
  let timestamp = 0;
  for (const character of ulid.slice(0, 10)) {
    timestamp = timestamp * 32 + CROCKFORD.indexOf(character);
  }
  return timestamp;
}

describe("newUlid", () => {
  it("should return a 26-character value from the Crockford alphabet", () => {
    const value = newUlid(1_700_000_000_000);

    expect(value).toHaveLength(26);
    expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(value)).toBe(true);
  });

  it("should encode the supplied timestamp in the first 10 characters", () => {
    const now = 1_700_000_000_000;

    expect(decodeTimestampPrefix(newUlid(now))).toBe(now);
  });

  it("should keep the timestamp prefix stable and the values different for the same timestamp", () => {
    const now = 1_700_000_000_000;
    const first = newUlid(now);
    const second = newUlid(now);

    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
    expect(first).not.toBe(second);
  });

  it("should order the timestamp prefix with time", () => {
    const earlier = newUlid(1_700_000_000_000);
    const later = newUlid(1_700_000_001_000);

    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });

  it("should generate a valid value with the current time by default", () => {
    const first = newUlid();
    const second = newUlid();

    expect(isUlid(first)).toBe(true);
    expect(isUlid(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("should reject a negative or non-finite timestamp", () => {
    // A valid timestamp must succeed first, so a rejection below is not a missing function.
    expect(isUlid(newUlid(1_700_000_000_000))).toBe(true);

    for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => newUlid(now)).toThrow();
    }
  });
});

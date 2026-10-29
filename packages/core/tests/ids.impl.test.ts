import { describe, expect, it } from "vitest";
import { isUlid, ULID_PATTERN } from "../src/index.js";

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

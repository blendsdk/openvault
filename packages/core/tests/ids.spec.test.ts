import { describe, expect, it } from "vitest";
import { isUlid } from "../src/index.js";

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

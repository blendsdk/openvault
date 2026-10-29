import { describe, expect, it } from "vitest";
import { projectNameSchema, secretNameSchema } from "../src/index.js";

describe("projectNameSchema", () => {
  it("should accept names that start and end with an alphanumeric character", () => {
    for (const name of ["abc", "a-b-c", "a1-b2", "abc-d"]) {
      expect(projectNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("should reject names that are too short, have invalid characters, or have invalid edges", () => {
    for (const name of ["ab", "A-Project", "-abc", "abc-", "a_b", "a".repeat(41)]) {
      expect(projectNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("secretNameSchema", () => {
  it("should accept alphanumeric names with internal hyphens", () => {
    for (const name of ["db-password", "A1", "a".repeat(127)]) {
      expect(secretNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("should reject path separators, traversal text, NUL, and oversized names", () => {
    for (const name of ["team/db", "..", "a\0b", "a".repeat(128)]) {
      expect(secretNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

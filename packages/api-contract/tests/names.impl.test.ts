import { describe, expect, it } from "vitest";
import { projectNameSchema, secretNameSchema } from "../src/index.js";

describe("project name boundaries", () => {
  it("should accept the minimum and maximum lengths", () => {
    expect(projectNameSchema.safeParse("abc").success).toBe(true);
    expect(projectNameSchema.safeParse("a".repeat(40)).success).toBe(true);
  });

  it("should reject one character below or above the length bounds", () => {
    expect(projectNameSchema.safeParse("ab").success).toBe(false);
    expect(projectNameSchema.safeParse("a".repeat(41)).success).toBe(false);
  });

  it("should reject non-ASCII and whitespace characters", () => {
    expect(projectNameSchema.safeParse("prøject").success).toBe(false);
    expect(projectNameSchema.safeParse("project ").success).toBe(false);
  });
});

describe("secret name boundaries", () => {
  it("should accept a single character and the maximum length", () => {
    expect(secretNameSchema.safeParse("a").success).toBe(true);
    expect(secretNameSchema.safeParse("a".repeat(127)).success).toBe(true);
  });

  it("should reject an empty name and one character above the maximum", () => {
    expect(secretNameSchema.safeParse("").success).toBe(false);
    expect(secretNameSchema.safeParse("a".repeat(128)).success).toBe(false);
  });

  it("should accept a trailing hyphen because that name is still path-safe", () => {
    expect(secretNameSchema.safeParse("database-").success).toBe(true);
  });

  it("should reject non-ASCII and whitespace characters", () => {
    expect(secretNameSchema.safeParse("secret-ø").success).toBe(false);
    expect(secretNameSchema.safeParse("secret name").success).toBe(false);
  });
});

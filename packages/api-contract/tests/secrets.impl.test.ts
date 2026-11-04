import { describe, expect, it } from "vitest";
import {
  secretContentTypeSchema,
  secretCreateRequestSchema,
  secretListQuerySchema,
  secretTagKeySchema,
  secretTagsSchema,
  secretTagValueSchema,
} from "../src/index.js";

describe("secret contract internals", () => {
  it("should bound tag keys and values", () => {
    expect(secretTagKeySchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(secretTagKeySchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(secretTagValueSchema.safeParse("a".repeat(256)).success).toBe(true);
    expect(secretTagValueSchema.safeParse("a".repeat(257)).success).toBe(false);
  });

  it("should reject control characters in tags and content types", () => {
    expect(secretTagKeySchema.safeParse("bad\u0001key").success).toBe(false);
    expect(secretTagValueSchema.safeParse("bad\nvalue").success).toBe(false);
    expect(secretContentTypeSchema.safeParse("text/\u0001plain").success).toBe(false);
  });

  it("should reject a non-object tag map", () => {
    expect(secretTagsSchema.safeParse(["a"]).success).toBe(false);
  });

  it("should reject a control character in the search query", () => {
    expect(secretListQuerySchema.safeParse({ q: "bad\u0001name" }).success).toBe(false);
  });

  it("should reject an unknown create field", () => {
    expect(
      secretCreateRequestSchema.safeParse({ name: "db-password", value: "x", extra: true }).success,
    ).toBe(false);
  });
});

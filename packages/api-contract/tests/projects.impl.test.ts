import { describe, expect, it } from "vitest";
import {
  projectCreateRequestSchema,
  projectListSchema,
  projectUpdateRequestSchema,
} from "../src/index.js";

describe("project contract internals", () => {
  it("should reject a project name outside the published pattern", () => {
    for (const name of ["ab", "a".repeat(41), "-payments", "payments-", "pay_ments"]) {
      expect(projectCreateRequestSchema.safeParse({ name }).success).toBe(false);
    }
  });

  it("should accept the shortest and longest project names", () => {
    expect(projectCreateRequestSchema.safeParse({ name: "abc" }).success).toBe(true);
    expect(projectCreateRequestSchema.safeParse({ name: "a".repeat(40) }).success).toBe(true);
  });

  it("should reject an unknown update field", () => {
    expect(
      projectUpdateRequestSchema.safeParse({ name: "payments", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })
        .success,
    ).toBe(false);
  });

  it("should reject a malformed project list", () => {
    expect(projectListSchema.safeParse({ projects: [{ id: "bad" }] }).success).toBe(false);
  });
});

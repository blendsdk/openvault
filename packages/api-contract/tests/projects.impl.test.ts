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

  it("should require a non-negative certificate count on list items", () => {
    const project = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "payments",
      createdAt: "2026-11-04T12:00:00.000Z",
      updatedAt: "2026-11-04T12:00:00.000Z",
      deletedAt: null,
    };
    expect(
      projectListSchema.safeParse({ projects: [{ ...project, certificateCount: 0 }] }).success,
    ).toBe(true);
    expect(
      projectListSchema.safeParse({ projects: [{ ...project, certificateCount: -1 }] }).success,
    ).toBe(false);
    expect(projectListSchema.safeParse({ projects: [project] }).success).toBe(false);
  });
});

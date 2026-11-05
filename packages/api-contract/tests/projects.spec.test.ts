import { describe, expect, it } from "vitest";
import {
  projectCreateRequestSchema,
  projectListSchema,
  projectSchema,
  projectUpdateRequestSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-11-04T12:00:00.000Z";

describe("project contracts", () => {
  it("should accept a project name without a display name", () => {
    expect(projectCreateRequestSchema.parse({ name: "payments" })).toEqual({ name: "payments" });
  });

  it("should reject an uppercase project name", () => {
    expect(projectCreateRequestSchema.safeParse({ name: "Payments" }).success).toBe(false);
  });

  it("should reject an empty project update", () => {
    expect(projectUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("should reject unknown project fields", () => {
    expect(
      projectCreateRequestSchema.safeParse({ name: "payments", displayName: "Payments" }).success,
    ).toBe(false);
  });

  it("should parse a project summary and list", () => {
    const project = projectSchema.parse({
      id: ULID,
      name: "payments",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      deletedAt: null,
    });
    expect(
      projectListSchema.parse({ projects: [{ ...project, certificateCount: 0 }] }).projects,
    ).toHaveLength(1);
  });

  it("should reject a project summary with a value field", () => {
    expect(
      projectSchema.safeParse({
        id: ULID,
        name: "payments",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        deletedAt: null,
        value: "secret",
      }).success,
    ).toBe(false);
  });
});

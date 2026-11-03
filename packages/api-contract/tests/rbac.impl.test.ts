import { describe, expect, it } from "vitest";
import {
  accessExplainQuerySchema,
  assignmentCreateRequestSchema,
  assignmentListQuerySchema,
  RBAC_ACTIONS,
  RBAC_ROLES,
  rbacScopeTypeSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("RBAC enum boundaries", () => {
  it("should expose immutable action and role tuples", () => {
    expect(RBAC_ACTIONS).toHaveLength(25);
    expect(RBAC_ROLES).toHaveLength(9);
    expect(rbacScopeTypeSchema.options).toEqual(["org", "project", "object"]);
  });

  it("should accept the 26-character scope id boundary and reject 27", () => {
    const base = {
      principalId: ULID,
      role: "secrets.reader" as const,
      scopeType: "object" as const,
    };
    expect(assignmentCreateRequestSchema.safeParse({ ...base, scopeId: OTHER_ULID }).success).toBe(
      true,
    );
    expect(
      assignmentCreateRequestSchema.safeParse({ ...base, scopeId: "A".repeat(27) }).success,
    ).toBe(false);
  });
});

describe("query boundaries", () => {
  it("should require project or object scope for data-plane actions", () => {
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "org",
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "assignment.read",
        scopeType: "org",
      }).success,
    ).toBe(true);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "project",
        scopeId: ULID,
        objectType: "secret",
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "object",
        scopeId: ULID,
        objectType: "secret",
      }).success,
    ).toBe(true);
  });

  it("should reject an empty assignment list scope id", () => {
    expect(assignmentListQuerySchema.safeParse({ scopeId: "" }).success).toBe(false);
  });
});

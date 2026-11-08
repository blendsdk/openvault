import { describe, expect, it } from "vitest";
import {
  accessExplainQuerySchema,
  accessExplainResponseSchema,
  assignmentCreateRequestSchema,
  assignmentListQuerySchema,
  assignmentSchema,
  capabilityFlagsSchema,
  roleCatalogSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TIMESTAMP = "2026-11-03T12:00:00.000Z";
const FUTURE_TIMESTAMP = "2099-01-01T00:00:00.000Z";

describe("assignmentCreateRequestSchema", () => {
  it("should accept a valid tuple and reject unknown or missing fields", () => {
    const valid = {
      principalId: ULID,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: OTHER_ULID,
    };
    expect(assignmentCreateRequestSchema.parse(valid)).toEqual(valid);

    expect(assignmentCreateRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        role: "secrets.reader",
        scopeType: "project",
        scopeId: OTHER_ULID,
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({ ...valid, principalId: "not-a-ulid" }).success,
    ).toBe(false);
  });

  it("should enforce the org and project/object scope id shapes", () => {
    const base = { principalId: ULID, role: "secrets.reader" as const };

    expect(
      assignmentCreateRequestSchema.safeParse({
        ...base,
        scopeType: "org",
        scopeId: "org",
      }).success,
    ).toBe(true);
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...base,
        scopeType: "org",
        scopeId: OTHER_ULID,
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...base,
        scopeType: "project",
        scopeId: "not-a-ulid",
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...base,
        scopeType: "object",
        scopeId: "not-a-ulid",
      }).success,
    ).toBe(false);
  });

  it("should accept an absent or valid expiry and reject an invalid timestamp", () => {
    const base = {
      principalId: ULID,
      role: "secrets.reader" as const,
      scopeType: "project" as const,
      scopeId: OTHER_ULID,
    };
    expect(assignmentCreateRequestSchema.parse(base).expiresAt).toBeUndefined();
    expect(
      assignmentCreateRequestSchema.parse({ ...base, expiresAt: FUTURE_TIMESTAMP }).expiresAt,
    ).toBe(FUTURE_TIMESTAMP);
    expect(
      assignmentCreateRequestSchema.safeParse({ ...base, expiresAt: "not-a-timestamp" }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...base,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    const orgBase = { ...base, scopeType: "org" as const, scopeId: "org" };
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...orgBase,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        ...orgBase,
        expiresAt: FUTURE_TIMESTAMP,
      }).success,
    ).toBe(true);
  });
});

describe("assignmentListQuerySchema", () => {
  it("should accept every documented filter", () => {
    expect(
      assignmentListQuerySchema.parse({
        principalId: ULID,
        role: "auditor",
        scopeType: "object",
        scopeId: OTHER_ULID,
      }),
    ).toEqual({
      principalId: ULID,
      role: "auditor",
      scopeType: "object",
      scopeId: OTHER_ULID,
    });
  });

  it("should reject an unknown field, an invalid role, or a non-ULID scope id", () => {
    expect(assignmentListQuerySchema.safeParse({ extra: true }).success).toBe(false);
    expect(assignmentListQuerySchema.safeParse({ role: "root" }).success).toBe(false);
    expect(assignmentListQuerySchema.safeParse({ scopeId: "not-a-ulid" }).success).toBe(false);
    expect(
      assignmentListQuerySchema.safeParse({ scopeType: "project", scopeId: "not-a-ulid" }).success,
    ).toBe(false);
    expect(assignmentListQuerySchema.safeParse({ scopeType: "org", scopeId: "org" }).success).toBe(
      true,
    );
  });
});

describe("accessExplainQuerySchema", () => {
  it("should require an action and enforce the scope shape", () => {
    expect(accessExplainQuerySchema.safeParse({}).success).toBe(false);
    expect(accessExplainQuerySchema.safeParse({ action: "secret.read" }).success).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "project",
        scopeId: OTHER_ULID,
      }).success,
    ).toBe(true);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "org",
        scopeId: "org",
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "org",
        scopeId: OTHER_ULID,
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "secret.read",
        scopeType: "object",
        scopeId: "not-a-ulid",
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "identity.read",
        scopeId: OTHER_ULID,
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "certificate.write",
        scopeType: "org",
        scopeId: "org",
      }).success,
    ).toBe(false);
    expect(
      accessExplainQuerySchema.safeParse({
        action: "kek.rotate",
        scopeType: "org",
        scopeId: "org",
      }).success,
    ).toBe(true);
  });
});

describe("response schemas", () => {
  it("should accept a complete assignment and reject a missing id", () => {
    const assignment = {
      id: ULID,
      principalId: OTHER_ULID,
      role: "project.admin",
      scopeType: "project",
      scopeId: ULID,
      grantedBy: OTHER_ULID,
      createdAt: TIMESTAMP,
      expiresAt: null,
    };
    expect(assignmentSchema.parse(assignment)).toEqual(assignment);
    const { id: _id, ...withoutId } = assignment;
    expect(assignmentSchema.safeParse(withoutId).success).toBe(false);
  });

  it("should accept a catalog and an explain response", () => {
    const catalog = {
      actions: [{ name: "project.read", plane: "control", description: "Read a project" }],
      roles: [{ name: "reader", actions: ["project.read"], scopes: ["org", "project"] }],
      policyVersion: 3,
    };
    expect(roleCatalogSchema.parse(catalog)).toEqual(catalog);

    const explain = {
      policyVersion: 3,
      action: "secret.read",
      scope: { type: "project", id: ULID },
      principals: [
        {
          principalId: OTHER_ULID,
          name: "payments-api",
          kind: "service",
          role: "secrets.reader",
          assignmentId: ULID,
          scopeType: "object",
          scopeId: OTHER_ULID,
          consumer: {
            composeProject: "payments",
            composeService: "api",
            hostname: "api-1",
            state: "ok",
            lastSeen: TIMESTAMP,
          },
        },
      ],
    };
    expect(accessExplainResponseSchema.parse(explain)).toEqual(explain);
  });

  it("should accept only the seven boolean capability flags", () => {
    const flags = {
      canRead: true,
      canWrite: false,
      canDelete: false,
      canRecover: false,
      canPurge: false,
      canManage: false,
      canReadPrivate: false,
    };
    expect(capabilityFlagsSchema.parse(flags)).toEqual(flags);
    expect(capabilityFlagsSchema.safeParse({ ...flags, canList: true }).success).toBe(false);
    expect(capabilityFlagsSchema.safeParse({ ...flags, canRead: "yes" }).success).toBe(false);
  });
});

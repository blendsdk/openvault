import { describe, expect, it } from "vitest";
import {
  secretCreateRequestSchema,
  secretListQuerySchema,
  secretMetadataSchema,
  secretTagsSchema,
  secretWriteResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VERSION = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TIMESTAMP = "2026-11-04T12:00:00.000Z";

const metadata = {
  id: ULID,
  projectId: ULID,
  name: "db-password",
  tags: {},
  contentType: "text/plain",
  status: "active" as const,
  currentVersion: {
    id: VERSION,
    createdAt: TIMESTAMP,
    createdBy: ULID,
    expiresAt: null,
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  deletedAt: null,
  purgeAfter: null,
  purgeProtected: false,
  consumers: [],
  capabilities: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canPurge: true,
    canManage: true,
  },
};

describe("secret contracts", () => {
  it("should apply the create defaults", () => {
    expect(secretCreateRequestSchema.parse({ name: "db-password", value: "x" })).toEqual({
      name: "db-password",
      value: "x",
      encoding: "utf8",
      contentType: "text/plain",
      tags: {},
    });
  });

  it("should reject a metadata object that contains a value", () => {
    expect(secretMetadataSchema.safeParse({ ...metadata, value: "secret" }).success).toBe(false);
  });

  it("should reject more than fifteen tags", () => {
    const tags = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`key-${index}`, "value"]),
    );
    expect(secretTagsSchema.safeParse(tags).success).toBe(false);
  });

  it("should default the list limit to fifty", () => {
    expect(secretListQuerySchema.parse({}).limit).toBe(50);
  });

  it("should reject a list limit above one hundred", () => {
    expect(secretListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("should reject a tag value without a tag key", () => {
    expect(secretListQuerySchema.safeParse({ tagValue: "prod" }).success).toBe(false);
  });

  it("should accept a write response with the written version", () => {
    expect(
      secretWriteResponseSchema.parse({ ...metadata, version: metadata.currentVersion }).version.id,
    ).toBe(VERSION);
  });

  it("should reject a write response without a version", () => {
    expect(secretWriteResponseSchema.safeParse({ ...metadata }).success).toBe(false);
  });
});

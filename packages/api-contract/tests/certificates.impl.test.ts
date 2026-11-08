import { describe, expect, it } from "vitest";
import {
  certificateImportRequestSchema,
  certificateListQuerySchema,
  certificateMetadataSchema,
  certificateSanSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("certificate contract internals", () => {
  it("should reject non-canonical SAN prefixes and out-of-bound values", () => {
    expect(certificateSanSchema.safeParse("DNS:example.test").success).toBe(true);
    expect(certificateSanSchema.safeParse("example.test").success).toBe(false);
    expect(certificateSanSchema.safeParse("DNS:").success).toBe(false);
    expect(certificateSanSchema.safeParse(`DNS:${"a".repeat(2_050)}`).success).toBe(false);
  });

  it("should reject unknown nested request fields", () => {
    expect(
      certificateImportRequestSchema.safeParse({
        name: "tls-server",
        certificatePem: "certificate",
        privateKeyPem: "key",
        metadata: { owner: "payments" },
      }).success,
    ).toBe(false);
  });

  it("should reject a metadata object containing a value or key", () => {
    const base = {
      id: ULID,
      projectId: ULID,
      name: "tls-server",
      tags: {},
      status: "active",
      subject: "CN=tls.example.test",
      sans: ["DNS:tls.example.test"],
      issuer: "CN=tls.example.test",
      serial: "01",
      fingerprint: "a".repeat(64),
      notBefore: "2026-11-04T12:00:00.000Z",
      notAfter: "2027-11-04T12:00:00.000Z",
      daysToExpiry: 365,
      chainLength: 1,
      version: {
        id: ULID,
        createdAt: "2026-11-04T12:00:00.000Z",
        createdBy: ULID,
        notBefore: "2026-11-04T12:00:00.000Z",
        notAfter: "2027-11-04T12:00:00.000Z",
        fingerprint: "a".repeat(64),
        serial: "01",
      },
      createdAt: "2026-11-04T12:00:00.000Z",
      updatedAt: "2026-11-04T12:00:00.000Z",
      deletedAt: null,
      purgeAfter: null,
      purgeProtected: false,
      capabilities: {
        canRead: true,
        canWrite: true,
        canDelete: true,
        canRecover: true,
        canPurge: true,
        canManage: false,
        canReadPrivate: true,
      },
    };
    expect(certificateMetadataSchema.safeParse({ ...base, value: "x" }).success).toBe(false);
    expect(certificateMetadataSchema.safeParse({ ...base, privateKeyPem: "key" }).success).toBe(
      false,
    );
  });

  it("should reject a malformed cursor", () => {
    expect(certificateListQuerySchema.safeParse({ cursor: "not a cursor" }).success).toBe(false);
    expect(certificateListQuerySchema.safeParse({ cursor: "abc_-123" }).success).toBe(true);
  });
});

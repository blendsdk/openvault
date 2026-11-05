import { describe, expect, it } from "vitest";
import {
  certificateGenerateRequestSchema,
  certificateImportRequestSchema,
  certificateListQuerySchema,
  certificateMetadataSchema,
  certificateTagsSchema,
  certificateWriteResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VERSION = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TIMESTAMP = "2026-11-04T12:00:00.000Z";

const metadata = {
  id: ULID,
  projectId: ULID,
  name: "tls-server",
  tags: {},
  status: "active" as const,
  subject: "CN=tls.example.test",
  sans: ["DNS:tls.example.test"],
  issuer: "CN=tls.example.test",
  serial: "01",
  fingerprint: "a".repeat(64),
  notBefore: TIMESTAMP,
  notAfter: "2027-11-04T12:00:00.000Z",
  daysToExpiry: 365,
  chainLength: 1,
  version: {
    id: VERSION,
    createdAt: TIMESTAMP,
    createdBy: ULID,
    notBefore: TIMESTAMP,
    notAfter: "2027-11-04T12:00:00.000Z",
    fingerprint: "a".repeat(64),
    serial: "01",
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  deletedAt: null,
  purgeAfter: null,
  purgeProtected: false,
  capabilities: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canPurge: true,
    canManage: false,
  },
};

describe("certificate contracts", () => {
  it("should apply import defaults", () => {
    const parsed = certificateImportRequestSchema.parse({
      name: "tls-server",
      certificatePem: "certificate",
      privateKeyPem: "key",
    });
    expect(parsed.allowNotYetValid).toBe(false);
    expect(parsed.chainPem).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
  });

  it("should apply generation defaults", () => {
    const parsed = certificateGenerateRequestSchema.parse({
      name: "tls-server",
      subject: "CN=tls.example.test",
      sans: ["DNS:tls.example.test"],
    });
    expect(parsed.keyType).toBe("ec-p256");
    expect(parsed.validityDays).toBe(365);
  });

  it("should reject a validity above 825 days", () => {
    expect(
      certificateGenerateRequestSchema.safeParse({
        name: "tls-server",
        subject: "CN=tls.example.test",
        sans: ["DNS:tls.example.test"],
        validityDays: 826,
      }).success,
    ).toBe(false);
  });

  it("should reject an unknown import field", () => {
    expect(
      certificateImportRequestSchema.safeParse({
        name: "tls-server",
        certificatePem: "certificate",
        privateKeyPem: "key",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("should reject metadata carrying a PEM body", () => {
    expect(
      certificateMetadataSchema.safeParse({ ...metadata, certificatePem: "pem" }).success,
    ).toBe(false);
  });

  it("should default the list limit to fifty and bound it", () => {
    expect(certificateListQuerySchema.parse({}).limit).toBe(50);
    expect(certificateListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(certificateListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("should reject an inverted expiry window", () => {
    expect(
      certificateListQuerySchema.safeParse({
        expiresAfter: "2027-01-02T00:00:00.000Z",
        expiresBefore: "2027-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("should reject an untyped or control-character SAN", () => {
    expect(
      certificateGenerateRequestSchema.safeParse({
        name: "tls-server",
        subject: "CN=tls.example.test",
        sans: ["tls.example.test"],
      }).success,
    ).toBe(false);
    expect(
      certificateGenerateRequestSchema.safeParse({
        name: "tls-server",
        subject: "CN=tls.example.test",
        sans: ["DNS:bad\u0001.test"],
      }).success,
    ).toBe(false);
  });

  it("should reject more than fifteen tags", () => {
    const tags = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`key-${index}`, "value"]),
    );
    expect(certificateTagsSchema.safeParse(tags).success).toBe(false);
  });

  it("should parse a write response with warnings", () => {
    expect(
      certificateWriteResponseSchema.parse({
        ...metadata,
        certificatePem: "pem",
        chainPem: "",
        warnings: [],
      }).warnings,
    ).toEqual([]);
  });
});

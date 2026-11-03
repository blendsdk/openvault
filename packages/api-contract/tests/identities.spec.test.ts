import { describe, expect, it } from "vitest";
import {
  identityCertificateSchema,
  identityConsumerSchema,
  identityCreateRequestSchema,
  identityDetailSchema,
  identityListQuerySchema,
  identityListSchema,
  identityNameSchema,
  identitySummarySchema,
  joinTokenCreateRequestSchema,
  joinTokenResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

const validSummary = {
  id: ULID,
  name: "payments-api",
  projectId: OTHER_ULID,
  status: "active" as const,
  createdAt: TIMESTAMP,
};

const validCertificate = {
  serial: "1a2b3c",
  fingerprint: "a".repeat(64),
  notBefore: TIMESTAMP,
  notAfter: TIMESTAMP,
  revokedAt: null,
};

const validConsumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
  state: "ok" as const,
  firstSeen: TIMESTAMP,
  lastSeen: TIMESTAMP,
  selfReported: true as const,
};

describe("identityNameSchema", () => {
  it("should trim and accept a service name", () => {
    expect(identityNameSchema.parse("  payments-api  ")).toBe("payments-api");
  });

  it("should enforce the 1 to 100 character boundary after trimming", () => {
    expect(identityNameSchema.safeParse("a").success).toBe(true);
    expect(identityNameSchema.safeParse("a".repeat(100)).success).toBe(true);

    for (const name of ["", "   ", "a".repeat(101)]) {
      expect(identityNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("should reject control characters and accept Unicode letters", () => {
    expect(identityNameSchema.safeParse("payments\u0007api").success).toBe(false);
    expect(identityNameSchema.safeParse("päyments-api").success).toBe(true);
  });

  it("should keep service names case-sensitive", () => {
    expect(identityNameSchema.parse("Payments-API")).toBe("Payments-API");
    expect(identityNameSchema.parse("payments-api")).not.toBe("Payments-API");
  });
});

describe("identityCreateRequestSchema", () => {
  it("should accept a name and project id and trim only the name", () => {
    const result = identityCreateRequestSchema.parse({
      name: "  payments-api ",
      projectId: OTHER_ULID,
    });

    expect(result).toEqual({ name: "payments-api", projectId: OTHER_ULID });
  });

  it("should accept an omitted project id for a service-level validation error", () => {
    expect(identityCreateRequestSchema.safeParse({ name: "payments-api" }).success).toBe(true);
  });

  it("should reject credential fields and unknown fields", () => {
    for (const extra of [
      { email: "service@example.test" },
      { password: "secret" },
      { kind: "service" },
      { status: "active" },
    ]) {
      expect(
        identityCreateRequestSchema.safeParse({
          name: "payments-api",
          projectId: OTHER_ULID,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("identityListQuerySchema", () => {
  it("should accept an absent or valid project id", () => {
    expect(identityListQuerySchema.parse({})).toEqual({});
    expect(identityListQuerySchema.parse({ projectId: OTHER_ULID })).toEqual({
      projectId: OTHER_ULID,
    });
  });

  it("should reject a malformed project id and unknown query fields", () => {
    expect(identityListQuerySchema.safeParse({ projectId: "not-a-ulid" }).success).toBe(false);
    expect(identityListQuerySchema.safeParse({ status: "active" }).success).toBe(false);
  });
});

describe("identity response contracts", () => {
  it("should accept a summary and reject extra credential/token fields", () => {
    expect(identitySummarySchema.safeParse(validSummary).success).toBe(true);

    for (const extra of [{ token: "secret" }, { passwordHash: "hash" }, { privateKey: "key" }]) {
      expect(identitySummarySchema.safeParse({ ...validSummary, ...extra }).success).toBe(false);
    }
  });

  it("should enforce certificate serial, fingerprint, and timestamp fields", () => {
    expect(identityCertificateSchema.safeParse(validCertificate).success).toBe(true);

    for (const certificate of [
      { ...validCertificate, fingerprint: "a".repeat(63) },
      { ...validCertificate, fingerprint: "A".repeat(64) },
      { ...validCertificate, serial: "" },
      { ...validCertificate, notAfter: "not-a-timestamp" },
    ]) {
      expect(identityCertificateSchema.safeParse(certificate).success).toBe(false);
    }
  });

  it("should require the consumer to be self-reported and reject unknown metadata", () => {
    expect(identityConsumerSchema.safeParse(validConsumer).success).toBe(true);
    expect(
      identityConsumerSchema.safeParse({ ...validConsumer, selfReported: false }).success,
    ).toBe(false);
    expect(
      identityConsumerSchema.safeParse({ ...validConsumer, assertedBy: "agent" }).success,
    ).toBe(false);
  });

  it("should accept identity detail with retained certificates and a consumer", () => {
    const detail = {
      ...validSummary,
      certificates: [validCertificate],
      consumer: validConsumer,
    };
    expect(identityDetailSchema.safeParse(detail).success).toBe(true);
    expect(identityListSchema.parse({ identities: [validSummary] })).toEqual({
      identities: [validSummary],
    });
  });
});

describe("join token contracts", () => {
  it("should accept absent or integer TTLs and leave the service range to the service", () => {
    expect(joinTokenCreateRequestSchema.parse({})).toEqual({});
    for (const ttlSeconds of [0, 1, 86_400, 86_401]) {
      expect(joinTokenCreateRequestSchema.safeParse({ ttlSeconds }).success).toBe(true);
    }
  });

  it("should reject fractional or unknown TTL fields", () => {
    expect(joinTokenCreateRequestSchema.safeParse({ ttlSeconds: 1.5 }).success).toBe(false);
    expect(joinTokenCreateRequestSchema.safeParse({ ttl: 60 }).success).toBe(false);
  });

  it("should require a 43-character base64url token in the response", () => {
    const response = {
      id: ULID,
      token: "a".repeat(43),
      expiresAt: TIMESTAMP,
    };
    expect(joinTokenResponseSchema.safeParse(response).success).toBe(true);

    for (const token of ["a".repeat(42), "a".repeat(44), `${"a".repeat(42)}+`]) {
      expect(joinTokenResponseSchema.safeParse({ ...response, token }).success).toBe(false);
    }
  });
});

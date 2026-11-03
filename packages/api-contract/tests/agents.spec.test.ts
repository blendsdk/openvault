import { describe, expect, it } from "vitest";
import {
  agentCertificateResponseSchema,
  agentConsumerSchema,
  agentJoinRequestSchema,
  agentRenewRequestSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

const consumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
};

describe("agentConsumerSchema", () => {
  it("should accept valid self-reported metadata", () => {
    expect(agentConsumerSchema.safeParse(consumer).success).toBe(true);
  });

  it("should reject unknown fields and invalid hostname/hash values", () => {
    for (const value of [
      { ...consumer, selfReported: true },
      { ...consumer, hostname: "api/1" },
      { ...consumer, manifestHash: "sha256:short" },
      { ...consumer, composeProject: "" },
      { ...consumer, composeService: "a".repeat(101) },
    ]) {
      expect(agentConsumerSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("agentJoinRequestSchema", () => {
  it("should accept a valid join envelope", () => {
    expect(
      agentJoinRequestSchema.safeParse({
        token: "a".repeat(43),
        csr: "-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----",
        consumer,
      }).success,
    ).toBe(true);
  });

  it("should accept in-bound token strings and leave 43-character validation to the service", () => {
    for (const token of ["a".repeat(42), "a".repeat(44), "x"]) {
      expect(
        agentJoinRequestSchema.safeParse({
          token,
          csr: "csr",
          consumer,
        }).success,
      ).toBe(true);
    }
  });

  it("should reject empty/over-128 token envelopes, missing CSR, and unknown fields", () => {
    for (const value of [
      { token: "", csr: "csr", consumer },
      { token: "a".repeat(129), csr: "csr", consumer },
      { token: "a".repeat(43), consumer },
      { token: "a".repeat(43), csr: "csr", consumer, extra: true },
      { token: "a".repeat(43), csr: "csr", consumer: { ...consumer, assertedBy: "agent" } },
    ]) {
      expect(agentJoinRequestSchema.safeParse(value).success).toBe(false);
    }
  });

  it("should reject an oversized CSR envelope", () => {
    expect(
      agentJoinRequestSchema.safeParse({
        token: "a".repeat(43),
        csr: "a".repeat(65_537),
        consumer,
      }).success,
    ).toBe(false);
  });
});

describe("agentRenewRequestSchema", () => {
  it("should accept a valid renew envelope", () => {
    expect(agentRenewRequestSchema.safeParse({ csr: "csr", consumer }).success).toBe(true);
  });

  it("should reject missing consumer, unknown fields, and oversized CSRs", () => {
    for (const value of [
      { csr: "csr" },
      { csr: "csr", consumer, token: "not-allowed" },
      { csr: "a".repeat(65_537), consumer },
    ]) {
      expect(agentRenewRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("agentCertificateResponseSchema", () => {
  it("should accept the certificate response without private-key fields", () => {
    const response = {
      certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      chainPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      identityId: ULID,
      serial: "1a2b3c",
      notAfter: TIMESTAMP,
    };
    const parsed = agentCertificateResponseSchema.parse(response);
    expect(parsed).toEqual(response);
    expect(Object.keys(parsed)).not.toContain("privateKey");
  });

  it("should reject unknown response fields and malformed values", () => {
    const response = {
      certificatePem: "certificate",
      chainPem: "chain",
      identityId: ULID,
      serial: "1a2b3c",
      notAfter: TIMESTAMP,
    };
    expect(
      agentCertificateResponseSchema.safeParse({ ...response, privateKey: "key" }).success,
    ).toBe(false);
    expect(
      agentCertificateResponseSchema.safeParse({ ...response, identityId: "bad" }).success,
    ).toBe(false);
    expect(agentCertificateResponseSchema.safeParse({ ...response, notAfter: "bad" }).success).toBe(
      false,
    );
  });
});

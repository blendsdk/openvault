import { describe, expect, it } from "vitest";
import {
  agentCertificateResponseSchema,
  agentJoinRequestSchema,
  agentRenewRequestSchema,
} from "../src/index.js";

const consumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
};
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

describe("agent contract internals", () => {
  it("should allow the exact token and CSR boundaries", () => {
    expect(
      agentJoinRequestSchema.safeParse({
        token: "x".repeat(128),
        csr: "c".repeat(65_536),
        consumer,
      }).success,
    ).toBe(true);
    expect(
      agentJoinRequestSchema.safeParse({
        token: "x".repeat(129),
        csr: "csr",
        consumer,
      }).success,
    ).toBe(false);
    expect(
      agentJoinRequestSchema.safeParse({
        token: "x",
        csr: "c".repeat(65_537),
        consumer,
      }).success,
    ).toBe(false);
  });

  it("should keep renew free of a token field", () => {
    expect(agentRenewRequestSchema.safeParse({ csr: "csr", consumer }).success).toBe(true);
    expect(agentRenewRequestSchema.safeParse({ csr: "csr", consumer, token: "x" }).success).toBe(
      false,
    );
  });

  it("should reject private-key and extra certificate response fields", () => {
    const response = {
      certificatePem: "certificate",
      chainPem: "chain",
      identityId: ULID,
      serial: "01",
      notAfter: TIMESTAMP,
    };
    expect(agentCertificateResponseSchema.safeParse(response).success).toBe(true);
    expect(
      agentCertificateResponseSchema.safeParse({ ...response, privateKey: "secret" }).success,
    ).toBe(false);
  });
});

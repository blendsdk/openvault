import { describe, expect, it } from "vitest";
import {
  identityCreateRequestSchema,
  identityDetailSchema,
  joinTokenCreateRequestSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

describe("identity contract internals", () => {
  it("should preserve strict-object rejection after the optional project extension", () => {
    expect(
      identityCreateRequestSchema.safeParse({ name: "service", projectId: undefined }).success,
    ).toBe(true);
    expect(
      identityCreateRequestSchema.safeParse({ name: "service", projectId: ULID, extra: 1 }).success,
    ).toBe(false);
  });

  it("should keep certificate arrays ordered as supplied", () => {
    const certificates = [
      {
        serial: "01",
        fingerprint: "a".repeat(64),
        notBefore: TIMESTAMP,
        notAfter: TIMESTAMP,
        revokedAt: null,
      },
      {
        serial: "02",
        fingerprint: "b".repeat(64),
        notBefore: TIMESTAMP,
        notAfter: TIMESTAMP,
        revokedAt: TIMESTAMP,
      },
    ];
    const detail = identityDetailSchema.parse({
      id: ULID,
      name: "service",
      projectId: ULID,
      status: "active",
      createdAt: TIMESTAMP,
      certificates,
      consumer: null,
    });

    expect(detail.certificates.map((certificate) => certificate.serial)).toEqual(["01", "02"]);
    expect(identityDetailSchema.safeParse({ ...detail, token: "secret" }).success).toBe(false);
    expect(
      identityDetailSchema.safeParse({
        ...detail,
        certificates: [{ ...certificates[0], extra: true }],
      }).success,
    ).toBe(false);
  });

  it("should leave TTL range checks to the service layer", () => {
    for (const ttlSeconds of [0, 86_401, -1]) {
      expect(joinTokenCreateRequestSchema.safeParse({ ttlSeconds }).success).toBe(true);
    }
  });
});

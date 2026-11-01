import { describe, expect, it } from "vitest";
import {
  cliLoginRequestSchema,
  cliLogoutRequestSchema,
  cliMeResponseSchema,
  cliRefreshRequestSchema,
  cliRefreshTokenSchema,
  cliSessionEntrySchema,
  cliSessionListSchema,
  cliTokenResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ACCESS_EXPIRES_AT = "2026-10-30T12:15:00.000Z";
const REFRESH_EXPIRES_AT = "2026-10-31T00:00:00.000Z";
const REFRESH_TOKEN = "A".repeat(43);

const validUser = {
  id: ULID,
  name: "Alice",
  email: "alice@example.com",
  authMethod: "local",
};

const validTokenResponse = {
  accessToken: "header.payload.signature",
  refreshToken: REFRESH_TOKEN,
  tokenType: "Bearer",
  accessExpiresAt: ACCESS_EXPIRES_AT,
  refreshExpiresAt: REFRESH_EXPIRES_AT,
  user: validUser,
  mustChangePassword: false,
};

const validMeResponse = {
  user: validUser,
  mustChangePassword: false,
};

const validSessionEntry = {
  id: ULID,
  createdAt: "2026-10-30T12:00:00.000Z",
  expiresAt: "2026-10-31T00:00:00.000Z",
  current: true,
};

describe("cliRefreshTokenSchema", () => {
  it("should accept exactly 43 unpadded base64url characters", () => {
    expect(cliRefreshTokenSchema.safeParse(REFRESH_TOKEN).success).toBe(true);
    expect(cliRefreshTokenSchema.safeParse("-".repeat(43)).success).toBe(true);
    expect(cliRefreshTokenSchema.safeParse("_".repeat(43)).success).toBe(true);
    expect(cliRefreshTokenSchema.safeParse(`${"a".repeat(42)}Z`).success).toBe(true);
  });

  it("should reject tokens that are not exactly 43 unpadded base64url characters", () => {
    const rejected = [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}=`,
      `${"A".repeat(41)}+=`,
      `${"A".repeat(42)}/`,
      `${"A".repeat(42)} `,
      "",
    ];

    for (const token of rejected) {
      expect(cliRefreshTokenSchema.safeParse(token).success, token).toBe(false);
    }
  });
});

describe("cliLoginRequestSchema", () => {
  it("should accept a padded identifier without changing its letter case", () => {
    const parsed = cliLoginRequestSchema.parse({
      identifier: " Alice@Example.com ",
      password: "x",
    });

    expect(parsed.identifier).toBe("Alice@Example.com");
    expect(parsed.identifier).not.toBe("alice@example.com");
  });

  it("should reject a login request with an unknown field", () => {
    expect(
      cliLoginRequestSchema.safeParse({
        identifier: "alice@example.com",
        password: "x",
        rememberMe: true,
      }).success,
    ).toBe(false);
  });

  it("should inherit the browser identifier and password bounds", () => {
    expect(
      cliLoginRequestSchema.safeParse({ identifier: "a".repeat(320), password: "x" }).success,
    ).toBe(true);
    expect(
      cliLoginRequestSchema.safeParse({ identifier: "alice", password: "x".repeat(1024) }).success,
    ).toBe(true);

    for (const request of [
      { identifier: "a".repeat(321), password: "x" },
      { identifier: "   ", password: "x" },
      { identifier: "alice", password: "" },
      { identifier: "alice", password: "x".repeat(1025) },
    ]) {
      expect(cliLoginRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe("cliTokenResponseSchema", () => {
  it("should accept a complete token response with distinct access and refresh expiry fields", () => {
    const parsed = cliTokenResponseSchema.parse(validTokenResponse);

    expect(parsed.tokenType).toBe("Bearer");
    expect(parsed.accessExpiresAt).toBe(ACCESS_EXPIRES_AT);
    expect(parsed.refreshExpiresAt).toBe(REFRESH_EXPIRES_AT);
    expect(parsed.refreshExpiresAt).not.toBe(parsed.accessExpiresAt);
    expect(parsed.user.authMethod).toBe("local");
  });

  it("should reject an unknown field on the token response", () => {
    for (const extra of [
      { expiresAt: ACCESS_EXPIRES_AT },
      { refreshHash: "hash" },
      { rowId: ULID },
      { accessTokenExpiresAt: ACCESS_EXPIRES_AT },
    ]) {
      expect(cliTokenResponseSchema.safeParse({ ...validTokenResponse, ...extra }).success).toBe(
        false,
      );
    }
  });

  it("should require the Bearer token type and both ISO expiry fields", () => {
    for (const response of [
      { ...validTokenResponse, tokenType: "bearer" },
      { ...validTokenResponse, tokenType: "JWT" },
      { ...validTokenResponse, accessExpiresAt: "2026-10-30" },
      { ...validTokenResponse, refreshExpiresAt: "not-a-timestamp" },
      { ...validTokenResponse, accessExpiresAt: undefined },
      { ...validTokenResponse, refreshExpiresAt: undefined },
    ]) {
      expect(cliTokenResponseSchema.safeParse(response).success).toBe(false);
    }
  });

  it("should require a non-empty access token, a valid refresh token, and a boolean change flag", () => {
    for (const response of [
      { ...validTokenResponse, accessToken: "" },
      { ...validTokenResponse, accessToken: undefined },
      { ...validTokenResponse, refreshToken: "A".repeat(42) },
      { ...validTokenResponse, refreshToken: undefined },
      { ...validTokenResponse, mustChangePassword: "false" },
    ]) {
      expect(cliTokenResponseSchema.safeParse(response).success).toBe(false);
    }
  });
});

describe("cliRefreshRequestSchema", () => {
  it("should accept a well-formed refresh token", () => {
    expect(cliRefreshRequestSchema.safeParse({ refreshToken: REFRESH_TOKEN }).success).toBe(true);
  });

  it("should reject an unknown field and a malformed refresh token", () => {
    for (const request of [
      { refreshToken: REFRESH_TOKEN, accessToken: "header.payload.signature" },
      { refreshToken: "A".repeat(42) },
      { refreshToken: `${"A".repeat(42)}=` },
      {},
    ]) {
      expect(cliRefreshRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe("cliLogoutRequestSchema", () => {
  it("should accept a well-formed refresh token", () => {
    expect(cliLogoutRequestSchema.safeParse({ refreshToken: REFRESH_TOKEN }).success).toBe(true);
  });

  it("should reject an unknown field and a malformed refresh token", () => {
    for (const request of [
      { refreshToken: REFRESH_TOKEN, reason: "done" },
      { refreshToken: "A".repeat(44) },
      { refreshToken: `${"A".repeat(42)}+` },
      {},
    ]) {
      expect(cliLogoutRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe("cliMeResponseSchema", () => {
  it("should accept the public user and the forced-change flag", () => {
    expect(cliMeResponseSchema.safeParse(validMeResponse).success).toBe(true);
    expect(
      cliMeResponseSchema.safeParse({ ...validMeResponse, mustChangePassword: true }).success,
    ).toBe(true);
    expect(
      cliMeResponseSchema.safeParse({ ...validMeResponse, user: { ...validUser, email: null } })
        .success,
    ).toBe(true);
  });

  it("should have no field for hashes, tokens, or row identifiers", () => {
    expect(Object.keys(cliMeResponseSchema.shape).sort()).toEqual(["mustChangePassword", "user"]);

    for (const field of [
      "refreshHash",
      "refresh_hash",
      "token",
      "accessToken",
      "refreshToken",
      "rowId",
      "row_id",
      "sessionId",
    ]) {
      expect(
        cliMeResponseSchema.safeParse({ ...validMeResponse, [field]: "value" }).success,
        field,
      ).toBe(false);
    }
  });

  it("should reject a non-boolean change flag and an invalid user", () => {
    for (const response of [
      { ...validMeResponse, mustChangePassword: "false" },
      { ...validMeResponse, user: { ...validUser, id: "not-a-ulid" } },
      { ...validMeResponse, user: { ...validUser, authMethod: "ldap" } },
      { ...validMeResponse, user: undefined },
    ]) {
      expect(cliMeResponseSchema.safeParse(response).success).toBe(false);
    }
  });
});

describe("cliSessionEntrySchema", () => {
  it("should accept a complete CLI session entry", () => {
    expect(cliSessionEntrySchema.safeParse(validSessionEntry).success).toBe(true);
    expect(cliSessionEntrySchema.safeParse({ ...validSessionEntry, current: false }).success).toBe(
      true,
    );
  });

  it("should have no field for hashes, tokens, or row identifiers", () => {
    expect(Object.keys(cliSessionEntrySchema.shape).sort()).toEqual([
      "createdAt",
      "current",
      "expiresAt",
      "id",
    ]);

    for (const field of [
      "refreshHash",
      "refresh_hash",
      "token",
      "accessToken",
      "refreshToken",
      "rowId",
      "row_id",
      "sessionId",
    ]) {
      expect(
        cliSessionEntrySchema.safeParse({ ...validSessionEntry, [field]: "value" }).success,
        field,
      ).toBe(false);
    }
  });

  it("should reject a non-ULID id, non-ISO timestamps, and a non-boolean current flag", () => {
    for (const entry of [
      { ...validSessionEntry, id: "not-a-ulid" },
      { ...validSessionEntry, id: OTHER_ULID, current: "true" },
      { ...validSessionEntry, createdAt: "2026-10-30" },
      { ...validSessionEntry, expiresAt: "not-a-timestamp" },
      { ...validSessionEntry, current: undefined },
    ]) {
      expect(cliSessionEntrySchema.safeParse(entry).success).toBe(false);
    }
  });
});

describe("cliSessionListSchema", () => {
  it("should accept an empty list and a list with one entry", () => {
    expect(cliSessionListSchema.safeParse({ sessions: [] }).success).toBe(true);
    expect(cliSessionListSchema.safeParse({ sessions: [validSessionEntry] }).success).toBe(true);
  });

  it("should reject an unknown field and a sessions value that is not an array", () => {
    expect(cliSessionListSchema.safeParse({ sessions: [], total: 0 }).success).toBe(false);
    expect(cliSessionListSchema.safeParse({ sessions: validSessionEntry }).success).toBe(false);
    expect(
      cliSessionListSchema.safeParse({
        sessions: [{ ...validSessionEntry, refreshHash: "hash" }],
      }).success,
    ).toBe(false);
  });
});

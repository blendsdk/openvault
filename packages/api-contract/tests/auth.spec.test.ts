import { describe, expect, it } from "vitest";
import {
  authMethodSchema,
  authUserSchema,
  loginRequestSchema,
  metaAuthSchema,
  passwordChangeRequestSchema,
  refreshResponseSchema,
  sessionEntrySchema,
  sessionListSchema,
  sessionResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

const validUser = {
  id: ULID,
  name: "Alice",
  email: "alice@example.com",
  authMethod: "local",
};

const validSessionEntry = {
  id: ULID,
  createdAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
  authMethod: "oidc",
  current: true,
};

const validSessionResponse = {
  user: validUser,
  expiresAt: TIMESTAMP,
  csrfToken: "a".repeat(32),
  mustChangePassword: false,
  lastLoginAt: TIMESTAMP,
};

const validRefreshResponse = {
  expiresAt: TIMESTAMP,
  csrfToken: "a".repeat(32),
};

/** Builds a syntactically valid email whose total length is exactly `length`. */
function emailOfLength(length: number): string {
  const domain = "@example.com";
  return `${"a".repeat(length - domain.length)}${domain}`;
}

describe("authMethodSchema", () => {
  it("should accept the local and oidc authentication methods", () => {
    for (const method of ["local", "oidc"]) {
      expect(authMethodSchema.safeParse(method).success).toBe(true);
    }
  });

  it("should reject methods outside the supported set", () => {
    for (const method of ["ldap", "LOCAL", "", "saml"]) {
      expect(authMethodSchema.safeParse(method).success).toBe(false);
    }
  });
});

describe("authUserSchema", () => {
  it("should accept a complete user and allow a null email", () => {
    expect(authUserSchema.safeParse(validUser).success).toBe(true);
    expect(authUserSchema.safeParse({ ...validUser, email: null }).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(authUserSchema.safeParse({ ...validUser, isAdmin: true }).success).toBe(false);
  });

  it("should enforce the 1 to 100 character name boundary", () => {
    expect(authUserSchema.safeParse({ ...validUser, name: "a" }).success).toBe(true);
    expect(authUserSchema.safeParse({ ...validUser, name: "a".repeat(100) }).success).toBe(true);
    expect(authUserSchema.safeParse({ ...validUser, name: "" }).success).toBe(false);
    expect(authUserSchema.safeParse({ ...validUser, name: "a".repeat(101) }).success).toBe(false);
  });

  it("should accept a 320-character email and reject a 321-character email", () => {
    expect(authUserSchema.safeParse({ ...validUser, email: emailOfLength(320) }).success).toBe(
      true,
    );
    expect(authUserSchema.safeParse({ ...validUser, email: emailOfLength(321) }).success).toBe(
      false,
    );
  });

  it("should reject a malformed email", () => {
    for (const email of ["not-an-email", "alice@", "alice example.com"]) {
      expect(authUserSchema.safeParse({ ...validUser, email }).success).toBe(false);
    }
  });

  it("should reject an id that is not a ULID and an unknown auth method", () => {
    expect(authUserSchema.safeParse({ ...validUser, id: "not-a-ulid" }).success).toBe(false);
    expect(authUserSchema.safeParse({ ...validUser, authMethod: "ldap" }).success).toBe(false);
  });
});

describe("loginRequestSchema", () => {
  it("should accept a padded identifier without lowercasing it", () => {
    const request = { identifier: " Alice@Example.com ", password: "x" };
    const result = loginRequestSchema.safeParse(request);

    expect(result.success).toBe(true);
    // The schema leaves the letter case alone; identifier normalization belongs to the controller.
    expect(loginRequestSchema.parse(request).identifier).toContain("Alice@Example.com");
  });

  it("should reject a login request with an unknown field", () => {
    const request = {
      identifier: "alice@example.com",
      password: "x",
      rememberMe: true,
    };
    expect(loginRequestSchema.safeParse(request).success).toBe(false);
  });

  it("should enforce the 1 to 320 character identifier boundary after trimming", () => {
    const accepted = { identifier: "a".repeat(320), password: "x" };
    expect(loginRequestSchema.safeParse(accepted).success).toBe(true);

    for (const identifier of ["a".repeat(321), "", "   "]) {
      expect(loginRequestSchema.safeParse({ identifier, password: "x" }).success).toBe(false);
    }
  });

  it("should enforce the 1 to 1024 character password boundary", () => {
    expect(loginRequestSchema.safeParse({ identifier: "alice", password: "x" }).success).toBe(true);
    expect(
      loginRequestSchema.safeParse({ identifier: "alice", password: "x".repeat(1024) }).success,
    ).toBe(true);

    for (const password of ["", "x".repeat(1025)]) {
      expect(loginRequestSchema.safeParse({ identifier: "alice", password }).success).toBe(false);
    }
  });
});

describe("passwordChangeRequestSchema", () => {
  it("should accept a new password of exactly 12 characters", () => {
    const request = { currentPassword: "old-password", newPassword: "a".repeat(12) };
    expect(passwordChangeRequestSchema.safeParse(request).success).toBe(true);
  });

  it("should reject a new password shorter than 12 characters", () => {
    const request = { currentPassword: "old-password", newPassword: "a".repeat(11) };
    expect(passwordChangeRequestSchema.safeParse(request).success).toBe(false);
  });

  it("should enforce the 1 to 1024 character current password and 1024 character new password bounds", () => {
    expect(
      passwordChangeRequestSchema.safeParse({
        currentPassword: "a".repeat(1024),
        newPassword: "a".repeat(1024),
      }).success,
    ).toBe(true);

    for (const request of [
      { currentPassword: "", newPassword: "a".repeat(12) },
      { currentPassword: "a".repeat(1025), newPassword: "a".repeat(12) },
      { currentPassword: "old-password", newPassword: "a".repeat(1025) },
    ]) {
      expect(passwordChangeRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("should reject an unknown field", () => {
    const request = {
      currentPassword: "old-password",
      newPassword: "a".repeat(12),
      confirmPassword: "a".repeat(12),
    };
    expect(passwordChangeRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("sessionResponseSchema", () => {
  it("should accept a complete session response", () => {
    expect(sessionResponseSchema.safeParse(validSessionResponse).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(
      sessionResponseSchema.safeParse({ ...validSessionResponse, token: "secret" }).success,
    ).toBe(false);
  });

  it("should require a CSRF token of at least 32 characters", () => {
    expect(
      sessionResponseSchema.safeParse({ ...validSessionResponse, csrfToken: "a".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      sessionResponseSchema.safeParse({ ...validSessionResponse, csrfToken: "a".repeat(31) })
        .success,
    ).toBe(false);
  });

  it("should require ISO timestamps for expiresAt and lastLoginAt", () => {
    for (const field of ["expiresAt", "lastLoginAt"] as const) {
      expect(
        sessionResponseSchema.safeParse({ ...validSessionResponse, [field]: "2026-10-30" }).success,
      ).toBe(false);
      expect(
        sessionResponseSchema.safeParse({ ...validSessionResponse, [field]: "not-a-timestamp" })
          .success,
      ).toBe(false);
    }
  });

  it("should require mustChangePassword to be a boolean", () => {
    expect(
      sessionResponseSchema.safeParse({ ...validSessionResponse, mustChangePassword: "false" })
        .success,
    ).toBe(false);
  });
});

describe("refreshResponseSchema", () => {
  it("should accept a complete refresh response", () => {
    expect(refreshResponseSchema.safeParse(validRefreshResponse).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(
      refreshResponseSchema.safeParse({ ...validRefreshResponse, user: validUser }).success,
    ).toBe(false);
  });

  it("should reject a short CSRF token and a non-ISO timestamp", () => {
    expect(
      refreshResponseSchema.safeParse({ ...validRefreshResponse, csrfToken: "a".repeat(31) })
        .success,
    ).toBe(false);
    expect(
      refreshResponseSchema.safeParse({ ...validRefreshResponse, expiresAt: "2026-10-30" }).success,
    ).toBe(false);
  });
});

describe("sessionEntrySchema", () => {
  it("should accept a complete session entry", () => {
    expect(sessionEntrySchema.safeParse(validSessionEntry).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(sessionEntrySchema.safeParse({ ...validSessionEntry, secret: "value" }).success).toBe(
      false,
    );
  });

  it("should reject a non-ULID id, an unknown auth method, and a non-boolean current flag", () => {
    expect(sessionEntrySchema.safeParse({ ...validSessionEntry, id: "not-a-ulid" }).success).toBe(
      false,
    );
    expect(sessionEntrySchema.safeParse({ ...validSessionEntry, authMethod: "ldap" }).success).toBe(
      false,
    );
    expect(sessionEntrySchema.safeParse({ ...validSessionEntry, current: "true" }).success).toBe(
      false,
    );
  });

  it("should reject a non-ISO createdAt timestamp", () => {
    expect(
      sessionEntrySchema.safeParse({ ...validSessionEntry, createdAt: "2026-10-30" }).success,
    ).toBe(false);
  });
});

describe("sessionListSchema", () => {
  it("should accept an empty list and a list with one entry", () => {
    expect(sessionListSchema.safeParse({ sessions: [] }).success).toBe(true);
    expect(sessionListSchema.safeParse({ sessions: [validSessionEntry] }).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(sessionListSchema.safeParse({ sessions: [], total: 0 }).success).toBe(false);
  });

  it("should reject a sessions value that is not an array", () => {
    expect(sessionListSchema.safeParse({ sessions: validSessionEntry }).success).toBe(false);
  });
});

describe("metaAuthSchema", () => {
  it("should accept both boolean flag combinations", () => {
    expect(metaAuthSchema.safeParse({ local: true, oidc: true }).success).toBe(true);
    expect(metaAuthSchema.safeParse({ local: true, oidc: false }).success).toBe(true);
  });

  it("should reject an unknown field", () => {
    expect(metaAuthSchema.safeParse({ local: true, oidc: false, issuer: "x" }).success).toBe(false);
  });

  it("should reject non-boolean flags", () => {
    expect(metaAuthSchema.safeParse({ local: true, oidc: "false" }).success).toBe(false);
  });
});

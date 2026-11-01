import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  CliAuthTestHarness,
  type CliSessionRow,
  type CliTestUser,
  cliMeResponseSchema,
  cliRefreshResponseSchema,
  type cliTokenDataSchema,
  cliTokenResponseSchema,
  TEST_PASSWORD,
  trustedTestHost,
} from "./helpers/cli.js";
import { createForgedAccessToken, tamperAccessToken } from "./helpers/cli-tokens.js";
import type { TestResponse } from "./helpers/https.js";

type TokenData = ReturnType<typeof cliTokenDataSchema.parse>;

let harness: CliAuthTestHarness | undefined;

beforeAll(async () => {
  harness = await CliAuthTestHarness.start();
}, 30_000);

afterAll(async () => {
  await harness?.stop();
});

/** Returns the running harness or fails the current test with a clear message. */
function requireHarness(): CliAuthTestHarness {
  if (harness === undefined) {
    throw new Error("the test harness is not ready");
  }
  return harness;
}

/** Signs one user in and returns the parsed token payload. */
async function login(user: CliTestUser): Promise<TokenData> {
  const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
  expect(response.status).toBe(200);
  return cliTokenResponseSchema.parse(response.json).data;
}

/** Asserts the stable error envelope for one rejected request. */
function expectError(response: TestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  const parsed = apiErrorSchema.parse(response.json);
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.statusCode).toBe(status);
}

/** Returns the only stored refresh row, failing clearly when there is none. */
function onlyRow(rows: readonly CliSessionRow[]): CliSessionRow {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected exactly one stored refresh row, found ${rows.length}`);
  }
  return row;
}

/** Returns the live row in a family, failing clearly when the family is revoked. */
function liveRow(rows: readonly CliSessionRow[]): CliSessionRow {
  const row = rows.find((entry) => entry.revokedAt === null);
  if (row === undefined) {
    throw new Error("expected one live refresh row");
  }
  return row;
}

describe.skipIf(trustedTestHost === undefined)("command-line refresh rotation", () => {
  it("should rotate both tokens, reject the previous refresh token, and keep the family expiry when the refresh token is valid", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);
    const initial = onlyRow(await requireHarness().cliSessionRows(user.id));

    const response = await requireHarness().cliRefresh(loginTokens.refreshToken);
    expect(response.status).toBe(200);
    const rotated = cliRefreshResponseSchema.parse(response.json).data;

    expect(rotated.accessToken).not.toBe(loginTokens.accessToken);
    expect(rotated.refreshToken).not.toBe(loginTokens.refreshToken);
    expect(Date.parse(rotated.refreshExpiresAt)).toBe(Date.parse(loginTokens.refreshExpiresAt));
    expect(rotated.user).toEqual(loginTokens.user);

    const profile = await requireHarness().cliMe({ bearer: rotated.accessToken });
    expect(profile.status).toBe(200);
    expect(cliMeResponseSchema.parse(profile.json).data.user.id).toBe(user.id);

    const rows = await requireHarness().cliFamilyRows(initial.familyId);
    expect(rows).toHaveLength(2);
    const replacement = liveRow(rows);
    expect(replacement.id).not.toBe(initial.id);
    expect(replacement.familyId).toBe(initial.familyId);
    expect(replacement.principalId).toBe(user.id);
    expect(replacement.expiresAt.getTime()).toBe(initial.expiresAt.getTime());

    const usedRow = rows.find((row) => row.id === initial.id);
    if (usedRow === undefined) {
      throw new Error("expected the previous refresh row to remain");
    }
    expect(usedRow.revokedAt).not.toBeNull();

    expectError(
      await requireHarness().cliRefresh(loginTokens.refreshToken),
      401,
      "invalid_refresh_token",
    );
  });

  it("should revoke the whole family and reject the current refresh token when a rotated token is reused", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);
    const initial = onlyRow(await requireHarness().cliSessionRows(user.id));

    const first = await requireHarness().cliRefresh(loginTokens.refreshToken);
    expect(first.status).toBe(200);
    const rotated = cliRefreshResponseSchema.parse(first.json).data;

    expectError(
      await requireHarness().cliRefresh(loginTokens.refreshToken),
      401,
      "invalid_refresh_token",
    );

    const rows = await requireHarness().cliFamilyRows(initial.familyId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    expectError(
      await requireHarness().cliRefresh(rotated.refreshToken),
      401,
      "invalid_refresh_token",
    );
    expectError(
      await requireHarness().cliMe({ bearer: rotated.accessToken }),
      401,
      "authentication_required",
    );
  });

  it("should allow exactly one of two concurrent refreshes and revoke the family for both tokens", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);
    const initial = onlyRow(await requireHarness().cliSessionRows(user.id));

    const responses = await Promise.all([
      requireHarness().cliRefresh(loginTokens.refreshToken),
      requireHarness().cliRefresh(loginTokens.refreshToken),
    ]);
    const succeeded = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 401);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = succeeded[0];
    const loser = rejected[0];
    if (winner === undefined || loser === undefined) {
      throw new Error("expected one successful and one rejected refresh");
    }
    const rotated = cliRefreshResponseSchema.parse(winner.json).data;
    expect(apiErrorSchema.parse(loser.json).error.code).toBe("invalid_refresh_token");

    const rows = await requireHarness().cliFamilyRows(initial.familyId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    expectError(
      await requireHarness().cliRefresh(rotated.refreshToken),
      401,
      "invalid_refresh_token",
    );
    expectError(
      await requireHarness().cliRefresh(loginTokens.refreshToken),
      401,
      "invalid_refresh_token",
    );
  });
});

describe.skipIf(trustedTestHost === undefined)("command-line logout", () => {
  it("should revoke the family, be idempotent, and reject the old access and refresh tokens when logout is called", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);

    const response = await requireHarness().cliLogout(loginTokens.refreshToken);
    expect(response.status).toBe(204);
    expect(response.body).toBe("");

    const repeated = await requireHarness().cliLogout(loginTokens.refreshToken);
    expect(repeated.status).toBe(204);
    expect(repeated.body).toBe("");

    expectError(
      await requireHarness().cliRefresh(loginTokens.refreshToken),
      401,
      "invalid_refresh_token",
    );
    expectError(
      await requireHarness().cliMe({ bearer: loginTokens.accessToken }),
      401,
      "authentication_required",
    );

    const rows = await requireHarness().cliSessionRows(user.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("should reject a malformed logout token but accept an unknown well-formed one", async () => {
    const malformed = await requireHarness().cliLogout("A".repeat(42));
    expectError(malformed, 400, "validation_error");

    const unknown = await requireHarness().cliLogout("A".repeat(43));
    expect(unknown.status).toBe(204);
    expect(unknown.body).toBe("");
  });
});

describe.skipIf(trustedTestHost === undefined)("principal status", () => {
  it("should reject refresh and bearer authentication and revoke the family when the principal is disabled", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);

    await requireHarness().disableUser(user.id);

    expectError(
      await requireHarness().cliMe({ bearer: loginTokens.accessToken }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliRefresh(loginTokens.refreshToken),
      401,
      "invalid_refresh_token",
    );

    const rows = await requireHarness().cliSessionRows(user.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    expectError(
      await requireHarness().cliMe({ bearer: loginTokens.accessToken }),
      401,
      "authentication_required",
    );
  });
});

describe.skipIf(trustedTestHost === undefined)("command-line bearer authentication", () => {
  it("should return the current user and forced-change flag for a valid bearer token without a cookie", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);

    const response = await requireHarness().cliMe({ bearer: loginTokens.accessToken });
    expect(response.status).toBe(200);
    const profile = cliMeResponseSchema.parse(response.json);

    expect(profile.data.user).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      authMethod: "local",
    });
    expect(profile.data.mustChangePassword).toBe(false);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("should reject a browser-cookie-only request and an invalid bearer even when the cookie is valid", async () => {
    const user = await requireHarness().insertUser();
    const session = await requireHarness().createBrowserSession(user.id);

    const browserProfile = await requireHarness().browserMe(session);
    expect(browserProfile.status).toBe(200);

    expectError(
      await requireHarness().cliMe({ cookie: requireHarness().browserCookie(session) }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliMe({
        authorization: "Bearer not-a-token",
        cookie: requireHarness().browserCookie(session),
      }),
      401,
      "authentication_required",
    );
  });

  it("should reject bearer tokens with the wrong algorithm, key id, signature, issuer, audience, kind, or expiry", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const rejected: ReadonlyArray<{ readonly label: string; readonly token: string }> = [
      {
        label: "wrong algorithm",
        token: await createForgedAccessToken({ algorithm: "HS256" }),
      },
      {
        label: "unknown key id",
        token: await createForgedAccessToken(),
      },
      {
        label: "tampered signature",
        token: tamperAccessToken(loginTokens.accessToken),
      },
      {
        label: "wrong issuer",
        token: await createForgedAccessToken({ issuer: "another-openvault" }),
      },
      {
        label: "wrong audience",
        token: await createForgedAccessToken({ audience: "another-client" }),
      },
      {
        label: "non-user subject kind",
        token: await createForgedAccessToken({ kind: "service" }),
      },
      {
        label: "expired token",
        token: await createForgedAccessToken({
          issuedAt: nowSeconds - 1_800,
          expiresAt: nowSeconds - 300,
        }),
      },
    ];

    for (const entry of rejected) {
      const response = await requireHarness().cliMe({ bearer: entry.token });
      expect(response.status, entry.label).toBe(401);
      const parsed = apiErrorSchema.parse(response.json);
      expect(parsed.error.code, entry.label).toBe("authentication_required");
      expect(parsed.error.statusCode, entry.label).toBe(401);
    }

    const revokedUser = await requireHarness().insertUser();
    const revokedLogin = await login(revokedUser);
    const logout = await requireHarness().cliLogout(revokedLogin.refreshToken);
    expect(logout.status).toBe(204);
    expectError(
      await requireHarness().cliMe({ bearer: revokedLogin.accessToken }),
      401,
      "authentication_required",
    );
  });

  it("should accept a lowercase bearer scheme but reject a different scheme or a missing token", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);

    const lowercase = await requireHarness().cliMe({
      authorization: `bearer ${loginTokens.accessToken}`,
    });
    expect(lowercase.status).toBe(200);
    expect(cliMeResponseSchema.parse(lowercase.json).data.user.id).toBe(user.id);

    expectError(
      await requireHarness().cliMe({ authorization: "Basic dXNlcjpwYXNzd29yZA==" }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliMe({ authorization: "Bearer" }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliMe({ authorization: `Bearer ${loginTokens.accessToken}x` }),
      401,
      "authentication_required",
    );
  });

  it("should use the command-line principal when a valid bearer token and a valid browser cookie are both present", async () => {
    const cliUser = await requireHarness().insertUser();
    const browserUser = await requireHarness().insertUser();
    const loginTokens = await login(cliUser);
    const session = await requireHarness().createBrowserSession(browserUser.id);

    const response = await requireHarness().cliMe({
      bearer: loginTokens.accessToken,
      cookie: requireHarness().browserCookie(session),
    });
    expect(response.status).toBe(200);
    const profile = cliMeResponseSchema.parse(response.json).data;
    expect(profile.user.id).toBe(cliUser.id);
    expect(profile.user.email).toBe(cliUser.email);

    const browserProfile = await requireHarness().browserMe(session);
    expect(browserProfile.status).toBe(200);
  });

  it("should allow command-line login with an invalid bearer header and ignore any browser cookie", async () => {
    const user = await requireHarness().insertUser();
    const session = await requireHarness().createBrowserSession(user.id);
    const address = requireHarness().uniqueAddress();

    const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD, address, {
      authorization: "Bearer not-a-token",
      cookie: requireHarness().browserCookie(session),
    });
    expect(response.status).toBe(200);
    const tokens = cliTokenResponseSchema.parse(response.json).data;

    expect(tokens.user.id).toBe(user.id);
    expect(tokens.mustChangePassword).toBe(false);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("should allow command-line refresh and logout without origin or CSRF headers while a browser mutation still requires CSRF", async () => {
    const user = await requireHarness().insertUser();
    const loginTokens = await login(user);

    const refreshed = await requireHarness().cliRefresh(loginTokens.refreshToken);
    expect(refreshed.status).toBe(200);
    const rotated = cliRefreshResponseSchema.parse(refreshed.json).data;

    const logout = await requireHarness().cliLogout(rotated.refreshToken);
    expect(logout.status).toBe(204);

    const browserUser = await requireHarness().insertUser();
    const session = await requireHarness().createBrowserSession(browserUser.id);
    expect((await requireHarness().browserMe(session)).status).toBe(200);

    const mutation = await requireHarness().send({
      path: "/v1/auth/logout",
      method: "POST",
      headers: { cookie: requireHarness().browserCookie(session) },
    });
    expect(mutation.status).toBe(403);
    expect(apiErrorSchema.parse(mutation.json).error.code).toBe("csrf_invalid");
  });
});

describe.skipIf(trustedTestHost === undefined)("forced password change", () => {
  it("should allow only the profile and logout routes while a command-line password change is required", async () => {
    const user = await requireHarness().insertUser({ mustChange: true });
    const first = await login(user);
    expect(first.mustChangePassword).toBe(true);

    const profile = await requireHarness().cliMe({ bearer: first.accessToken });
    expect(profile.status).toBe(200);
    const parsed = cliMeResponseSchema.parse(profile.json).data;
    expect(parsed.mustChangePassword).toBe(true);
    expect(parsed.user.id).toBe(user.id);

    expectError(
      await requireHarness().cliSessions(first.accessToken),
      403,
      "password_change_required",
    );

    const logoutWithBearer = await requireHarness().cliLogout(first.refreshToken, {
      authorization: `Bearer ${first.accessToken}`,
    });
    expect(logoutWithBearer.status).toBe(204);

    const second = await login(user);
    const logoutWithoutBearer = await requireHarness().cliLogout(second.refreshToken);
    expect(logoutWithoutBearer.status).toBe(204);
  });
});

describe.skipIf(trustedTestHost === undefined)("command-line refresh rate limits", () => {
  it("should reject the sixty-first refresh from one address in a minute", async () => {
    const address = requireHarness().uniqueAddress();
    const unknownToken = "A".repeat(43);

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const response = await requireHarness().cliRefresh(unknownToken, address);
      expect(response.status, `refresh ${attempt}`).toBe(401);
      expect(apiErrorSchema.parse(response.json).error.code, `refresh ${attempt}`).toBe(
        "invalid_refresh_token",
      );
    }

    const limited = await requireHarness().cliRefresh(unknownToken, address);
    expectError(limited, 429, "RATE_LIMIT_EXCEEDED");
  }, 60_000);

  it("should reject the thirty-first rotation for one family in a minute and keep the family limit", async () => {
    const user = await requireHarness().insertUser();
    const address = requireHarness().uniqueAddress();
    const loginResponse = await requireHarness().cliLogin(user.email, TEST_PASSWORD, address);
    expect(loginResponse.status).toBe(200);

    const loginTokens = cliTokenResponseSchema.parse(loginResponse.json).data;
    let refreshToken = loginTokens.refreshToken;
    let accessToken = loginTokens.accessToken;

    for (let rotation = 1; rotation <= 30; rotation += 1) {
      const response = await requireHarness().cliRefresh(refreshToken, address);
      expect(response.status, `rotation ${rotation}`).toBe(200);
      const rotated = cliRefreshResponseSchema.parse(response.json).data;
      refreshToken = rotated.refreshToken;
      accessToken = rotated.accessToken;
    }

    const limited = await requireHarness().cliRefresh(refreshToken, address);
    expectError(limited, 429, "RATE_LIMIT_EXCEEDED");

    // A rejected limit must not revoke the family or its current access token.
    const profile = await requireHarness().cliMe({ bearer: accessToken });
    expect(profile.status).toBe(200);
    expect(cliMeResponseSchema.parse(profile.json).data.user.id).toBe(user.id);
  }, 60_000);
});

import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  apiErrorSchema,
  CliAuthTestHarness,
  type CliTestUser,
  cliSessionListResponseSchema,
  type cliTokenDataSchema,
  cliTokenResponseSchema,
  matchesPasswordHash,
  TEST_PASSWORD,
  trustedTestHost,
} from "./helpers/cli.js";
import type { TestResponse } from "./helpers/https.js";

type TokenData = ReturnType<typeof cliTokenDataSchema.parse>;

/** Replacement password used by the password-change tests. */
const NEW_PASSWORD = "a brand new passphrase";

/** A second replacement password, used when two changes race. */
const OTHER_PASSWORD = "another brand new passphrase";

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1_000;

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
async function login(user: CliTestUser, password: string = TEST_PASSWORD): Promise<TokenData> {
  const response = await requireHarness().cliLogin(user.email, password);
  expect(response.status).toBe(200);
  return cliTokenResponseSchema.parse(response.json).data;
}

/** Asserts the stable error envelope for one rejected request. */
function expectError(response: TestResponse, status: number, code: string, message?: string): void {
  expect(response.status).toBe(status);
  const parsed = apiErrorSchema.parse(response.json);
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.statusCode).toBe(status);
  if (message !== undefined) {
    expect(parsed.error.message).toBe(message);
  }
}

/** Returns true when a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the `sid` claim that names the token's refresh family. */
function familyIdOf(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    throw new Error("expected a three-part access token");
  }
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!isRecord(claims)) {
    throw new Error("expected an object token payload");
  }
  const sid = claims.sid;
  if (typeof sid !== "string") {
    throw new Error("expected a family identifier claim");
  }
  return sid;
}

/** Returns one row, failing clearly when the array does not have exactly one. */
function onlyRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected exactly one row, found ${rows.length}`);
  }
  return row;
}

/** Reads one Set-Cookie value from a response. */
function cookieValue(response: TestResponse, name: string): string | undefined {
  const raw = response.headers["set-cookie"];
  const headers = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const header = headers.find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}=`));
  if (header === undefined) {
    return undefined;
  }
  const [value] = header.slice(name.length + 1).split(";");
  return value;
}

/** Returns a timestamp a number of days in the past. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describe.skipIf(trustedTestHost === undefined)("command-line family listing", () => {
  it("should list only live families newest first with one current flag and no secret fields", async () => {
    const user = await requireHarness().insertUser();
    const first = await login(user);
    await delay(25);
    const second = await login(user);
    const firstFamily = familyIdOf(first.accessToken);
    const secondFamily = familyIdOf(second.accessToken);
    const firstRow = onlyRow(await requireHarness().cliFamilyRows(firstFamily));
    const secondRow = onlyRow(await requireHarness().cliFamilyRows(secondFamily));

    const revoked = await login(user);
    await requireHarness().cliLogout(revoked.refreshToken);
    const expired = await login(user);
    await requireHarness().expireCliFamilyRows(familyIdOf(expired.accessToken));

    const response = await requireHarness().cliSessions(first.accessToken);
    expect(response.status).toBe(200);
    const entries = cliSessionListResponseSchema.parse(response.json).data.sessions;

    expect(entries.map((entry) => entry.id)).toEqual([secondFamily, firstFamily]);
    expect(entries.filter((entry) => entry.current)).toHaveLength(1);
    expect(entries[0]?.current).toBe(false);
    expect(entries[1]?.current).toBe(true);
    expect(entries[0]?.createdAt).toBe(secondRow.createdAt.toISOString());
    expect(entries[1]?.createdAt).toBe(firstRow.createdAt.toISOString());
    expect(entries[0]?.expiresAt).toBe(secondRow.expiresAt.toISOString());
    expect(entries[1]?.expiresAt).toBe(firstRow.expiresAt.toISOString());

    const storedRowIds = new Set(
      (await requireHarness().cliSessionRows(user.id)).map((row) => row.id),
    );
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "current", "expiresAt", "id"]);
      expect(storedRowIds.has(entry.id)).toBe(false);
    }
    expect(response.body).not.toContain(first.refreshToken);
    expect(response.body).not.toContain(second.accessToken);
    expect(response.body).not.toContain(firstRow.id);
    expect(response.body).not.toContain(secondRow.id);

    const rotated = await requireHarness().cliRefresh(first.refreshToken);
    expect(rotated.status).toBe(200);

    const afterRefresh = await requireHarness().cliSessions(first.accessToken);
    expect(afterRefresh.status).toBe(200);
    const afterEntries = cliSessionListResponseSchema.parse(afterRefresh.json).data.sessions;
    expect(afterEntries.map((entry) => entry.id)).toEqual([secondFamily, firstFamily]);
    const afterFirst = afterEntries.find((entry) => entry.id === firstFamily);
    if (afterFirst === undefined) {
      throw new Error("expected the rotated family to remain listed");
    }
    expect(afterFirst.createdAt).toBe(firstRow.createdAt.toISOString());
    expect(afterFirst.expiresAt).toBe(firstRow.expiresAt.toISOString());
  });

  it("should reject the family routes for a browser session or no credentials", async () => {
    const user = await requireHarness().insertUser();
    const session = await requireHarness().createBrowserSession(user.id);
    const cookie = requireHarness().browserCookie(session);

    expectError(
      await requireHarness().send({ path: "/v1/auth/cli/sessions", method: "GET" }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().send({
        path: "/v1/auth/cli/sessions",
        method: "GET",
        headers: { cookie },
      }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().send({
        path: `/v1/auth/cli/sessions/${requireHarness().fixtureId()}`,
        method: "DELETE",
        headers: { cookie },
      }),
      403,
      "csrf_invalid",
    );
  });
});

describe.skipIf(trustedTestHost === undefined)("command-line family revocation", () => {
  it("should revoke an owned non-current family and reject its access and refresh tokens", async () => {
    const user = await requireHarness().insertUser();
    const older = await login(user);
    const newer = await login(user);
    const olderFamily = familyIdOf(older.accessToken);
    const newerFamily = familyIdOf(newer.accessToken);

    const response = await requireHarness().cliDeleteSession(newer.accessToken, olderFamily);
    expect(response.status).toBe(204);
    expect(response.body).toBe("");

    expectError(
      await requireHarness().cliMe({ bearer: older.accessToken }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliRefresh(older.refreshToken),
      401,
      "invalid_refresh_token",
    );
    expect(await requireHarness().liveCliFamilyIds(user.id)).toEqual([newerFamily]);

    const profile = await requireHarness().cliMe({ bearer: newer.accessToken });
    expect(profile.status).toBe(200);
  });

  it("should revoke the caller's current family and reject its next bearer request", async () => {
    const user = await requireHarness().insertUser();
    const tokens = await login(user);
    const familyId = familyIdOf(tokens.accessToken);

    const response = await requireHarness().cliDeleteSession(tokens.accessToken, familyId);
    expect(response.status).toBe(204);
    expect(response.body).toBe("");

    expectError(
      await requireHarness().cliMe({ bearer: tokens.accessToken }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliSessions(tokens.accessToken),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliRefresh(tokens.refreshToken),
      401,
      "invalid_refresh_token",
    );
    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(0);
  });

  it("should return the same not-found error for foreign, unknown, malformed, revoked, and expired families", async () => {
    const owner = await requireHarness().insertUser();
    const other = await requireHarness().insertUser();
    const ownerTokens = await login(owner);
    const foreign = await login(other);
    const foreignFamily = familyIdOf(foreign.accessToken);

    const revoked = await login(owner);
    await requireHarness().cliLogout(revoked.refreshToken);
    const revokedFamily = familyIdOf(revoked.accessToken);

    const expired = await login(owner);
    const expiredFamily = familyIdOf(expired.accessToken);
    await requireHarness().expireCliFamilyRows(expiredFamily);

    const cases: ReadonlyArray<{ readonly label: string; readonly familyId: string }> = [
      { label: "foreign family", familyId: foreignFamily },
      { label: "unknown family", familyId: requireHarness().fixtureId() },
      { label: "malformed short id", familyId: "not-a-ulid" },
      { label: "malformed alphabet", familyId: "I".repeat(26) },
      { label: "malformed length", familyId: "A".repeat(25) },
      { label: "already-revoked family", familyId: revokedFamily },
      { label: "expired family", familyId: expiredFamily },
    ];

    for (const entry of cases) {
      const response = await requireHarness().cliDeleteSession(
        ownerTokens.accessToken,
        entry.familyId,
      );
      expect(response.status, entry.label).toBe(404);
      const parsed = apiErrorSchema.parse(response.json);
      expect(parsed.error.code, entry.label).toBe("session_not_found");
      expect(parsed.error.message, entry.label).toBe("Session not found");
      expect(parsed.error.statusCode, entry.label).toBe(404);
    }

    // A rejected delete of another principal's family must not revoke it.
    expect(await requireHarness().countLiveCliFamilies(other.id)).toBe(1);
    expect((await requireHarness().cliRefresh(foreign.refreshToken)).status).toBe(200);
    expect((await requireHarness().cliMe({ bearer: foreign.accessToken })).status).toBe(200);
  });

  it("should leave no live row when a refresh races an owned-family delete", async () => {
    const user = await requireHarness().insertUser();
    const tokens = await login(user);
    const familyId = familyIdOf(tokens.accessToken);

    let refreshPromise: Promise<TestResponse> | undefined;
    let deletePromise: Promise<TestResponse> | undefined;
    let blocked = 0;

    await requireHarness().withPrincipalLock(user.id, async (lock) => {
      refreshPromise = requireHarness().cliRefresh(tokens.refreshToken);
      deletePromise = requireHarness().cliDeleteSession(tokens.accessToken, familyId);
      // The held principal lock may queue the second request behind the first
      // app transaction, so at least one direct waiter is the reliable signal.
      // The end-state assertions below prove the delete/refresh serialization.
      blocked = await lock.waitForBlockedTransactions(1);
    });

    if (refreshPromise === undefined || deletePromise === undefined) {
      throw new Error("expected both racing requests to start");
    }
    const [refreshResponse, deleteResponse] = await Promise.all([refreshPromise, deletePromise]);

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toBe("");
    expect(blocked).toBeGreaterThanOrEqual(1);
    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(0);
    expect(await requireHarness().liveCliFamilyIds(user.id)).toEqual([]);
    expect(
      (await requireHarness().cliFamilyRows(familyId)).every((row) => row.revokedAt !== null),
    ).toBe(true);

    if (refreshResponse.status === 200) {
      const rotated = cliTokenResponseSchema.parse(refreshResponse.json).data;
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
    } else {
      expectError(refreshResponse, 401, "invalid_refresh_token");
    }

    expectError(
      await requireHarness().cliMe({ bearer: tokens.accessToken }),
      401,
      "authentication_required",
    );
  });
});

describe.skipIf(trustedTestHost === undefined)("password change and command-line families", () => {
  it("should revoke every command-line family when the browser password changes and accept a fresh login with the new password", async () => {
    const user = await requireHarness().insertUser();
    const first = await login(user);
    const second = await login(user);
    const currentSession = await requireHarness().createBrowserSession(user.id);
    const otherSession = await requireHarness().createBrowserSession(user.id);

    const response = await requireHarness().changePassword(
      currentSession,
      TEST_PASSWORD,
      NEW_PASSWORD,
    );
    expect(response.status).toBe(200);
    const rotatedSecret = cookieValue(response, SESSION_COOKIE_NAME);
    if (rotatedSecret === undefined || rotatedSecret === "") {
      throw new Error("expected a rotated browser session cookie");
    }

    for (const tokens of [first, second]) {
      expectError(
        await requireHarness().cliMe({ bearer: tokens.accessToken }),
        401,
        "authentication_required",
      );
      expectError(
        await requireHarness().cliRefresh(tokens.refreshToken),
        401,
        "invalid_refresh_token",
      );
    }

    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(0);
    const rows = await requireHarness().cliSessionRows(user.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    expect((await requireHarness().browserMe(otherSession)).status).toBe(401);
    expect((await requireHarness().browserMe(currentSession)).status).toBe(401);
    const rotated = await requireHarness().send({
      path: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rotatedSecret}` },
    });
    expect(rotated.status).toBe(200);

    const oldPassword = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expectError(oldPassword, 401, "invalid_credentials");
    const fresh = await requireHarness().cliLogin(user.email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(1);
  });

  it("should let exactly one of two concurrent password changes win and revoke the command-line families", async () => {
    const user = await requireHarness().insertUser();
    const firstFamily = await login(user);
    const secondFamily = await login(user);
    const firstSession = await requireHarness().createBrowserSession(user.id);
    const secondSession = await requireHarness().createBrowserSession(user.id);

    const [firstResponse, secondResponse] = await Promise.all([
      requireHarness().changePassword(firstSession, TEST_PASSWORD, NEW_PASSWORD),
      requireHarness().changePassword(secondSession, TEST_PASSWORD, OTHER_PASSWORD),
    ]);

    const winners = [firstResponse, secondResponse].filter((response) => response.status === 200);
    const losers = [firstResponse, secondResponse].filter((response) => response.status === 401);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    const loser = losers[0];
    if (winner === undefined || loser === undefined) {
      throw new Error("expected one winning and one losing password change");
    }
    expectError(loser, 401, "invalid_credentials");

    const winnerPassword = winner === firstResponse ? NEW_PASSWORD : OTHER_PASSWORD;
    const loserPassword = winner === firstResponse ? OTHER_PASSWORD : NEW_PASSWORD;
    const stored = await requireHarness().readCredential(user.id);
    expect(matchesPasswordHash(winnerPassword, stored.passwordHash)).toBe(true);
    expect(matchesPasswordHash(loserPassword, stored.passwordHash)).toBe(false);
    expect(matchesPasswordHash(TEST_PASSWORD, stored.passwordHash)).toBe(false);

    for (const tokens of [firstFamily, secondFamily]) {
      expectError(
        await requireHarness().cliMe({ bearer: tokens.accessToken }),
        401,
        "authentication_required",
      );
      expectError(
        await requireHarness().cliRefresh(tokens.refreshToken),
        401,
        "invalid_refresh_token",
      );
    }
    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(0);

    const losingLogin = await requireHarness().cliLogin(user.email, loserPassword);
    expectError(losingLogin, 401, "invalid_credentials");
    const winningLogin = await requireHarness().cliLogin(user.email, winnerPassword);
    expect(winningLogin.status).toBe(200);
  });

  it("should not leave a live family when a password change races a command-line login", async () => {
    const user = await requireHarness().insertUser();
    const existing = await login(user);
    const session = await requireHarness().createBrowserSession(user.id);

    let loginPromise: Promise<TestResponse> | undefined;
    let changePromise: Promise<TestResponse> | undefined;
    let blocked = 0;

    await requireHarness().withPrincipalLock(user.id, async (lock) => {
      loginPromise = requireHarness().cliLogin(user.email, TEST_PASSWORD);
      await lock.waitForBlockedTransactions(1);
      changePromise = requireHarness().changePassword(session, TEST_PASSWORD, NEW_PASSWORD);
      blocked = await lock.waitForBlockedTransactions(2);
    });

    if (loginPromise === undefined || changePromise === undefined) {
      throw new Error("expected both racing requests to start");
    }
    const [loginResponse, changeResponse] = await Promise.all([loginPromise, changePromise]);
    expect(changeResponse.status).toBe(200);

    if (loginResponse.status === 200) {
      const created = cliTokenResponseSchema.parse(loginResponse.json).data;
      expectError(
        await requireHarness().cliMe({ bearer: created.accessToken }),
        401,
        "authentication_required",
      );
      expectError(
        await requireHarness().cliRefresh(created.refreshToken),
        401,
        "invalid_refresh_token",
      );
    } else {
      expectError(loginResponse, 401, "invalid_credentials");
    }

    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(0);
    expect(await requireHarness().liveCliFamilyIds(user.id)).toEqual([]);
    expect(blocked).toBeGreaterThanOrEqual(2);
    expectError(
      await requireHarness().cliMe({ bearer: existing.accessToken }),
      401,
      "authentication_required",
    );
    expectError(
      await requireHarness().cliRefresh(existing.refreshToken),
      401,
      "invalid_refresh_token",
    );

    const oldPassword = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expectError(oldPassword, 401, "invalid_credentials");
    const fresh = await requireHarness().cliLogin(user.email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
  });
});

describe.skipIf(trustedTestHost === undefined)("retention cleanup", () => {
  it("should delete rows past retention, keep recent and live rows, and be idempotent", async () => {
    const user = await requireHarness().insertUser();
    const usable = await login(user);

    const pastExpiry = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(31),
    });
    const retainedExpiry = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(29),
    });
    const pastRevocation = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(40),
      revokedAt: daysAgo(31),
    });
    const retainedRevocation = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(40),
      revokedAt: daysAgo(29),
    });
    const live = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });

    const maintenance = await requireHarness().cliMaintenance();
    expect(await maintenance.runOnce()).toBe(2);

    const remaining = (await requireHarness().cliSessionRows(user.id)).map((row) => row.id);
    expect(remaining).toContain(retainedExpiry.id);
    expect(remaining).toContain(retainedRevocation.id);
    expect(remaining).toContain(live.id);
    expect(remaining).not.toContain(pastExpiry.id);
    expect(remaining).not.toContain(pastRevocation.id);

    expect(await maintenance.runOnce()).toBe(0);
    expect((await requireHarness().cliSessionRows(user.id)).map((row) => row.id).sort()).toEqual(
      remaining.sort(),
    );

    // A family that can still authenticate is never removed by retention.
    expect((await requireHarness().cliMe({ bearer: usable.accessToken })).status).toBe(200);
    expect((await requireHarness().cliRefresh(usable.refreshToken)).status).toBe(200);
  });

  it("should delete no more than the requested batch size", async () => {
    const user = await requireHarness().insertUser();
    const live = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });

    const eligible: Array<{ readonly id: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      eligible.push(
        await requireHarness().insertCliSessionRow({
          principalId: user.id,
          expiresAt: daysAgo(31 + index),
        }),
      );
    }

    const repository = await requireHarness().cliSessionRepository();
    await repository.cleanup(2);

    const afterBatch = (await requireHarness().cliSessionRows(user.id)).map((row) => row.id);
    expect(afterBatch).toContain(live.id);
    expect(eligible.filter((row) => afterBatch.includes(row.id))).toHaveLength(1);

    const maintenance = await requireHarness().cliMaintenance();
    expect(await maintenance.runOnce()).toBe(1);
    expect((await requireHarness().cliSessionRows(user.id)).map((row) => row.id)).toEqual([
      live.id,
    ]);
  });
});

describe.skipIf(trustedTestHost === undefined)("authentication bootstrap", () => {
  it("should keep one current signing key and no duplicate maintenance timer when bootstrap runs again", async () => {
    const initialKid = await requireHarness().currentSigningKeyKid();
    if (initialKid === undefined) {
      throw new Error("expected a current signing key after startup");
    }
    expect(await requireHarness().countSigningKeys("current")).toBe(1);

    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await requireHarness().bootstrapRuntime();
      await requireHarness().bootstrapRuntime();

      const longSchedules = [...intervalSpy.mock.calls, ...timeoutSpy.mock.calls].filter(
        (call) => call[1] === DAY_MS,
      );
      expect(longSchedules).toHaveLength(0);
    } finally {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    }

    expect(await requireHarness().countSigningKeys("current")).toBe(1);
    expect(await requireHarness().currentSigningKeyKid()).toBe(initialKid);

    const maintenance = await requireHarness().cliMaintenance();
    const user = await requireHarness().insertUser();
    await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(31),
    });
    expect(await maintenance.runOnce()).toBe(1);
    expect(await maintenance.runOnce()).toBe(0);
  });

  it("should not fail startup when the initial cleanup fails and should retry on the next run", async () => {
    const maintenance = await requireHarness().cliMaintenance();
    const user = await requireHarness().insertUser();
    const eligible = await requireHarness().insertCliSessionRow({
      principalId: user.id,
      expiresAt: daysAgo(31),
    });

    maintenance.stop();
    await requireHarness().db.db.executeQuery(
      "ALTER TABLE cli_sessions RENAME TO cli_sessions_unavailable",
    );
    try {
      await expect(requireHarness().bootstrapRuntime()).resolves.toBeUndefined();
      await expect(maintenance.runOnce()).rejects.toThrow();
    } finally {
      await requireHarness().db.db.executeQuery(
        "ALTER TABLE cli_sessions_unavailable RENAME TO cli_sessions",
      );
      maintenance.stop();
    }

    expect(await maintenance.runOnce()).toBe(1);
    const remaining = await requireHarness().cliSessionRows(user.id);
    expect(remaining.map((row) => row.id)).not.toContain(eligible.id);
  });
});

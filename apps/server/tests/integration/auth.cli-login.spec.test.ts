import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  CliAuthTestHarness,
  cliTokenResponseSchema,
  TEST_PASSWORD,
  trustedTestHost,
} from "./helpers/cli.js";

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

/**
 * Converts one database value to every textual form a raw token could hide in.
 *
 * Binary columns are checked as UTF-8, hexadecimal, and base64url; structured
 * values are serialized so a nested token is still visible to the assertion.
 */
function valueTexts(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Buffer.isBuffer(value)) {
    return [value.toString("utf8"), value.toString("hex"), value.toString("base64url")];
  }
  if (value instanceof Date) {
    return [value.toISOString()];
  }
  if (typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [String(value)];
}

describe.skipIf(trustedTestHost === undefined)("command-line login", () => {
  it("should return a bearer token response with the local user and no cookie when credentials are valid", async () => {
    const user = await requireHarness().insertUser();
    const startedAt = Date.now();

    const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(response.status).toBe(200);
    const data = cliTokenResponseSchema.parse(response.json).data;

    expect(data.tokenType).toBe("Bearer");
    expect(data.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.accessExpiresAt).not.toBe(data.refreshExpiresAt);
    expect(data.user).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      authMethod: "local",
    });
    expect(data.mustChangePassword).toBe(false);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(data).not.toHaveProperty("refreshHash");
    expect(data).not.toHaveProperty("passwordHash");

    const accessExpiry = Date.parse(data.accessExpiresAt);
    const refreshExpiry = Date.parse(data.refreshExpiresAt);
    expect(accessExpiry - startedAt).toBeGreaterThanOrEqual(14 * 60_000);
    expect(accessExpiry - startedAt).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(refreshExpiry - startedAt).toBeGreaterThanOrEqual(12 * 3_600_000 - 5_000);
    expect(refreshExpiry - startedAt).toBeLessThanOrEqual(12 * 3_600_000 + 5_000);
  });

  it("should store only the SHA-256 hash of the refresh token and never the raw token", async () => {
    const user = await requireHarness().insertUser();

    const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(response.status).toBe(200);
    const data = cliTokenResponseSchema.parse(response.json).data;

    const rows = await requireHarness().cliSessionRows(user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected one stored command-line refresh row");
    }
    const expectedHash = createHash("sha256").update(data.refreshToken, "utf8").digest();
    expect(row.refreshHash.equals(expectedHash)).toBe(true);

    const columns = await requireHarness().cliSessionColumns();
    expect(columns).not.toContain("refresh_token");
    expect(columns).not.toContain("raw_token");
    expect(columns).not.toContain("token");

    const rawRows = await requireHarness().cliSessionRawRows(user.id);
    expect(rawRows).toHaveLength(1);
    const rawRow = rawRows[0];
    if (rawRow === undefined) {
      throw new Error("expected one raw command-line refresh row");
    }
    for (const [column, value] of Object.entries(rawRow)) {
      for (const text of valueTexts(value)) {
        expect(text, `column ${column} must not contain the raw refresh token`).not.toContain(
          data.refreshToken,
        );
      }
    }
  });

  it("should return the same generic invalid-credentials response for unknown, wrong, disabled, and locked sign-ins", async () => {
    const wrongPasswordUser = await requireHarness().insertUser();
    const disabledUser = await requireHarness().insertUser({ status: "disabled" });
    const lockedUser = await requireHarness().insertUser();
    const lockedUntil = new Date(Date.now() + 5 * 60_000);
    await requireHarness().setLock(lockedUser.id, lockedUntil, 5);
    const unknownIdentifier = `unknown-${requireHarness().fixtureId().toLowerCase()}@example.test`;

    const attempts: ReadonlyArray<{
      readonly label: string;
      readonly identifier: string;
      readonly password: string;
      readonly generic: boolean;
    }> = [
      {
        label: "wrong password",
        identifier: wrongPasswordUser.email,
        password: "definitely not the password",
        generic: false,
      },
      {
        label: "disabled principal",
        identifier: disabledUser.email,
        password: TEST_PASSWORD,
        generic: true,
      },
      {
        label: "locked principal",
        identifier: lockedUser.email,
        password: TEST_PASSWORD,
        generic: true,
      },
      {
        label: "unknown identifier",
        identifier: unknownIdentifier,
        password: TEST_PASSWORD,
        generic: true,
      },
    ];

    const observed: Array<{ readonly status: number; readonly error: unknown }> = [];
    for (const attempt of attempts) {
      const startedAt = Date.now();
      const response = await requireHarness().cliLogin(attempt.identifier, attempt.password);
      const elapsedMs = Date.now() - startedAt;
      observed.push({ status: response.status, error: apiErrorSchema.parse(response.json).error });

      if (attempt.generic) {
        // A generic rejection still performs one full-cost Argon2id derivation.
        // A fast return would reveal that the account has no usable password.
        expect(elapsedMs, `${attempt.label} must spend password-hash time`).toBeGreaterThanOrEqual(
          50,
        );
      }
    }

    expect(observed.map((entry) => entry.status)).toEqual([401, 401, 401, 401]);
    for (const entry of observed) {
      expect(entry.error).toEqual({
        code: "invalid_credentials",
        message: "Invalid credentials",
        statusCode: 401,
      });
    }

    const wrongState = await requireHarness().readCredential(wrongPasswordUser.id);
    expect(wrongState.failedCount).toBe(1);
    expect(wrongState.lockedUntil).toBeNull();

    const disabledState = await requireHarness().readCredential(disabledUser.id);
    expect(disabledState.failedCount).toBe(0);
    expect(disabledState.lockedUntil).toBeNull();

    const lockedState = await requireHarness().readCredential(lockedUser.id);
    expect(lockedState.failedCount).toBe(5);
    expect(lockedState.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
  });

  it("should lock the browser login after five command-line password failures", async () => {
    const user = await requireHarness().insertUser();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await requireHarness().cliLogin(user.email, `wrong command-line ${attempt}`);
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(response.json).error.code).toBe("invalid_credentials");
    }

    const browserResponse = await requireHarness().browserLogin(user.email, TEST_PASSWORD);
    expect(browserResponse.status).toBe(401);
    expect(apiErrorSchema.parse(browserResponse.json).error.code).toBe("invalid_credentials");

    const state = await requireHarness().readCredential(user.id);
    expect(state.failedCount).toBe(5);
    const lockedUntil = state.lockedUntil;
    if (lockedUntil === null) {
      throw new Error("expected the account to be locked");
    }
    expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("should lock the command-line login after five browser password failures", async () => {
    const user = await requireHarness().insertUser();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await requireHarness().browserLogin(user.email, `wrong browser ${attempt}`);
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(response.json).error.code).toBe("invalid_credentials");
    }

    const cliResponse = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(cliResponse.status).toBe(401);
    expect(apiErrorSchema.parse(cliResponse.json).error.code).toBe("invalid_credentials");

    const state = await requireHarness().readCredential(user.id);
    expect(state.failedCount).toBe(5);
    const lockedUntil = state.lockedUntil;
    if (lockedUntil === null) {
      throw new Error("expected the account to be locked");
    }
    expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("should share the per-address login limit between browser and command-line sign-ins", async () => {
    const address = requireHarness().uniqueAddress();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const identifier = `address-${requireHarness().fixtureId().toLowerCase()}@example.test`;
      const response = await requireHarness().browserLogin(identifier, "wrong password", address);
      expect(response.status).toBe(401);
    }

    const user = await requireHarness().insertUser();
    const limited = await requireHarness().cliLogin(user.email, TEST_PASSWORD, address);

    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(limited.json).error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should share the per-account login limit between browser and command-line sign-ins", async () => {
    const identifier = `account-${requireHarness().fixtureId().toLowerCase()}@example.test`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const variant = attempt % 2 === 0 ? `  ${identifier.toUpperCase()}  ` : identifier;
      const response = await requireHarness().browserLogin(variant, "wrong password");
      expect(response.status).toBe(401);
    }

    const limited = await requireHarness().cliLogin(identifier, "wrong password");

    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(limited.json).error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should return the forced-change flag and create a family without a cookie when a password change is required", async () => {
    const user = await requireHarness().insertUser({ mustChange: true });

    const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(response.status).toBe(200);
    const data = cliTokenResponseSchema.parse(response.json).data;

    expect(data.mustChangePassword).toBe(true);
    expect(data.user).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      authMethod: "local",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();

    expect(await requireHarness().countLiveCliFamilies(user.id)).toBe(1);
    const rows = await requireHarness().cliSessionRows(user.id);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected the forced-change login to create a family");
    }
    const expectedHash = createHash("sha256").update(data.refreshToken, "utf8").digest();
    expect(row.refreshHash.equals(expectedHash)).toBe(true);
    expect(row.revokedAt).toBeNull();
  });
});

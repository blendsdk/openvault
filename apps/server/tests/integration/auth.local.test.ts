import { argon2Sync, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { refreshResponseSchema, sessionResponseSchema } from "@openvault/api-contract";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionRecord, SessionService } from "../../src/auth/sessions.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestRequestOptions, type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const SESSION_COOKIE = SESSION_COOKIE_NAME;
const CONFIGURED_ORIGIN = "https://vault.example.com";
const CSRF_HEADER = "x-csrf-token";
const TEST_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase";

/**
 * A fixed, independently generated Argon2id hash for {@link TEST_PASSWORD}.
 *
 * It uses the required cost policy and an alphabet that decodes identically as
 * standard or URL-safe base64, so the fixture does not depend on the storage
 * encoder under test.
 */
const PHC_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    statusCode: z.number().optional(),
  }),
});

const sessionEnvelope = z.object({
  success: z.literal(true),
  data: sessionResponseSchema,
});

const refreshEnvelope = z.object({
  success: z.literal(true),
  data: refreshResponseSchema,
});

interface TestUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

interface CredentialState {
  readonly passwordHash: string;
  readonly mustChange: boolean;
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
}

interface IssuedSession {
  readonly secretId: string;
  readonly record: SessionRecord;
}

/** Returns the first non-loopback IPv4 address so the request is a trusted proxy peer. */
function externalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        String(entry.family) === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

const trustedHost = externalIpv4();

/** Trusted proxy ranges for the test app, including the address the test connects from. */
function trustedProxyCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

interface RunningApp {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
}

type SendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername">;

let testDb: TestDatabase;
let running: RunningApp;
let sessions: SessionService;
let nextFixtureSeed = 100;
let nextAddressSeed = 0;

/** Produces a unique ULID-shaped identifier per fixture row. */
function fixtureId(): string {
  nextFixtureSeed += 1;
  return testUlid(nextFixtureSeed);
}

/**
 * Produces a unique forwarded client address inside the documentation range.
 *
 * Distinct addresses keep one test's per-address rate-limit window from
 * masking another test's login behavior.
 *
 * @returns A stable unique IPv4 address for one request.
 */
function uniqueAddress(): string {
  nextAddressSeed += 1;
  if (nextAddressSeed > 250) {
    throw new Error("the test address range is exhausted");
  }
  return `203.0.113.${nextAddressSeed}`;
}

/** Parses the salt and tag bytes out of a stored password hash. */
function parsePhc(phc: string): { readonly salt: Buffer; readonly tag: Buffer } {
  const match = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/.exec(
    phc,
  );
  const saltText = match?.[1];
  const tagText = match?.[2];
  if (saltText === undefined || tagText === undefined) {
    throw new Error(`unexpected password hash format: ${phc}`);
  }
  return {
    salt: Buffer.from(saltText, "base64"),
    tag: Buffer.from(tagText, "base64"),
  };
}

/**
 * Checks a stored hash against a password with the Node Argon2 implementation.
 *
 * This is the independent oracle for password-change assertions; the test never
 * imports the hashing module it is judging.
 *
 * @param password - Candidate password.
 * @param phc - Stored hash to check.
 * @returns True when the password reproduces the stored tag.
 */
function matchesReference(password: string, phc: string): boolean {
  const parsed = parsePhc(phc);
  const derived = argon2Sync("argon2id", {
    message: Buffer.from(password, "utf8"),
    nonce: parsed.salt,
    memory: 65_536,
    passes: 3,
    parallelism: 1,
    tagLength: 32,
  });
  return derived.length === parsed.tag.length && timingSafeEqual(derived, parsed.tag);
}

/** Inserts an active or disabled user principal with a local credential row. */
async function insertUser(
  options: { mustChange?: boolean; status?: "active" | "disabled" } = {},
): Promise<TestUser> {
  const id = fixtureId();
  const name = `Local User ${nextFixtureSeed}`;
  const email = `local-${id.toLowerCase()}@example.test`;
  const status = options.status ?? "active";

  if (status === "disabled") {
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status, disabled_at)
       VALUES (:id, 'user', :name, :email, 'disabled', now())`,
      { id, name, email },
    );
  } else {
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status)
       VALUES (:id, 'user', :name, :email, 'active')`,
      { id, name, email },
    );
  }
  await testDb.db.executeQuery(
    `INSERT INTO local_credentials (principal_id, password_hash, must_change)
     VALUES (:id, :passwordHash, :mustChange)`,
    { id, passwordHash: PHC_HASH, mustChange: options.mustChange ?? false },
  );
  return { id, name, email };
}

/** Reads the credential counters and hash that the login flow maintains. */
async function readCredential(principalId: string): Promise<CredentialState> {
  const result = await testDb.db.executeQuery<{
    password_hash: string;
    must_change: boolean;
    failed_count: number;
    locked_until: Date | null;
  }>(
    `SELECT password_hash, must_change, failed_count, locked_until
       FROM local_credentials
      WHERE principal_id = :principalId`,
    { principalId },
  );
  const row = result.records[0];
  if (row === undefined) {
    throw new Error("expected a local credential row");
  }
  return {
    passwordHash: row.password_hash,
    mustChange: row.must_change,
    failedCount: row.failed_count,
    lockedUntil: row.locked_until,
  };
}

/** Writes a lock state directly so one rejected-login path can be exercised. */
async function setLock(principalId: string, lockedUntil: Date, failedCount: number): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE local_credentials
        SET failed_count = :failedCount, locked_until = :lockedUntil
      WHERE principal_id = :principalId`,
    { principalId, failedCount, lockedUntil: lockedUntil.toISOString() },
  );
}

/** Resolves a live session or fails the current test when the secret is stale. */
async function requireSession(secretId: string): Promise<SessionRecord> {
  const record = await sessions.get(secretId);
  if (record === undefined) {
    throw new Error("expected a live session");
  }
  return record;
}

/** Sends one HTTPS request to the running admin listener from a trusted peer address. */
function send(options: SendOptions): Promise<TestResponse> {
  return testRequest({
    ...options,
    host: trustedHost ?? "127.0.0.1",
    port: running.handle.adminPort,
    ca: running.environment.tls.caPem,
    servername: "localhost",
  });
}

/** Submits local credentials from one forwarded client address. */
function login(identifier: string, password: string, forwardedFor: string): Promise<TestResponse> {
  return send({
    path: "/v1/auth/local/login",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: CONFIGURED_ORIGIN,
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify({ identifier, password }),
  });
}

/** Submits a password change with the session cookie, CSRF token, and origin. */
function changePassword(
  session: IssuedSession,
  body: { readonly currentPassword: string; readonly newPassword: string },
  forwardedFor: string,
): Promise<TestResponse> {
  return send({
    path: "/v1/auth/password",
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${session.secretId}`,
      [CSRF_HEADER]: session.record.csrfToken,
      origin: CONFIGURED_ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify(body),
  });
}

/** Reads one Set-Cookie header by name. */
function findSetCookie(response: TestResponse, name: string): string | undefined {
  const raw = response.headers["set-cookie"];
  const headers = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return headers.find((header) => header.toLowerCase().startsWith(`${name.toLowerCase()}=`));
}

/** Reads the cookie value from a response, or `undefined` when it is absent. */
function cookieValue(response: TestResponse, name: string): string | undefined {
  const header = findSetCookie(response, name);
  if (header === undefined) {
    return undefined;
  }
  const [value] = header.slice(name.length + 1).split(";");
  return value ?? "";
}

/** Returns the full Set-Cookie header or fails the current test when it is missing. */
function requireSetCookie(response: TestResponse, name: string): string {
  const header = findSetCookie(response, name);
  if (header === undefined) {
    throw new Error(`expected a ${name} Set-Cookie header`);
  }
  return header;
}

/** Returns the cookie value or fails the current test when it is missing. */
function requireCookieValue(response: TestResponse, name: string): string {
  const value = cookieValue(response, name);
  if (value === undefined || value === "") {
    throw new Error(`expected a non-empty ${name} cookie value`);
  }
  return value;
}

/** Asserts the hardened attributes the session cookie must always carry. */
function expectSessionCookieAttributes(header: string): void {
  expect(header).toMatch(/;\s*HttpOnly/i);
  expect(header).toMatch(/;\s*Secure/i);
  expect(header).toMatch(/;\s*SameSite=Lax/i);
  expect(header).toMatch(/;\s*Path=\//i);
  expect(header).not.toMatch(/;\s*Domain=/i);
}

async function startApp(environment: ServerEnvironment): Promise<RunningApp> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, { database, tls, keyring });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return { app, handle, environment };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  const environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
  });
  running = await startApp(environment);
  sessions = await running.app.getService<SessionService>("sessions");
}, 30_000);

afterAll(async () => {
  if (running !== undefined) {
    await running.handle.stop();
    running.environment.cleanup();
  }
  if (testDb !== undefined) {
    await testDb.cleanup();
  }
});

describe.skipIf(trustedHost === undefined)("local authentication", () => {
  describe("local login", () => {
    it("should return a hardened session cookie and the signed-in user when credentials are valid", async () => {
      const user = await insertUser();

      const response = await login(user.email, TEST_PASSWORD, uniqueAddress());
      const data = sessionEnvelope.parse(response.json).data;

      expect(response.status).toBe(200);
      expect(data.user).toEqual({
        id: user.id,
        name: user.name,
        email: user.email,
        authMethod: "local",
      });
      expect(data.mustChangePassword).toBe(false);
      expect(data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const header = requireSetCookie(response, SESSION_COOKIE);
      expect(header.startsWith("__Host-ov_session=")).toBe(true);
      expectSessionCookieAttributes(header);
      const secretId = requireCookieValue(response, SESSION_COOKIE);
      const record = await requireSession(secretId);

      expect(secretId).not.toBe(data.csrfToken);
      expect(record.principalId).toBe(user.id);
      expect(record.authMethod).toBe("local");
      expect(record.csrfToken).toBe(data.csrfToken);
      expect(data.expiresAt).toBe(new Date(record.expiresAt).toISOString());
      expect(data.lastLoginAt).toBe(new Date(record.createdAt).toISOString());
    });

    it("should accept a mixed-case identifier with surrounding whitespace", async () => {
      const user = await insertUser();

      const response = await login(
        `  ${user.email.toUpperCase()}  `,
        TEST_PASSWORD,
        uniqueAddress(),
      );
      const data = sessionEnvelope.parse(response.json).data;

      expect(response.status).toBe(200);
      expect(data.user.id).toBe(user.id);
      expect(requireCookieValue(response, SESSION_COOKIE)).not.toBe("");
    });
  });

  describe("generic login failures", () => {
    it("should return one identical invalid_credentials response and hash an unused password on every rejection path", async () => {
      const wrongPasswordUser = await insertUser();
      const disabledUser = await insertUser({ status: "disabled" });
      const lockedUser = await insertUser();
      const lockedUntil = new Date(Date.now() + 5 * 60_000);
      await setLock(lockedUser.id, lockedUntil, 5);
      const unknownIdentifier = `unknown-${fixtureId().toLowerCase()}@example.test`;

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
        const response = await login(attempt.identifier, attempt.password, uniqueAddress());
        const elapsedMs = Date.now() - startedAt;
        const parsed = errorEnvelope.parse(response.json);
        observed.push({ status: response.status, error: parsed.error });

        if (attempt.generic) {
          // A generic rejection still performs one full-cost Argon2id derivation.
          // A fast return would reveal that the account has no usable password.
          expect(
            elapsedMs,
            `${attempt.label} must spend password-hash time`,
          ).toBeGreaterThanOrEqual(50);
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

      const wrongState = await readCredential(wrongPasswordUser.id);
      expect(wrongState.failedCount).toBe(1);
      expect(wrongState.lockedUntil).toBeNull();

      const disabledState = await readCredential(disabledUser.id);
      expect(disabledState.failedCount).toBe(0);
      expect(disabledState.lockedUntil).toBeNull();

      const lockedState = await readCredential(lockedUser.id);
      expect(lockedState.failedCount).toBe(5);
      expect(lockedState.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    });

    it("should reject a stored hash outside the policy without incrementing the counter", async () => {
      const user = await insertUser();
      await testDb.db.executeQuery(
        "UPDATE local_credentials SET password_hash = '$argon2id$bad' WHERE principal_id = :id",
        { id: user.id },
      );

      const response = await login(user.email, TEST_PASSWORD, uniqueAddress());

      expect(response.status).toBe(401);
      expect(errorEnvelope.parse(response.json).error.code).toBe("invalid_credentials");
      const state = await readCredential(user.id);
      expect(state.failedCount).toBe(0);
    });
  });

  describe("login lockout", () => {
    it("should lock the credential for fifteen minutes after five failures and refuse a correct password", async () => {
      const user = await insertUser();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await login(user.email, `wrong password ${attempt}`, uniqueAddress());
        expect(response.status).toBe(401);
        expect(errorEnvelope.parse(response.json).error.code).toBe("invalid_credentials");
      }

      const locked = await readCredential(user.id);
      expect(locked.failedCount).toBe(5);
      const lockedUntil = locked.lockedUntil;
      if (lockedUntil === null) {
        throw new Error("expected the credential to be locked");
      }
      const remainingMs = lockedUntil.getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(14 * 60_000);
      expect(remainingMs).toBeLessThanOrEqual(15 * 60_000 + 5_000);

      const sixth = await login(user.email, TEST_PASSWORD, uniqueAddress());
      expect(sixth.status).toBe(401);
      expect(errorEnvelope.parse(sixth.json).error.code).toBe("invalid_credentials");

      const after = await readCredential(user.id);
      expect(after.failedCount).toBe(5);
      expect(after.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    });

    it("should reset the window and clear an expired lock", async () => {
      const user = await insertUser();
      await testDb.db.executeQuery(
        `UPDATE local_credentials
            SET failed_count = 5,
                locked_until = now() - interval '1 minute',
                updated_at = now() - interval '16 minutes'
          WHERE principal_id = :principalId`,
        { principalId: user.id },
      );

      const wrong = await login(user.email, "still the wrong password", uniqueAddress());
      expect(wrong.status).toBe(401);

      const after = await readCredential(user.id);
      expect(after.failedCount).toBe(1);
      expect(after.lockedUntil).toBeNull();

      const success = await login(user.email, TEST_PASSWORD, uniqueAddress());
      expect(success.status).toBe(200);
    });

    it("should reset the failure counter when a login succeeds after four failures", async () => {
      const user = await insertUser();

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await login(user.email, `wrong password ${attempt}`, uniqueAddress());
        expect(response.status).toBe(401);
      }
      const before = await readCredential(user.id);
      expect(before.failedCount).toBe(4);
      expect(before.lockedUntil).toBeNull();

      const success = await login(user.email, TEST_PASSWORD, uniqueAddress());
      expect(success.status).toBe(200);
      expect(sessionEnvelope.parse(success.json).data.mustChangePassword).toBe(false);

      const after = await readCredential(user.id);
      expect(after.failedCount).toBe(0);
      expect(after.lockedUntil).toBeNull();
    });
  });

  describe("login rate limits", () => {
    it("should reject the sixth login from one address within a minute with a rate-limit error", async () => {
      const identifier = `address-${fixtureId().toLowerCase()}@example.test`;
      const address = uniqueAddress();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await login(identifier, "wrong password", address);
        expect(response.status).toBe(401);
      }

      const limited = await login(identifier, "wrong password", address);
      expect(limited.status).toBe(429);
      expect(errorEnvelope.parse(limited.json).error.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("should reject the eleventh attempt for one identifier from separate addresses with a rate-limit error", async () => {
      const identifier = `account-${fixtureId().toLowerCase()}@example.test`;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const variant = attempt % 2 === 0 ? `  ${identifier.toUpperCase()}  ` : identifier;
        const response = await login(variant, "wrong password", uniqueAddress());
        expect(response.status).toBe(401);
      }

      const limited = await login(identifier, "wrong password", uniqueAddress());
      expect(limited.status).toBe(429);
      expect(errorEnvelope.parse(limited.json).error.code).toBe("RATE_LIMIT_EXCEEDED");
    });
  });

  describe("password change", () => {
    it("should reject a wrong current password while leaving the stored hash and counters unchanged", async () => {
      const user = await insertUser();
      const session = await sessions.create({ principalId: user.id, authMethod: "local" });
      const before = await readCredential(user.id);

      const response = await changePassword(
        session,
        { currentPassword: "an incorrect current password", newPassword: NEW_PASSWORD },
        uniqueAddress(),
      );

      expect(response.status).toBe(401);
      expect(errorEnvelope.parse(response.json).error).toMatchObject({
        code: "invalid_credentials",
        statusCode: 401,
      });

      const after = await readCredential(user.id);
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(matchesReference(TEST_PASSWORD, after.passwordHash)).toBe(true);
      expect(matchesReference(NEW_PASSWORD, after.passwordHash)).toBe(false);
      expect(after.failedCount).toBe(0);
    });

    it("should reject a new password shorter than twelve characters without changing the stored hash", async () => {
      const user = await insertUser();
      const session = await sessions.create({ principalId: user.id, authMethod: "local" });
      const before = await readCredential(user.id);

      const response = await changePassword(
        session,
        { currentPassword: TEST_PASSWORD, newPassword: "short-pass!" },
        uniqueAddress(),
      );

      expect(response.status).toBe(400);
      expect(errorEnvelope.parse(response.json).success).toBe(false);

      const after = await readCredential(user.id);
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(matchesReference(TEST_PASSWORD, after.passwordHash)).toBe(true);
    });

    it("should rotate the session and revoke the other sessions when the password changes", async () => {
      const user = await insertUser({ mustChange: true });
      const current = await sessions.create({ principalId: user.id, authMethod: "local" });
      const other = await sessions.create({ principalId: user.id, authMethod: "local" });
      const before = await readCredential(user.id);
      expect(before.mustChange).toBe(true);

      const response = await changePassword(
        current,
        { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
        uniqueAddress(),
      );
      const data = refreshEnvelope.parse(response.json).data;

      expect(response.status).toBe(200);
      expectSessionCookieAttributes(requireSetCookie(response, SESSION_COOKIE));
      const rotatedSecret = requireCookieValue(response, SESSION_COOKIE);
      expect(rotatedSecret).not.toBe(current.secretId);
      expect(data.csrfToken).not.toBe(current.record.csrfToken);
      expect(data.expiresAt).toBe(new Date(current.record.expiresAt).toISOString());

      await expect(sessions.get(current.secretId)).resolves.toBeUndefined();
      await expect(sessions.get(other.secretId)).resolves.toBeUndefined();
      const rotated = await requireSession(rotatedSecret);
      expect(rotated.publicId).toBe(current.record.publicId);
      expect(rotated.principalId).toBe(user.id);
      expect(rotated.csrfToken).toBe(data.csrfToken);
      expect(rotated.expiresAt).toBe(current.record.expiresAt);

      const listed = await sessions.list(user.id);
      expect(listed.map((entry) => entry.publicId)).toEqual([current.record.publicId]);

      const after = await readCredential(user.id);
      expect(after.mustChange).toBe(false);
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(matchesReference(NEW_PASSWORD, after.passwordHash)).toBe(true);
      expect(matchesReference(TEST_PASSWORD, after.passwordHash)).toBe(false);

      const me = await send({
        path: "/v1/auth/me",
        headers: { cookie: `${SESSION_COOKIE}=${rotatedSecret}` },
      });
      expect(me.status).toBe(200);
      expect(sessionEnvelope.parse(me.json).data.mustChangePassword).toBe(false);

      const late = await send({
        path: "/v1/auth/refresh",
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${current.secretId}`,
          [CSRF_HEADER]: current.record.csrfToken,
          origin: CONFIGURED_ORIGIN,
        },
      });
      expect(late.status).toBe(401);
      expect(errorEnvelope.parse(late.json).error.code).toBe("authentication_required");
    });

    it("should let only one of two concurrent password changes win", async () => {
      const user = await insertUser();
      const first = await sessions.create({ principalId: user.id, authMethod: "local" });
      const second = await sessions.create({ principalId: user.id, authMethod: "local" });
      const otherPassword = "another new passphrase";

      const [firstResponse, secondResponse] = await Promise.all([
        changePassword(
          first,
          { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
          uniqueAddress(),
        ),
        changePassword(
          second,
          { currentPassword: TEST_PASSWORD, newPassword: otherPassword },
          uniqueAddress(),
        ),
      ]);

      const successful = [firstResponse, secondResponse].filter(
        (response) => response.status === 200,
      );
      expect(successful).toHaveLength(1);

      const winnerPassword = successful[0] === firstResponse ? NEW_PASSWORD : otherPassword;
      const after = await readCredential(user.id);
      expect(matchesReference(winnerPassword, after.passwordHash)).toBe(true);
      expect(matchesReference(TEST_PASSWORD, after.passwordHash)).toBe(false);
    });
  });

  describe("forced password change", () => {
    it("should block a bootstrap credential from an authenticated route until the password changes", async () => {
      const user = await insertUser({ mustChange: true });

      const loginResponse = await login(user.email, TEST_PASSWORD, uniqueAddress());
      const data = sessionEnvelope.parse(loginResponse.json).data;
      expect(loginResponse.status).toBe(200);
      expect(data.mustChangePassword).toBe(true);
      const secretId = requireCookieValue(loginResponse, SESSION_COOKIE);

      const blocked = await send({
        path: "/v1/auth/sessions",
        headers: { cookie: `${SESSION_COOKIE}=${secretId}` },
      });
      expect(blocked.status).toBe(403);
      expect(errorEnvelope.parse(blocked.json).error).toMatchObject({
        code: "password_change_required",
        statusCode: 403,
      });
    });
  });
});

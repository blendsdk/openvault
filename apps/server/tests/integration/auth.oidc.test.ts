import { networkInterfaces } from "node:os";
import type { Writable } from "node:stream";
import { type AuthUser, sessionResponseSchema } from "@openvault/api-contract";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureApplicationDependencies,
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { FakeOidcProvider, type FakeOidcUser } from "./helpers/fake-oidc-provider.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestRequestOptions, type TestResponse, testRequest } from "./helpers/https.js";
import { MemoryDestination } from "./helpers/memory-destination.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const SESSION_COOKIE = SESSION_COOKIE_NAME;
const BINDING_COOKIE = "__Host-ov_oidc";
const CONFIGURED_ORIGIN = "https://vault.example.com";
const CLIENT_ID = "openvault-oidc-test-client";
const CLIENT_SECRET = "openvault-oidc-test-client-secret";
const REDIRECT_URL = `${CONFIGURED_ORIGIN}/v1/auth/callback`;
const ALLOWED_DOMAIN = "allowed.test";
const SESSION_KEY_PREFIX = "session:";

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

interface CacheWrite {
  readonly key: string;
  readonly value: string;
}

/**
 * Memory cache that records every value written by the application.
 *
 * The OIDC flow stores transient flow state and sessions here. Keeping the
 * serialized values lets a specification test prove that no token ever becomes
 * a cache entry, regardless of the cache key.
 */
class RecordingCache extends MemoryCacheProvider {
  public readonly setEntries: CacheWrite[] = [];

  public constructor() {
    super({ rootKey: "openvault-oidc-spec", cleanupIntervalMs: 60_000 });
  }

  public override async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.setEntries.push({ key, value: JSON.stringify(value) });
    await super.set(key, value, ttlSeconds);
  }
}

/** Optional collaboration overrides the OIDC test needs from the application. */
interface AuthOverrides {
  readonly fetch?: typeof globalThis.fetch;
  readonly cache?: MemoryCacheProvider;
  readonly now?: () => number;
  readonly sweepIntervalMs?: number;
}

interface RunningApp {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
}

interface StartOptions {
  readonly authOverrides?: AuthOverrides;
  readonly loggerDestination?: Writable;
}

interface PrincipalRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
}

/** One parsed authorization redirect from the login endpoint. */
interface AuthorizationFlow {
  readonly location: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  /** Browser-binding value from the login cookie, or `undefined` when it is absent. */
  readonly bindingCookie: string | undefined;
}

/** Options for one callback request. */
interface CallbackOptions {
  /** Browser-binding value captured from the login redirect. */
  readonly bindingCookie?: string;
  /** Set false to send the callback without the browser-binding cookie. */
  readonly sendBindingCookie?: boolean;
}

interface CompleteLoginOptions {
  readonly user: FakeOidcUser;
  readonly returnTo?: string;
  /** Nonce to sign into the ID token; defaults to the flow nonce. */
  readonly nonce?: string;
  /** Subject for the ID token; defaults to the user's subject. */
  readonly idTokenSubject?: string;
  /** Subject returned by UserInfo; defaults to the user's subject. */
  readonly userInfoSubject?: string;
  /** Overrides the browser-binding cookie sent to the callback. */
  readonly bindingCookie?: string;
  /** Set false to send the callback without the browser-binding cookie. */
  readonly sendBindingCookie?: boolean;
}

type SendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername">;

let testDb: TestDatabase;
let provider: FakeOidcProvider;
let recordingCache: RecordingCache;
let destination: MemoryDestination;
let sessions: SessionService;
let configured: RunningApp;
let unconfigured: RunningApp;
let nextFixtureSeed = 100;
let nextAddressSeed = 0;

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

/** Increments the fixture seed so every synthetic identity is unique. */
function nextSeed(): number {
  nextFixtureSeed += 1;
  return nextFixtureSeed;
}

/** Produces a unique ULID-shaped identifier per fixture row or OIDC subject. */
function fixtureId(): string {
  return testUlid(nextSeed());
}

/** Produces a unique email inside one domain. */
function uniqueEmail(domain = ALLOWED_DOMAIN): string {
  return `oidc-${testUlid(nextSeed()).toLowerCase()}@${domain}`;
}

/**
 * Produces a unique forwarded client address inside the documentation range.
 *
 * Distinct addresses keep one test's login limiter window from masking another
 * test's OIDC flow.
 */
function uniqueAddress(): string {
  nextAddressSeed += 1;
  if (nextAddressSeed > 250) {
    throw new Error("the test address range is exhausted");
  }
  return `203.0.113.${nextAddressSeed}`;
}

/** Builds a running application with real HTTPS and a disposable database. */
async function startApp(
  environment: ServerEnvironment,
  options: StartOptions = {},
): Promise<RunningApp> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const dependencies: SecureApplicationDependencies & {
    readonly authOverrides?: AuthOverrides;
  } = {
    database,
    tls,
    keyring,
    ...(options.authOverrides === undefined ? {} : { authOverrides: options.authOverrides }),
    ...(options.loggerDestination === undefined
      ? {}
      : { loggerDestination: options.loggerDestination }),
  };
  const app = await createTestApplication(environment.config, dependencies);
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return { app, handle, environment };
}

/** Sends one HTTPS request to a running admin listener from a trusted peer address. */
function sendTo(target: RunningApp, options: SendOptions): Promise<TestResponse> {
  return testRequest({
    ...options,
    host: trustedHost ?? "127.0.0.1",
    port: target.handle.adminPort,
    ca: target.environment.tls.caPem,
    servername: "localhost",
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

/** Asserts the hardened attributes every security cookie must carry. */
function expectHardenedCookieAttributes(header: string): void {
  expect(header).toMatch(/;\s*HttpOnly/i);
  expect(header).toMatch(/;\s*Secure/i);
  expect(header).toMatch(/;\s*SameSite=Lax/i);
  expect(header).toMatch(/;\s*Path=\//i);
  expect(header).not.toMatch(/;\s*Domain=/i);
}

/** Asserts that a rejected callback never sets a session cookie. */
function expectNoSessionCookie(response: TestResponse): void {
  expect(findSetCookie(response, SESSION_COOKIE)).toBeUndefined();
}

/** Count of cache writes recorded so far, used to scope an assertion to one flow. */
function cacheMark(): number {
  return recordingCache.setEntries.length;
}

/** Session cache keys written after a mark. */
function sessionKeysSince(mark: number): readonly string[] {
  return recordingCache.setEntries
    .slice(mark)
    .map((entry) => entry.key)
    .filter((key) => key.startsWith(SESSION_KEY_PREFIX));
}

/** Captured log text written after a mark. */
function logsSince(mark: number): string {
  return destination.lines().slice(mark).join("\n");
}

/**
 * Waits until pino has flushed every line written for the completed request.
 *
 * The trailing write is processed after earlier stream writes, so a token that
 * leaked into the request log cannot hide behind a scheduling delay.
 */
async function flushLogs(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  await new Promise<void>((resolve, reject) => {
    destination.write("", (error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** Requests the login redirect and parses the transient values out of it. */
async function beginLogin(target: RunningApp, returnTo?: string): Promise<AuthorizationFlow> {
  const path =
    returnTo === undefined
      ? "/v1/auth/login"
      : `/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await sendTo(target, {
    path,
    headers: { "x-forwarded-for": uniqueAddress() },
  });
  if (response.status !== 302) {
    throw new Error(`expected a login redirect, received ${response.status}: ${response.body}`);
  }
  const location = response.headers.location;
  if (location === undefined) {
    throw new Error("expected the login response to carry a Location header");
  }
  const url = new URL(location, CONFIGURED_ORIGIN);
  const state = url.searchParams.get("state");
  const nonce = url.searchParams.get("nonce");
  const codeChallenge = url.searchParams.get("code_challenge");
  if (state === null || nonce === null || codeChallenge === null) {
    throw new Error("the authorization URL is missing state, nonce, or the PKCE challenge");
  }
  return {
    location: url.href,
    state,
    nonce,
    codeChallenge,
    bindingCookie: cookieValue(response, BINDING_COOKIE),
  };
}

/** Sends the authorization code and original state to the callback endpoint. */
function sendCallback(
  target: RunningApp,
  code: string,
  state: string,
  options: CallbackOptions = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = { "x-forwarded-for": uniqueAddress() };
  if (options.sendBindingCookie !== false && options.bindingCookie !== undefined) {
    headers.cookie = `${BINDING_COOKIE}=${options.bindingCookie}`;
  }
  return sendTo(target, {
    path: `/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers,
  });
}

/** Runs the login redirect, issues a provider code, and calls the callback. */
async function completeLogin(
  target: RunningApp,
  options: CompleteLoginOptions,
): Promise<{
  readonly flow: AuthorizationFlow;
  readonly code: string;
  readonly callback: TestResponse;
}> {
  const flow = await beginLogin(target, options.returnTo);
  const code = provider.issueCode({
    nonce: options.nonce ?? flow.nonce,
    codeChallenge: flow.codeChallenge,
    user: options.user,
    ...(options.idTokenSubject === undefined ? {} : { idTokenSubject: options.idTokenSubject }),
    ...(options.userInfoSubject === undefined ? {} : { userInfoSubject: options.userInfoSubject }),
  });
  const bindingCookie = options.bindingCookie ?? flow.bindingCookie;
  const callback = await sendCallback(target, code, flow.state, {
    ...(bindingCookie === undefined ? {} : { bindingCookie }),
    ...(options.sendBindingCookie === undefined
      ? {}
      : { sendBindingCookie: options.sendBindingCookie }),
  });
  return { flow, code, callback };
}

/** Follows a successful callback cookie to `/me` and returns the public user. */
async function requireAuthenticatedUser(
  target: RunningApp,
  callback: TestResponse,
): Promise<{ readonly secret: string; readonly user: AuthUser }> {
  expect(callback.status).toBe(302);
  const header = requireSetCookie(callback, SESSION_COOKIE);
  expectHardenedCookieAttributes(header);
  const secret = requireCookieValue(callback, SESSION_COOKIE);
  const me = await sendTo(target, {
    path: "/v1/auth/me",
    headers: { cookie: `${SESSION_COOKIE}=${secret}` },
  });
  expect(me.status).toBe(200);
  const data = sessionEnvelope.parse(me.json).data;
  return { secret, user: data.user };
}

/** Inserts an active or disabled user principal. */
async function insertPrincipal(options: {
  readonly email: string;
  readonly name?: string;
  readonly status?: "active" | "disabled";
}): Promise<string> {
  const id = fixtureId();
  const name = options.name ?? `OIDC Fixture ${id}`;
  if (options.status === "disabled") {
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status, disabled_at)
       VALUES (:id, 'user', :name, :email, 'disabled', now())`,
      { id, name, email: options.email },
    );
  } else {
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status)
       VALUES (:id, 'user', :name, :email, 'active')`,
      { id, name, email: options.email },
    );
  }
  return id;
}

/** Links an external subject to an existing principal. */
async function insertOidcIdentity(principalId: string, subject: string): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO oidc_identities (principal_id, issuer, subject)
     VALUES (:principalId, :issuer, :subject)`,
    { principalId, issuer: provider.issuer, subject },
  );
}

/** Reads the principal rows that use one email, case-insensitively. */
async function principalsByEmail(email: string): Promise<readonly PrincipalRow[]> {
  const result = await testDb.db.executeQuery<PrincipalRow>(
    `SELECT id, kind, name, email, status
       FROM principals
      WHERE lower(email) = :email`,
    { email: email.toLowerCase() },
  );
  return result.records;
}

/** Counts matching rows for a scalar assertion. */
async function countRows(sql: string, parameters: Record<string, string>): Promise<number> {
  const result = await testDb.db.executeQuery<{ count: number }>(sql, parameters);
  return result.records[0]?.count ?? 0;
}

/** Counts identities linked to one external subject. */
function countIdentities(subject: string): Promise<number> {
  return countRows(
    `SELECT count(*)::int AS count
       FROM oidc_identities
      WHERE issuer = :issuer AND subject = :subject`,
    { issuer: provider.issuer, subject },
  );
}

/** Counts role assignments granted to a principal. */
function countRoleAssignments(principalId: string): Promise<number> {
  return countRows(
    `SELECT count(*)::int AS count
       FROM role_assignments
      WHERE principal_id = :principalId`,
    { principalId },
  );
}

/** Counts local credentials attached to a principal. */
function countLocalCredentials(principalId: string): Promise<number> {
  return countRows(
    `SELECT count(*)::int AS count
       FROM local_credentials
      WHERE principal_id = :principalId`,
    { principalId },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  provider = await FakeOidcProvider.start({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUrl: REDIRECT_URL,
  });
  recordingCache = new RecordingCache();
  destination = new MemoryDestination();

  const configuredEnvironment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
    OPENVAULT_OIDC_ISSUER: provider.issuer,
    OPENVAULT_OIDC_CLIENT_ID: CLIENT_ID,
    OPENVAULT_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OPENVAULT_OIDC_REDIRECT_URL: REDIRECT_URL,
    OPENVAULT_OIDC_ALLOWED_DOMAINS: ALLOWED_DOMAIN,
  });
  configured = await startApp(configuredEnvironment, {
    authOverrides: {
      fetch: provider.fetch,
      cache: recordingCache,
      now: () => Date.now(),
      sweepIntervalMs: 0,
    },
    loggerDestination: destination,
  });
  sessions = await configured.app.getService<SessionService>("sessions");

  const unconfiguredEnvironment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
  });
  unconfigured = await startApp(unconfiguredEnvironment);
}, 30_000);

afterAll(async () => {
  if (configured !== undefined) {
    await configured.handle.stop();
    configured.environment.cleanup();
  }
  if (unconfigured !== undefined) {
    await unconfigured.handle.stop();
    unconfigured.environment.cleanup();
  }
  if (provider !== undefined) {
    await provider.close();
  }
  if (testDb !== undefined) {
    await testDb.cleanup();
  }
});

describe.skipIf(trustedHost === undefined)("OIDC authentication", () => {
  describe("unconfigured provider", () => {
    it("should return oidc_not_configured when login is requested without OIDC settings", async () => {
      const response = await sendTo(unconfigured, {
        path: "/v1/auth/login",
        headers: { "x-forwarded-for": uniqueAddress() },
      });

      expect(response.status).toBe(404);
      expect(errorEnvelope.parse(response.json).error).toMatchObject({
        code: "oidc_not_configured",
        statusCode: 404,
      });
      expectNoSessionCookie(response);
    });

    it("should report only local authentication when OIDC is not configured", async () => {
      const response = await sendTo(unconfigured, { path: "/v1/meta/auth" });

      expect(response.status).toBe(200);
      expect(response.json).toEqual({ success: true, data: { local: true, oidc: false } });
    });
  });

  describe("authorization request", () => {
    it("should redirect to the provider with PKCE, state, nonce, and the required scopes", async () => {
      const flow = await beginLogin(configured);
      const url = new URL(flow.location);

      expect(url.origin).toBe(new URL(provider.issuer).origin);
      expect(url.pathname).toBe("/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")).toBe("openid profile email");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);
      expect(url.searchParams.get("state")).toBe(flow.state);
      expect(url.searchParams.get("nonce")).toBe(flow.nonce);
      expect(flow.state).not.toBe("");
      expect(flow.nonce).not.toBe("");
      expect(flow.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // The provider must accept the request the client built: correct client,
      // registered redirect URI, PKCE S256, nonce, and the three scopes.
      provider.authorizeAs({ subject: "authorization-check", email: uniqueEmail() });
      const authorization = await provider.fetch(flow.location);
      expect(authorization.status).toBe(302);
      expect(provider.lastAuthorization()).toMatchObject({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URL,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: flow.codeChallenge,
        codeChallengeMethod: "S256",
        scope: "openid profile email",
        responseType: "code",
      });
    });
  });

  describe("browser binding", () => {
    it("should set a hardened browser-binding cookie when login starts", async () => {
      const response = await sendTo(configured, {
        path: "/v1/auth/login",
        headers: { "x-forwarded-for": uniqueAddress() },
      });

      expect(response.status).toBe(302);
      const header = requireSetCookie(response, BINDING_COOKIE);
      expectHardenedCookieAttributes(header);
      requireCookieValue(response, BINDING_COOKIE);
    });

    it("should never store the raw browser binding in the transient cache", async () => {
      const mark = cacheMark();
      const flow = await beginLogin(configured);
      const binding = flow.bindingCookie;
      if (binding === undefined || binding === "") {
        throw new Error("expected the login response to set the browser-binding cookie");
      }

      const entries = recordingCache.setEntries.slice(mark);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.key).not.toContain(binding);
        expect(entry.value).not.toContain(binding);
      }
    });

    it("should reject a valid callback when the browser-binding cookie is missing", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
        sendBindingCookie: false,
      });

      expect(callback.status).toBe(400);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "oidc_callback_failed",
        statusCode: 400,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });

    it("should reject a valid callback when the browser-binding cookie does not match", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
        bindingCookie: `mismatched-${fixtureId()}`,
      });

      expect(callback.status).toBe(400);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "oidc_callback_failed",
        statusCode: 400,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });
  });

  describe("provider outage", () => {
    it("should return oidc_unavailable when the provider cannot be reached during login", async () => {
      const environment = createServerEnvironment({
        OPENVAULT_DB_URL: testDb.url,
        OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
        OPENVAULT_OIDC_ISSUER: provider.issuer,
        OPENVAULT_OIDC_CLIENT_ID: CLIENT_ID,
        OPENVAULT_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        OPENVAULT_OIDC_REDIRECT_URL: REDIRECT_URL,
        OPENVAULT_OIDC_ALLOWED_DOMAINS: ALLOWED_DOMAIN,
      });
      let outage: RunningApp | undefined;
      try {
        outage = await startApp(environment, {
          authOverrides: {
            fetch: async () => {
              throw new Error("the OIDC provider is unreachable");
            },
          },
        });

        const response = await sendTo(outage, {
          path: "/v1/auth/login",
          headers: { "x-forwarded-for": uniqueAddress() },
        });

        expect(response.status).toBe(503);
        expect(errorEnvelope.parse(response.json).error).toMatchObject({
          code: "oidc_unavailable",
          statusCode: 503,
        });
        expectNoSessionCookie(response);
      } finally {
        await outage?.handle.stop();
        environment.cleanup();
      }
    });
  });

  describe("callback", () => {
    it("should create an OIDC session and return the signed-in user when the callback is valid", async () => {
      const subject = fixtureId();
      const email = uniqueEmail();
      const name = "OIDC Login User";

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true, name },
      });
      const { secret, user } = await requireAuthenticatedUser(configured, callback);

      expect(user).toEqual({
        id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        name,
        email,
        authMethod: "oidc",
      });

      const location = callback.headers.location;
      expect(location).toBeDefined();
      expect(new URL(location ?? "", CONFIGURED_ORIGIN).href).toBe(`${CONFIGURED_ORIGIN}/`);

      const record = await sessions.get(secret);
      expect(record?.authMethod).toBe("oidc");
      expect(record?.principalId).toBe(user.id);

      const rows = await principalsByEmail(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: user.id, kind: "user", status: "active", email });
      await expect(countIdentities(subject)).resolves.toBe(1);
    });

    it("should reject a callback whose ID token nonce does not match the flow state", async () => {
      const mark = cacheMark();
      const email = uniqueEmail();
      const subject = fixtureId();

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
        nonce: `mismatched-${fixtureId()}`,
      });

      expect(callback.status).toBe(400);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "oidc_callback_failed",
        statusCode: 400,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });

    it("should reject a callback with an unrecognized state before contacting the token endpoint", async () => {
      const mark = cacheMark();
      const tokenRequests = provider.tokenRequests();

      const response = await sendCallback(configured, "unused-code", `unknown-${fixtureId()}`, {
        bindingCookie: `unbound-${fixtureId()}`,
      });

      expect(response.status).toBe(400);
      expect(errorEnvelope.parse(response.json).error).toMatchObject({
        code: "oidc_callback_failed",
        statusCode: 400,
      });
      expectNoSessionCookie(response);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      expect(provider.tokenRequests()).toBe(tokenRequests);
    });

    it("should reject a replayed state and keep exactly one session from the first callback", async () => {
      const mark = cacheMark();
      const email = uniqueEmail();
      const subject = fixtureId();

      const { flow, code, callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
      });
      expect(callback.status).toBe(302);
      const secret = requireCookieValue(callback, SESSION_COOKIE);
      const tokenRequests = provider.tokenRequests();

      const replay = await sendCallback(configured, code, flow.state, {
        ...(flow.bindingCookie === undefined ? {} : { bindingCookie: flow.bindingCookie }),
      });

      expect(replay.status).toBe(400);
      expect(errorEnvelope.parse(replay.json).error.code).toBe("oidc_callback_failed");
      expectNoSessionCookie(replay);
      expect(sessionKeysSince(mark)).toHaveLength(1);
      expect(provider.tokenRequests()).toBe(tokenRequests);

      const me = await sendTo(configured, {
        path: "/v1/auth/me",
        headers: { cookie: `${SESSION_COOKIE}=${secret}` },
      });
      expect(me.status).toBe(200);
      expect(sessionEnvelope.parse(me.json).data.user.email).toBe(email);
    });

    it("should reject a callback when the UserInfo subject differs from the ID token subject", async () => {
      const mark = cacheMark();
      const email = uniqueEmail();
      const subject = fixtureId();

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
        userInfoSubject: fixtureId(),
      });

      expect(callback.status).toBe(400);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "oidc_callback_failed",
        statusCode: 400,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });
  });

  describe("token non-persistence", () => {
    it("should never store or log access, refresh, or ID tokens during a valid login", async () => {
      const cacheStart = cacheMark();
      const logStart = destination.lines().length;
      const tokenStart = provider.issuedTokens().length;

      const email = uniqueEmail();
      const subject = fixtureId();
      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true, name: "Token Check" },
      });
      expect(callback.status).toBe(302);
      await flushLogs();

      const tokens = provider.issuedTokens().slice(tokenStart);
      expect(tokens).toHaveLength(3);
      expect(tokens.some((token) => token.split(".").length === 3)).toBe(true);

      const cacheValues = recordingCache.setEntries.slice(cacheStart).map((entry) => entry.value);
      const capturedLogs = logsSince(logStart);
      const principalRows = await testDb.db.executeQuery<Record<string, unknown>>(
        "SELECT * FROM principals",
      );
      const identityRows = await testDb.db.executeQuery<Record<string, unknown>>(
        "SELECT * FROM oidc_identities",
      );
      const persisted = JSON.stringify({
        cacheValues,
        capturedLogs,
        principalRows: principalRows.records,
        identityRows: identityRows.records,
      });

      for (const token of tokens) {
        expect(persisted).not.toContain(token);
      }
    });
  });

  describe("identity linking and just-in-time provisioning", () => {
    it("should provision a role-less principal and a session when the verified email is in an allowed domain", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();
      const name = "Just In Time User";

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true, name },
      });
      const { secret, user } = await requireAuthenticatedUser(configured, callback);

      expect(user).toMatchObject({ name, email, authMethod: "oidc" });
      const rows = await principalsByEmail(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: user.id,
        kind: "user",
        name,
        email,
        status: "active",
      });
      await expect(countRoleAssignments(user.id)).resolves.toBe(0);
      await expect(countLocalCredentials(user.id)).resolves.toBe(0);
      await expect(countIdentities(subject)).resolves.toBe(1);
      expect(sessionKeysSince(mark)).toHaveLength(1);

      const record = await sessions.get(secret);
      expect(record?.authMethod).toBe("oidc");
      expect(record?.principalId).toBe(user.id);
    });

    it("should reject just-in-time provisioning when the email is explicitly unverified", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: false },
      });

      expect(callback.status).toBe(403);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "access_denied",
        statusCode: 403,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(principalsByEmail(email)).resolves.toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });

    it("should reject just-in-time provisioning when the email_verified claim is absent", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();

      const { callback } = await completeLogin(configured, {
        user: { subject, email },
      });

      expect(callback.status).toBe(403);
      expect(errorEnvelope.parse(callback.json).error.code).toBe("access_denied");
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(principalsByEmail(email)).resolves.toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });

    it("should reject just-in-time provisioning when the email domain is not an exact allowlist match", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail("evil-allowed.test");

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
      });

      expect(callback.status).toBe(403);
      expect(errorEnvelope.parse(callback.json).error.code).toBe("access_denied");
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(principalsByEmail(email)).resolves.toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(0);
    });

    it("should reject a verified email that another principal already uses and log a sanitized collision", async () => {
      const mark = cacheMark();
      const logStart = destination.lines().length;
      const email = uniqueEmail();
      const existingId = await insertPrincipal({ email, name: "Existing Local User" });
      const subject = fixtureId();

      const { callback } = await completeLogin(configured, {
        user: { subject, email: email.toUpperCase(), emailVerified: true },
      });
      await flushLogs();

      expect(callback.status).toBe(403);
      expect(errorEnvelope.parse(callback.json).error).toMatchObject({
        code: "access_denied",
        statusCode: 403,
      });
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);

      const rows = await principalsByEmail(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(existingId);
      await expect(countIdentities(subject)).resolves.toBe(0);

      const logs = logsSince(logStart);
      expect(logs).toContain("oidc_link_collision");
      expect(logs).not.toContain(email);
      expect(logs).not.toContain(email.toUpperCase());
    });

    it("should reject a known identity whose principal has been disabled", async () => {
      const mark = cacheMark();
      const subject = fixtureId();
      const email = uniqueEmail();
      const principalId = await insertPrincipal({ email, name: "Disabled OIDC User" });
      await insertOidcIdentity(principalId, subject);
      await testDb.db.executeQuery(
        "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
        { id: principalId },
      );

      const { callback } = await completeLogin(configured, {
        user: { subject, email, emailVerified: true },
      });

      expect(callback.status).toBe(403);
      const error = errorEnvelope.parse(callback.json).error;
      expect(error).toMatchObject({ code: "access_denied", statusCode: 403 });
      expect(error.message).not.toContain(email);
      expectNoSessionCookie(callback);
      expect(sessionKeysSince(mark)).toHaveLength(0);
      await expect(countIdentities(subject)).resolves.toBe(1);
      await expect(principalsByEmail(email)).resolves.toHaveLength(1);
    });
  });

  describe("capabilities", () => {
    it("should report local and OIDC authentication without exposing provider details", async () => {
      const response = await sendTo(configured, { path: "/v1/meta/auth" });

      expect(response.status).toBe(200);
      expect(response.json).toEqual({ success: true, data: { local: true, oidc: true } });
      const serialized = JSON.stringify(response.json);
      expect(serialized).not.toContain(CLIENT_ID);
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(provider.issuer);
    });
  });

  describe("post-login redirect", () => {
    it("should fall back to the root when returnTo is a protocol-relative URL", async () => {
      await expectSuccessfulReturnTo("//evil.example", "/");
    });

    it("should fall back to the root when returnTo hides a protocol-relative host behind a dot segment", async () => {
      await expectSuccessfulReturnTo("/.//evil.example", "/");
    });

    it("should fall back to the root when returnTo escapes above the root into a protocol-relative path", async () => {
      await expectSuccessfulReturnTo("/..//evil.example", "/");
    });

    it("should fall back to the root when returnTo encodes a parent segment before a protocol-relative path", async () => {
      await expectSuccessfulReturnTo("/%2e%2e//evil.example", "/");
    });

    it("should fall back to the root when returnTo mixes a normal segment with a parent escape", async () => {
      await expectSuccessfulReturnTo("/a/../..//evil.example", "/");
    });

    it("should fall back to the root when returnTo is an absolute URL", async () => {
      await expectSuccessfulReturnTo("https://evil.example", "/");
    });

    it("should preserve a local returnTo path and query", async () => {
      await expectSuccessfulReturnTo("/ok?x=1", "/ok?x=1");
    });
  });
});

/** Completes one login and asserts the post-callback location and session. */
async function expectSuccessfulReturnTo(returnTo: string, expected: string): Promise<void> {
  const { callback } = await completeLogin(configured, {
    user: { subject: fixtureId(), email: uniqueEmail(), emailVerified: true },
    returnTo,
  });

  expect(callback.status).toBe(302);
  expect(findSetCookie(callback, SESSION_COOKIE)).toBeDefined();
  const location = callback.headers.location;
  expect(location).toBeDefined();
  const resolved = new URL(location ?? "", CONFIGURED_ORIGIN);
  expect(resolved.origin).toBe(CONFIGURED_ORIGIN);
  expect(`${resolved.pathname}${resolved.search}`).toBe(expected);
}

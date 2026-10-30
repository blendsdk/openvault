import { networkInterfaces } from "node:os";
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
const PHC_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string() }),
});

const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  authMethod: z.enum(["local", "oidc"]),
});

const meResponseSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      user: authUserSchema,
      expiresAt: z.iso.datetime(),
      csrfToken: z.string().min(32),
      mustChangePassword: z.boolean(),
      lastLoginAt: z.iso.datetime(),
    })
    .strict(),
});

const refreshResponseSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      expiresAt: z.iso.datetime(),
      csrfToken: z.string().min(32),
    })
    .strict(),
});

const sessionEntrySchema = z
  .object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    authMethod: z.enum(["local", "oidc"]),
    current: z.boolean(),
  })
  .strict();

const sessionListSchema = z.object({
  success: z.literal(true),
  data: z.object({ sessions: z.array(sessionEntrySchema) }).strict(),
});

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

interface TestUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

type SendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername">;

let testDb: TestDatabase;
let running: RunningApp;
let sessions: SessionService;
let nextFixtureSeed = 100;

/** Produces a unique ULID-shaped identifier per fixture row. */
function fixtureId(): string {
  nextFixtureSeed += 1;
  return testUlid(nextFixtureSeed);
}

/** Inserts an active user principal, optionally with a forced-change credential row. */
async function insertUser(options: { mustChange?: boolean } = {}): Promise<TestUser> {
  const id = fixtureId();
  const name = `Auth User ${nextFixtureSeed}`;
  const email = `auth-${id.toLowerCase()}@example.test`;

  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name, email },
  );
  if (options.mustChange !== undefined) {
    await testDb.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash, must_change)
       VALUES (:id, :passwordHash, :mustChange)`,
      { id, passwordHash: PHC_HASH, mustChange: options.mustChange },
    );
  }
  return { id, name, email };
}

/** Marks a principal disabled in the database. */
async function disableUser(id: string): Promise<void> {
  await testDb.db.executeQuery(
    "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
    { id },
  );
}

/** Creates a browser session directly through the application service. */
function createSession(principalId: string): Promise<{ secretId: string; record: SessionRecord }> {
  return sessions.create({ principalId, authMethod: "local" });
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

/** Returns the rotated cookie value or fails the current test when it is missing. */
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

/** Asserts that a response clears the session cookie with an expired lifetime. */
function expectClearedSessionCookie(response: TestResponse): void {
  const header = requireSetCookie(response, SESSION_COOKIE);
  expect(header.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
  expectSessionCookieAttributes(header);
  expect(header).toMatch(/;\s*Max-Age=0/i);
}

/** Builds request headers for a browser mutation with a valid cookie and CSRF token. */
function browserHeaders(secretId: string, csrfToken: string): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${secretId}`,
    [CSRF_HEADER]: csrfToken,
    origin: CONFIGURED_ORIGIN,
  };
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

describe.skipIf(trustedHost === undefined)("session routes", () => {
  it("should use the hardened host-scoped session cookie name", () => {
    expect(SESSION_COOKIE_NAME).toBe("__Host-ov_session");
  });

  it("should return the authenticated user and session metadata from /me", async () => {
    const user = await insertUser({ mustChange: false });
    const created = await createSession(user.id);

    const response = await send({
      path: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${created.secretId}` },
    });
    const parsed = meResponseSchema.parse(response.json).data;

    expect(response.status).toBe(200);
    expect(parsed.user).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      authMethod: "local",
    });
    expect(parsed.expiresAt).toBe(new Date(created.record.expiresAt).toISOString());
    expect(parsed.csrfToken).toBe(created.record.csrfToken);
    expect(parsed.mustChangePassword).toBe(false);
    expect(parsed.lastLoginAt).toBe(new Date(created.record.createdAt).toISOString());
  });

  it("should reject /me without a session", async () => {
    const response = await send({ path: "/v1/auth/me" });
    const parsed = errorEnvelope.parse(response.json);

    expect(response.status).toBe(401);
    expect(parsed.error.code).toBe("authentication_required");
  });

  it("should rotate the secret and CSRF token on refresh while keeping the session identity", async () => {
    const user = await insertUser({ mustChange: false });
    const created = await createSession(user.id);

    const response = await send({
      path: "/v1/auth/refresh",
      method: "POST",
      headers: browserHeaders(created.secretId, created.record.csrfToken),
    });
    const parsed = refreshResponseSchema.parse(response.json).data;
    const rotatedSecret = requireCookieValue(response, SESSION_COOKIE);
    const setCookie = requireSetCookie(response, SESSION_COOKIE);

    expect(response.status).toBe(200);
    expect(parsed.expiresAt).toBe(new Date(created.record.expiresAt).toISOString());
    expect(parsed.csrfToken).not.toBe(created.record.csrfToken);
    expect(rotatedSecret).not.toBe(created.secretId);
    expectSessionCookieAttributes(setCookie);

    const rotated = await sessions.get(rotatedSecret);
    expect(rotated?.publicId).toBe(created.record.publicId);
    expect(rotated?.createdAt).toBe(created.record.createdAt);
    expect(rotated?.expiresAt).toBe(created.record.expiresAt);
    expect(rotated?.csrfToken).toBe(parsed.csrfToken);
    await expect(sessions.get(created.secretId)).resolves.toBeUndefined();

    const late = await send({
      path: "/v1/auth/refresh",
      method: "POST",
      headers: browserHeaders(created.secretId, created.record.csrfToken),
    });
    expect(late.status).toBe(200);
    expect(requireCookieValue(late, SESSION_COOKIE)).toBe(rotatedSecret);
  });

  it("should log out, clear the cookie, and invalidate the old secret", async () => {
    const user = await insertUser({ mustChange: false });
    const created = await createSession(user.id);

    const response = await send({
      path: "/v1/auth/logout",
      method: "POST",
      headers: browserHeaders(created.secretId, created.record.csrfToken),
    });

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expectClearedSessionCookie(response);
    await expect(sessions.get(created.secretId)).resolves.toBeUndefined();

    const followUp = await send({
      path: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${created.secretId}` },
    });
    expect(followUp.status).toBe(401);
    expect(errorEnvelope.parse(followUp.json).error.code).toBe("authentication_required");
  });

  it("should invalidate the session and clear the cookie when the principal is disabled", async () => {
    const user = await insertUser({ mustChange: false });
    const created = await createSession(user.id);
    await disableUser(user.id);

    const response = await send({
      path: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${created.secretId}` },
    });

    expect(response.status).toBe(401);
    expect(errorEnvelope.parse(response.json).error.code).toBe("authentication_required");
    await expect(sessions.get(created.secretId)).resolves.toBeUndefined();
    expectClearedSessionCookie(response);
  });

  it("should list live sessions with one current flag and no secret or CSRF values", async () => {
    const user = await insertUser({ mustChange: false });
    const first = await createSession(user.id);
    const second = await createSession(user.id);

    const response = await send({
      path: "/v1/auth/sessions",
      headers: { cookie: `${SESSION_COOKIE}=${first.secretId}` },
    });
    const entries = sessionListSchema.parse(response.json).data.sessions;

    expect(response.status).toBe(200);
    expect(entries).toHaveLength(2);
    const currentEntries = entries.filter((entry) => entry.current);
    expect(currentEntries).toHaveLength(1);
    expect(currentEntries[0]?.id).toBe(first.record.publicId);
    expect(entries.map((entry) => entry.id)).toEqual([
      second.record.publicId,
      first.record.publicId,
    ]);

    const recordsById = new Map([
      [first.record.publicId, first.record],
      [second.record.publicId, second.record],
    ]);
    for (const entry of entries) {
      const expected = recordsById.get(entry.id);
      expect(expected).toBeDefined();
      if (expected !== undefined) {
        expect(entry.createdAt).toBe(new Date(expected.createdAt).toISOString());
        expect(entry.expiresAt).toBe(new Date(expected.expiresAt).toISOString());
        expect(entry.authMethod).toBe(expected.authMethod);
      }
    }

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(first.secretId);
    expect(serialized).not.toContain(second.secretId);
    expect(serialized).not.toContain(first.record.csrfToken);
    expect(serialized).not.toContain(second.record.csrfToken);
  });

  it("should delete an owned session and leave the current session active", async () => {
    const user = await insertUser({ mustChange: false });
    const current = await createSession(user.id);
    const other = await createSession(user.id);

    const response = await send({
      path: `/v1/auth/sessions/${other.record.publicId}`,
      method: "DELETE",
      headers: browserHeaders(current.secretId, current.record.csrfToken),
    });

    expect(response.status).toBe(204);
    await expect(sessions.get(other.secretId)).resolves.toBeUndefined();
    await expect(sessions.get(current.secretId)).resolves.toEqual(current.record);

    const listResponse = await send({
      path: "/v1/auth/sessions",
      headers: { cookie: `${SESSION_COOKIE}=${current.secretId}` },
    });
    const entries = sessionListSchema.parse(listResponse.json).data.sessions;
    expect(entries.map((entry) => entry.id)).toEqual([current.record.publicId]);
  });

  it("should return 404 for an unknown session and for another principal's session", async () => {
    const owner = await insertUser({ mustChange: false });
    const intruder = await insertUser({ mustChange: false });
    const foreign = await createSession(owner.id);
    const intruderSession = await createSession(intruder.id);

    const unknown = await send({
      path: `/v1/auth/sessions/${fixtureId()}`,
      method: "DELETE",
      headers: browserHeaders(intruderSession.secretId, intruderSession.record.csrfToken),
    });
    expect(unknown.status).toBe(404);

    const foreignResponse = await send({
      path: `/v1/auth/sessions/${foreign.record.publicId}`,
      method: "DELETE",
      headers: browserHeaders(intruderSession.secretId, intruderSession.record.csrfToken),
    });
    expect(foreignResponse.status).toBe(404);
    await expect(sessions.get(foreign.secretId)).resolves.toEqual(foreign.record);
  });

  it("should block /sessions but allow /me for a forced-change session", async () => {
    const user = await insertUser({ mustChange: true });
    const created = await createSession(user.id);

    const meResponse = await send({
      path: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${created.secretId}` },
    });
    const me = meResponseSchema.parse(meResponse.json).data;

    expect(meResponse.status).toBe(200);
    expect(me.mustChangePassword).toBe(true);
    expect(me.user.id).toBe(user.id);

    const sessionsResponse = await send({
      path: "/v1/auth/sessions",
      headers: { cookie: `${SESSION_COOKIE}=${created.secretId}` },
    });
    const blocked = errorEnvelope.parse(sessionsResponse.json);

    expect(sessionsResponse.status).toBe(403);
    expect(blocked.error.code).toBe("password_change_required");
  });
});

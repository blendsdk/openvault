import { argon2Sync, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { z } from "zod";
import { createTestApplication } from "../../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../../src/auth/cookie.js";
import type { SessionRecord, SessionService } from "../../../src/auth/sessions.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../../src/transport/secure-application.js";
import { TlsMaterial } from "../../../src/transport/tls.js";
import { testUlid } from "./fixtures.js";
import { type TestRequestOptions, type TestResponse, testRequest } from "./https.js";
import { createServerEnvironment, type ServerEnvironment } from "./server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./test-database.js";

/** Password used by every generated local credential fixture. */
export const TEST_PASSWORD = "correct horse battery staple";

/**
 * A fixed, independently generated Argon2id hash for {@link TEST_PASSWORD}.
 *
 * The hash uses the required cost policy and an alphabet that decodes the same
 * way as standard or URL-safe base64. Tests can therefore verify password
 * changes without importing the password-hashing code they are judging.
 */
export const TEST_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";

/** Browser origin configured for the integration server. */
const CONFIGURED_ORIGIN = "https://vault.example.com";

/** CSRF header used by browser mutations. */
const CSRF_HEADER = "x-csrf-token";

/** Route that signs a local credential in for the command line. */
const CLI_LOGIN_PATH = "/v1/auth/cli/login";

/** Route that signs a local credential in for the browser. */
const BROWSER_LOGIN_PATH = "/v1/auth/local/login";

/** Route that changes a browser-authenticated password. */
const PASSWORD_CHANGE_PATH = "/v1/auth/password";

/** The first non-loopback IPv4 address, or `undefined` when the host has none. */
export const trustedTestHost = ((): string | undefined => {
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
})();

/**
 * Builds the trusted-proxy ranges for the test server.
 *
 * Express only honours a forwarded client address when the direct peer is a
 * trusted proxy. The tests connect to the host's non-loopback address, so that
 * address must be trusted as well.
 *
 * @returns A comma-separated list of CIDR ranges.
 */
function trustedProxyCidrs(): string {
  return trustedTestHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedTestHost}/32`;
}

/** Error envelope returned by the public API. */
export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    statusCode: z.number().optional(),
  }),
});

/** Public user object returned by a local sign-in. */
export const cliUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  authMethod: z.literal("local"),
});

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Token response returned by a successful command-line sign-in.
 *
 * The schema is defined by the test suite rather than imported from the
 * production contract, so the assertions stay an independent oracle.
 */
export const cliTokenResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    tokenType: z.literal("Bearer"),
    accessToken: z.string().regex(JWT_PATTERN),
    accessExpiresAt: z.iso.datetime(),
    refreshToken: z.string().regex(REFRESH_TOKEN_PATTERN),
    refreshExpiresAt: z.iso.datetime(),
    user: cliUserSchema,
    mustChangePassword: z.boolean(),
  }),
});

/** A local user fixture inserted directly into the test database. */
export interface CliTestUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** The credential state that the shared local-login service maintains. */
export interface CredentialState {
  readonly passwordHash: string;
  readonly mustChange: boolean;
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
}

/** One stored command-line refresh row, projected with camelCase fields. */
export interface CliSessionRow {
  readonly id: string;
  readonly principalId: string;
  readonly refreshHash: Buffer;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

/** A browser session created directly through the application service. */
export interface IssuedBrowserSession {
  readonly secretId: string;
  readonly record: SessionRecord;
}

/** Options accepted by {@link CliAuthTestHarness.send}. */
export type CliSendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername">;

/**
 * A running server with a disposable database for command-line auth tests.
 *
 * The harness owns the database, TLS material, server environment, and the
 * transport listener. Call {@link stop} in `afterAll` so every resource is
 * released even when a test fails.
 */
export class CliAuthTestHarness {
  readonly db: TestDatabase;
  readonly environment: ServerEnvironment;
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;

  private readonly sessions: SessionService;
  private nextFixtureSeed = 100;
  private nextAddressSeed = 0;

  private constructor(
    db: TestDatabase,
    environment: ServerEnvironment,
    app: SecureWebApplication,
    handle: TransportHandle,
    sessions: SessionService,
  ) {
    this.db = db;
    this.environment = environment;
    this.app = app;
    this.handle = handle;
    this.sessions = sessions;
  }

  /**
   * Creates a disposable database, applies migrations, and starts the server.
   *
   * Signing-key material is not seeded here. The first token issue ensures the
   * current key, which also proves that a missed startup step cannot mint an
   * unsigned credential.
   *
   * @returns A ready harness.
   */
  static async start(): Promise<CliAuthTestHarness> {
    const testDb = await createTestDatabase();
    await applyMigrations(testDb);
    const environment = createServerEnvironment({
      OPENVAULT_DB_URL: testDb.url,
      OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
    });

    let keyring: KeyringProvider | undefined;
    let database: PostgreSQLDatabase | undefined;
    try {
      keyring = await KeyringProvider.load(environment.keyringPath);
      const tls = TlsMaterial.load(environment.config);
      database = new PostgreSQLDatabase({
        ...environment.config.database,
        poolConfig: { connectionTimeoutMillis: 2_000 },
        enableGracefulShutdown: false,
      });
      const app = await createTestApplication(environment.config, { database, tls, keyring });
      const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
      const sessions = await app.getService<SessionService>("sessions");
      return new CliAuthTestHarness(testDb, environment, app, handle, sessions);
    } catch (error) {
      if (database !== undefined) {
        await database.disconnect().catch(() => undefined);
      }
      keyring?.destroy();
      environment.cleanup();
      await testDb.cleanup();
      throw error;
    }
  }

  /**
   * Stops the listener and releases every fixture resource.
   *
   * @returns A promise that settles after the database is dropped.
   */
  async stop(): Promise<void> {
    try {
      await this.handle.stop();
    } finally {
      this.environment.cleanup();
      await this.db.cleanup();
    }
  }

  /**
   * Sends one HTTPS request to the running admin listener.
   *
   * @param options - Request options without transport details.
   * @returns The captured response.
   */
  send(options: CliSendOptions): Promise<TestResponse> {
    return testRequest({
      ...options,
      host: trustedTestHost ?? "127.0.0.1",
      port: this.handle.adminPort,
      ca: this.environment.tls.caPem,
      servername: "localhost",
    });
  }

  /**
   * Produces a unique ULID-shaped identifier for one fixture row.
   *
   * @returns A 26-character identifier in the same alphabet as production ULIDs.
   */
  fixtureId(): string {
    this.nextFixtureSeed += 1;
    return testUlid(this.nextFixtureSeed);
  }

  /**
   * Produces a unique forwarded client address in the documentation range.
   *
   * Unique addresses keep one test's per-address limit window from masking
   * another test's login behavior. Tests that intentionally share a bucket
   * pass the same address to several calls.
   *
   * @returns A stable unique IPv4 address.
   */
  uniqueAddress(): string {
    this.nextAddressSeed += 1;
    if (this.nextAddressSeed > 250) {
      throw new Error("the test address range is exhausted");
    }
    return `203.0.113.${this.nextAddressSeed}`;
  }

  /**
   * Inserts a local user principal with a credential row.
   *
   * @param options - Optional forced-change flag or disabled status.
   * @returns The inserted identifiers.
   */
  async insertUser(
    options: { readonly mustChange?: boolean; readonly status?: "active" | "disabled" } = {},
  ): Promise<CliTestUser> {
    const id = this.fixtureId();
    const name = `CLI User ${this.nextFixtureSeed}`;
    const email = `cli-${id.toLowerCase()}@example.test`;
    const status = options.status ?? "active";

    if (status === "disabled") {
      await this.db.db.executeQuery(
        `INSERT INTO principals (id, kind, name, email, status, disabled_at)
         VALUES (:id, 'user', :name, :email, 'disabled', now())`,
        { id, name, email },
      );
    } else {
      await this.db.db.executeQuery(
        `INSERT INTO principals (id, kind, name, email, status)
         VALUES (:id, 'user', :name, :email, 'active')`,
        { id, name, email },
      );
    }
    await this.db.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash, must_change)
       VALUES (:id, :passwordHash, :mustChange)`,
      { id, passwordHash: TEST_PASSWORD_HASH, mustChange: options.mustChange ?? false },
    );
    return { id, name, email };
  }

  /**
   * Reads the credential counters and hash maintained by the login flow.
   *
   * @param principalId - Principal to read.
   * @returns The current credential state.
   */
  async readCredential(principalId: string): Promise<CredentialState> {
    const result = await this.db.db.executeQuery<{
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

  /**
   * Writes a lock state directly so one rejected-login path can be exercised.
   *
   * @param principalId - Principal to lock.
   * @param lockedUntil - End of the lock window.
   * @param failedCount - Failure count stored with the lock.
   */
  async setLock(principalId: string, lockedUntil: Date, failedCount: number): Promise<void> {
    await this.db.db.executeQuery(
      `UPDATE local_credentials
          SET failed_count = :failedCount, locked_until = :lockedUntil
        WHERE principal_id = :principalId`,
      { principalId, failedCount, lockedUntil: lockedUntil.toISOString() },
    );
  }

  /**
   * Submits local credentials to the command-line login route.
   *
   * @param identifier - Email address supplied by the caller.
   * @param password - Candidate password.
   * @param forwardedFor - Client address observed by the rate limiter.
   * @returns The captured response.
   */
  cliLogin(
    identifier: string,
    password: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: CLI_LOGIN_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ identifier, password }),
    });
  }

  /**
   * Submits local credentials to the browser login route.
   *
   * @param identifier - Email address supplied by the caller.
   * @param password - Candidate password.
   * @param forwardedFor - Client address observed by the rate limiter.
   * @returns The captured response.
   */
  browserLogin(
    identifier: string,
    password: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: BROWSER_LOGIN_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: CONFIGURED_ORIGIN,
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ identifier, password }),
    });
  }

  /**
   * Creates a browser session directly through the application service.
   *
   * @param principalId - Principal that owns the session.
   * @param authMethod - Authentication method stored on the session.
   * @returns The secret cookie value and the stored record.
   */
  createBrowserSession(
    principalId: string,
    authMethod: "local" | "oidc" = "local",
  ): Promise<IssuedBrowserSession> {
    return this.sessions.create({ principalId, authMethod });
  }

  /**
   * Changes a password through the browser route with a valid cookie and CSRF token.
   *
   * @param session - Browser session that authorizes the change.
   * @param currentPassword - Password to verify before the update.
   * @param newPassword - Replacement password.
   * @param forwardedFor - Client address observed by the server.
   * @returns The captured response.
   */
  changePassword(
    session: IssuedBrowserSession,
    currentPassword: string,
    newPassword: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: PASSWORD_CHANGE_PATH,
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${session.secretId}`,
        [CSRF_HEADER]: session.record.csrfToken,
        origin: CONFIGURED_ORIGIN,
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  /**
   * Reads the stored command-line refresh rows for one principal.
   *
   * @param principalId - Principal that owns the rows.
   * @returns Rows ordered by creation time.
   */
  async cliSessionRows(principalId: string): Promise<CliSessionRow[]> {
    const result = await this.db.db.executeQuery<{
      id: string;
      principal_id: string;
      refresh_hash: Buffer;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      ip: string | null;
      user_agent: string | null;
      created_at: Date;
    }>(
      `SELECT id, principal_id, refresh_hash, family_id, expires_at, revoked_at,
              ip, user_agent, created_at
         FROM cli_sessions
        WHERE principal_id = :principalId
        ORDER BY created_at, id`,
      { principalId },
    );

    return result.records.map((row) => ({
      id: row.id,
      principalId: row.principal_id,
      refreshHash: row.refresh_hash,
      familyId: row.family_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    }));
  }

  /**
   * Reads every stored column of the command-line refresh rows.
   *
   * This projection is used to prove that the raw refresh token is absent from
   * every column, including any column added later.
   *
   * @param principalId - Principal that owns the rows.
   * @returns Raw rows keyed by database column name.
   */
  async cliSessionRawRows(principalId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.db.executeQuery<Record<string, unknown>>(
      `SELECT * FROM cli_sessions WHERE principal_id = :principalId`,
      { principalId },
    );
    return result.records;
  }

  /**
   * Lists the physical columns of the command-line refresh table.
   *
   * @returns Column names in physical order.
   */
  async cliSessionColumns(): Promise<string[]> {
    const result = await this.db.db.executeQuery<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cli_sessions'
        ORDER BY ordinal_position`,
    );
    return result.records.map((row) => row.column_name);
  }

  /**
   * Counts families that can still refresh or authenticate.
   *
   * @param principalId - Principal that owns the families.
   * @returns Number of live rows.
   */
  async countLiveCliFamilies(principalId: string): Promise<number> {
    const result = await this.db.db.executeQuery<{ live: number }>(
      `SELECT count(*)::int AS live
         FROM cli_sessions
        WHERE principal_id = :principalId
          AND revoked_at IS NULL
          AND expires_at > now()`,
      { principalId },
    );
    return result.records[0]?.live ?? 0;
  }
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
export function matchesPasswordHash(password: string, phc: string): boolean {
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

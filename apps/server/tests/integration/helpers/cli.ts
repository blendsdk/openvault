import { argon2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { Client } from "pg";
import { z } from "zod";
import { createTestApplication } from "../../../src/app.js";
import { bootstrapAuthRuntime } from "../../../src/auth/bootstrap.js";
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
import { MemoryDestination } from "./memory-destination.js";
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

/** Route that rotates a command-line refresh token. */
const CLI_REFRESH_PATH = "/v1/auth/cli/refresh";

/** Route that revokes a command-line refresh family. */
const CLI_LOGOUT_PATH = "/v1/auth/cli/logout";

/** Route that returns the command-line caller. */
const CLI_ME_PATH = "/v1/auth/cli/me";

/** Route that lists the command-line caller's refresh families. */
const CLI_SESSIONS_PATH = "/v1/auth/cli/sessions";

/** Route that signs a local credential in for the browser. */
const BROWSER_LOGIN_PATH = "/v1/auth/local/login";

/** Route that reads the browser session user. */
const BROWSER_ME_PATH = "/v1/auth/me";

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
 * Token payload returned by a successful command-line sign-in or rotation.
 *
 * The schema is defined by the test suite rather than imported from the
 * production contract, so the assertions stay an independent oracle.
 */
export const cliTokenDataSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accessToken: z.string().regex(JWT_PATTERN),
    accessExpiresAt: z.iso.datetime(),
    refreshToken: z.string().regex(REFRESH_TOKEN_PATTERN),
    refreshExpiresAt: z.iso.datetime(),
    user: cliUserSchema,
    mustChangePassword: z.boolean(),
  })
  .strict();

/** Token response returned by a successful command-line sign-in. */
export const cliTokenResponseSchema = z
  .object({
    success: z.literal(true),
    data: cliTokenDataSchema,
  })
  .strict();

/** Token response returned by a successful command-line refresh. */
export const cliRefreshResponseSchema = z
  .object({
    success: z.literal(true),
    data: cliTokenDataSchema,
  })
  .strict();

/** Response returned by the command-line profile route. */
export const cliMeResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        user: cliUserSchema,
        mustChangePassword: z.boolean(),
      })
      .strict(),
  })
  .strict();

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * One refresh family returned by the command-line session list.
 *
 * The schema is intentionally strict: the route must not expose a refresh
 * hash, a raw token, or an internal row identifier, so any extra field is a
 * contract failure rather than harmless metadata.
 */
export const cliFamilySchema = z
  .object({
    id: z.string().regex(ULID_PATTERN),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .strict();

/** Response returned by the command-line family list route. */
export const cliSessionListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        sessions: z.array(cliFamilySchema),
      })
      .strict(),
  })
  .strict();

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

/**
 * The maintenance operations that the retention behavior requires.
 *
 * The production class is not imported here; the test helper describes the
 * contract so the tests stay an independent oracle.
 */
export interface CliMaintenanceServiceLike {
  /** Runs a cleanup once and then schedules the next run. */
  start(): Promise<void>;
  /** Runs one bounded cleanup and returns the number of deleted rows. */
  runOnce(): Promise<number>;
  /** Stops the scheduler; calling it twice is safe. */
  stop(): void;
}

/** The retention operation used by the cleanup tests. */
export interface CliSessionRepositoryLike {
  /** Deletes at most `batchSize` rows that are past retention. */
  cleanup(batchSize: number): Promise<unknown>;
}

/** Options for seeding one stored refresh row with chosen timestamps. */
export interface InsertCliSessionOptions {
  /** Principal that owns the row. */
  readonly principalId: string;
  /** Absolute expiry of the family. */
  readonly expiresAt: Date;
  /** Revocation time; `null` leaves the row unrevoked. */
  readonly revokedAt?: Date | null;
  /** Creation time; defaults to the current time. */
  readonly createdAt?: Date;
  /** Family identifier; defaults to a fresh test identifier. */
  readonly familyId?: string;
}

/** The identifiers of one seeded refresh row. */
export interface InsertedCliSession {
  readonly id: string;
  readonly familyId: string;
}

/** Options accepted by {@link CliAuthTestHarness.send}. */
export type CliSendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername">;

/** Options for a command-line profile request. */
export interface CliMeOptions {
  /** Access token placed in a `Bearer` authorization header. */
  readonly bearer?: string;
  /** Raw authorization header value, used for malformed-header cases. */
  readonly authorization?: string;
  /** Browser session cookie value, used for no-fallback cases. */
  readonly cookie?: string;
  /** Client address observed by the server. */
  readonly forwardedFor?: string;
}

/** Options for a command-line logout request. */
export interface CliLogoutOptions {
  /** Raw authorization header value, used for forced-change cases. */
  readonly authorization?: string;
  /** Client address observed by the server. */
  readonly forwardedFor?: string;
}

/**
 * A database transaction that holds one principal row lock.
 *
 * Tests use it to create a deterministic interleaving: requests that start
 * while the lock is held cannot pass the per-principal serialization point,
 * so the test can observe they are waiting before releasing the lock.
 */
export class PrincipalLock {
  readonly #client: Client;

  /** Creates the handle around an already-open transaction. */
  constructor(client: Client) {
    this.#client = client;
  }

  /**
   * Waits for sessions in the lock chain rooted at this transaction.
   *
   * The recursive query follows `pg_blocking_pids` from the external lock
   * holder through direct and chained waiters. It therefore proves that both
   * racing requests reached the serialization point, including a second
   * request queued behind the first app transaction, without counting unrelated
   * locks on a shared server.
   *
   * @param expected - Number of blocked sessions to wait for.
   * @param timeoutMs - Maximum time to wait.
   * @returns The highest number of blocked sessions observed.
   */
  async waitForBlockedTransactions(expected: number, timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
      const result = await this.#client.query<{ waiting: number }>(
        `WITH RECURSIVE waiters(pid) AS (
           SELECT pid
             FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
           UNION
           SELECT a.pid
             FROM pg_stat_activity a
             JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
         )
         SELECT count(*)::int AS waiting FROM waiters`,
      );
      observed = Math.max(observed, result.rows[0]?.waiting ?? 0);
      if (observed >= expected) {
        return observed;
      }
      await delay(10);
    }
    return observed;
  }
}

/**
 * Options accepted by {@link CliAuthTestHarness.start}.
 */
export interface CliAuthHarnessOptions {
  /**
   * Writable sink that receives structured server logs.
   *
   * Supply a shared sink when a test needs to read the captured output. When it
   * is omitted the harness creates its own sink, so every suite can assert on
   * real logger output without extra setup.
   */
  readonly loggerDestination?: MemoryDestination;
}

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
  /** Captured structured log output, including startup log entries. */
  readonly logs: MemoryDestination;

  private readonly sessions: SessionService;
  private nextFixtureSeed = 100;
  private nextAddressSeed = 0;

  private constructor(
    db: TestDatabase,
    environment: ServerEnvironment,
    app: SecureWebApplication,
    handle: TransportHandle,
    sessions: SessionService,
    logs: MemoryDestination,
  ) {
    this.db = db;
    this.environment = environment;
    this.app = app;
    this.handle = handle;
    this.sessions = sessions;
    this.logs = logs;
  }

  /**
   * Creates a disposable database, applies migrations, bootstraps auth state,
   * and starts the server.
   *
   * The bootstrap path is exercised here because a production start must not
   * depend on the first request to create its signing key or retire a due key.
   *
   * @param options - Optional log capture sink.
   * @returns A ready harness.
   */
  static async start(options: CliAuthHarnessOptions = {}): Promise<CliAuthTestHarness> {
    const logs = options.loggerDestination ?? new MemoryDestination();
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
      const app = await createTestApplication(environment.config, {
        database,
        tls,
        keyring,
        loggerDestination: logs,
      });
      await bootstrapAuthRuntime(app);
      const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
      const sessions = await app.getService<SessionService>("sessions");
      return new CliAuthTestHarness(testDb, environment, app, handle, sessions, logs);
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
   * Returns every captured log line as one string.
   *
   * Reading one complete snapshot keeps assertions simple and lets a failure
   * message show the whole capture.
   *
   * @returns Newline-separated log output.
   */
  logText(): string {
    return this.logs.lines().join("\n");
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
   * @param extraHeaders - Additional headers such as a stale authorization value.
   * @returns The captured response.
   */
  cliLogin(
    identifier: string,
    password: string,
    forwardedFor: string = this.uniqueAddress(),
    extraHeaders: Record<string, string> = {},
  ): Promise<TestResponse> {
    return this.send({
      path: CLI_LOGIN_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
        ...extraHeaders,
      },
      body: JSON.stringify({ identifier, password }),
    });
  }

  /**
   * Rotates a command-line refresh token.
   *
   * The request deliberately sends no Origin or CSRF header: command-line
   * requests authenticate with their own credential rather than a cookie.
   *
   * @param refreshToken - Opaque refresh token to rotate.
   * @param forwardedFor - Client address observed by the rate limiter.
   * @returns The captured response.
   */
  cliRefresh(
    refreshToken: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: CLI_REFRESH_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ refreshToken }),
    });
  }

  /**
   * Revokes a command-line refresh family.
   *
   * @param refreshToken - Opaque refresh token that names the family.
   * @param options - Optional authorization header and client address.
   * @returns The captured response.
   */
  cliLogout(refreshToken: string, options: CliLogoutOptions = {}): Promise<TestResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": options.forwardedFor ?? this.uniqueAddress(),
    };
    if (options.authorization !== undefined) {
      headers.authorization = options.authorization;
    }
    return this.send({
      path: CLI_LOGOUT_PATH,
      method: "POST",
      headers,
      body: JSON.stringify({ refreshToken }),
    });
  }

  /**
   * Reads the current command-line user.
   *
   * Authorization may come from a bearer token, a raw header, a browser
   * cookie, or any combination. This lets tests prove that a cookie never
   * authorizes a command-line route and that an invalid bearer never falls
   * back to a cookie.
   *
   * @param options - Authorization material and client address.
   * @returns The captured response.
   */
  cliMe(options: CliMeOptions = {}): Promise<TestResponse> {
    const headers: Record<string, string> = {
      "x-forwarded-for": options.forwardedFor ?? this.uniqueAddress(),
    };
    if (options.authorization !== undefined) {
      headers.authorization = options.authorization;
    } else if (options.bearer !== undefined) {
      headers.authorization = `Bearer ${options.bearer}`;
    }
    if (options.cookie !== undefined) {
      headers.cookie = options.cookie;
    }
    return this.send({ path: CLI_ME_PATH, method: "GET", headers });
  }

  /**
   * Lists the command-line caller's refresh families.
   *
   * @param accessToken - Bearer access token for the caller.
   * @param forwardedFor - Client address observed by the server.
   * @returns The captured response.
   */
  cliSessions(
    accessToken: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: CLI_SESSIONS_PATH,
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-forwarded-for": forwardedFor,
      },
    });
  }

  /**
   * Revokes one command-line refresh family owned by the bearer caller.
   *
   * @param accessToken - Bearer access token for the caller.
   * @param familyId - Family identifier taken from the path.
   * @param forwardedFor - Client address observed by the server.
   * @returns The captured response.
   */
  cliDeleteSession(
    accessToken: string,
    familyId: string,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: `${CLI_SESSIONS_PATH}/${encodeURIComponent(familyId)}`,
      method: "DELETE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-forwarded-for": forwardedFor,
      },
    });
  }

  /**
   * Reads the browser session user.
   *
   * This is used to prove that a cookie presented to a command-line route was
   * a valid browser credential, so a rejection is caused by the route rather
   * than by an expired session.
   *
   * @param session - Browser session to present.
   * @param forwardedFor - Client address observed by the server.
   * @returns The captured response.
   */
  browserMe(
    session: IssuedBrowserSession,
    forwardedFor: string = this.uniqueAddress(),
  ): Promise<TestResponse> {
    return this.send({
      path: BROWSER_ME_PATH,
      method: "GET",
      headers: {
        cookie: this.browserCookie(session),
        "x-forwarded-for": forwardedFor,
      },
    });
  }

  /**
   * Formats a browser session as a cookie header value.
   *
   * @param session - Browser session to serialize.
   * @returns The `name=value` cookie pair.
   */
  browserCookie(session: IssuedBrowserSession): string {
    return `${SESSION_COOKIE_NAME}=${session.secretId}`;
  }

  /**
   * Marks a principal as disabled without deleting its credentials.
   *
   * @param principalId - Principal to disable.
   */
  async disableUser(principalId: string): Promise<void> {
    await this.db.db.executeQuery(
      `UPDATE principals
          SET status = 'disabled', disabled_at = COALESCE(disabled_at, now())
        WHERE id = :principalId`,
      { principalId },
    );
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
  cliSessionRows(principalId: string): Promise<CliSessionRow[]> {
    return this.readCliSessionRows("principal_id", principalId);
  }

  /**
   * Reads the stored command-line refresh rows for one family.
   *
   * Every rotation adds a row to the same family, so these rows show both the
   * absolute family expiry and which tokens have been revoked.
   *
   * @param familyId - Family whose rows should be read.
   * @returns Rows ordered by creation time.
   */
  cliFamilyRows(familyId: string): Promise<CliSessionRow[]> {
    return this.readCliSessionRows("family_id", familyId);
  }

  /**
   * Seeds one stored refresh row with explicit timestamps.
   *
   * Retention tests need rows whose expiry and revocation times are in the
   * past; the normal login path can only create current rows.
   *
   * @param options - Owner and timestamps for the row.
   * @returns The generated row and family identifiers.
   */
  async insertCliSessionRow(options: InsertCliSessionOptions): Promise<InsertedCliSession> {
    const id = this.fixtureId();
    const familyId = options.familyId ?? this.fixtureId();
    await this.db.db.executeQuery(
      `INSERT INTO cli_sessions
         (id, principal_id, refresh_hash, family_id, expires_at, revoked_at, created_at)
       VALUES
         (:id, :principalId, :refreshHash, :familyId, :expiresAt, :revokedAt, :createdAt)`,
      {
        id,
        principalId: options.principalId,
        refreshHash: randomBytes(32),
        familyId,
        expiresAt: options.expiresAt.toISOString(),
        revokedAt: options.revokedAt?.toISOString() ?? null,
        createdAt: (options.createdAt ?? new Date()).toISOString(),
      },
    );
    return { id, familyId };
  }

  /**
   * Moves every row of one family to a past expiry.
   *
   * @param familyId - Family to expire.
   * @param at - Expiry time; defaults to one minute ago.
   */
  async expireCliFamilyRows(
    familyId: string,
    at: Date = new Date(Date.now() - 60_000),
  ): Promise<void> {
    await this.db.db.executeQuery(
      `UPDATE cli_sessions
          SET expires_at = :expiresAt
        WHERE family_id = :familyId`,
      { familyId, expiresAt: at.toISOString() },
    );
  }

  /**
   * Lists family identifiers that still have a live row.
   *
   * @param principalId - Principal that owns the families.
   * @returns Distinct family identifiers.
   */
  async liveCliFamilyIds(principalId: string): Promise<string[]> {
    const result = await this.db.db.executeQuery<{ family_id: string }>(
      `SELECT DISTINCT family_id
         FROM cli_sessions
        WHERE principal_id = :principalId
          AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY family_id`,
      { principalId },
    );
    return result.records.map((row) => row.family_id);
  }

  /**
   * Returns the retention maintenance service of the running application.
   *
   * @returns The service contract used by the cleanup tests.
   */
  cliMaintenance(): Promise<CliMaintenanceServiceLike> {
    return this.app.getService<CliMaintenanceServiceLike>("cliMaintenance");
  }

  /**
   * Returns the command-line session repository of the running application.
   *
   * @returns The repository contract used by the batch-bound test.
   */
  cliSessionRepository(): Promise<CliSessionRepositoryLike> {
    return this.app.getService<CliSessionRepositoryLike>("cliSessions");
  }

  /**
   * Runs the production authentication bootstrap against this application.
   *
   * The test harness already runs it once at startup; calling it again lets a
   * test prove that a repeated start is harmless.
   *
   * @returns A promise that settles after the bootstrap completes.
   */
  async bootstrapRuntime(): Promise<void> {
    await bootstrapAuthRuntime(this.app);
  }

  /**
   * Counts signing keys in one lifecycle state.
   *
   * @param status - Lifecycle state to count.
   * @returns Number of rows in that state.
   */
  async countSigningKeys(status: "current" | "previous" | "retired"): Promise<number> {
    const result = await this.db.db.executeQuery<{ count: number }>(
      `SELECT count(*)::int AS count FROM signing_keys WHERE status = :status`,
      { status },
    );
    return result.records[0]?.count ?? 0;
  }

  /**
   * Reads the key identifier of the current signing key.
   *
   * @returns The current key id, or `undefined` when no current key exists.
   */
  async currentSigningKeyKid(): Promise<string | undefined> {
    const result = await this.db.db.executeQuery<{ kid: string }>(
      `SELECT kid FROM signing_keys WHERE status = 'current'`,
    );
    return result.records[0]?.kid;
  }

  /**
   * Runs an action while holding an exclusive lock on one principal row.
   *
   * Requests that reach the per-principal serialization point block until the
   * action returns, which gives concurrency tests a deterministic order.
   * The transaction is committed on success and rolled back on failure.
   *
   * @param principalId - Principal whose row is locked.
   * @param action - Work to perform while the lock is held.
   * @returns The action's result.
   */
  async withPrincipalLock<T>(
    principalId: string,
    action: (lock: PrincipalLock) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: this.db.url });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      const result = await action(new PrincipalLock(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * Reads command-line refresh rows selected by one indexed column.
   *
   * @param column - Internal column name; never supplied by request data.
   * @param value - Column value to match.
   * @returns Rows ordered by creation time.
   */
  private async readCliSessionRows(
    column: "principal_id" | "family_id",
    value: string,
  ): Promise<CliSessionRow[]> {
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
        WHERE ${column} = :value
        ORDER BY created_at, id`,
      { value },
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

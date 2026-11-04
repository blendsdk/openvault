import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { resetAuditTables } from "./helpers/audit-harness.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const TEST_PASSWORD = "correct horse battery staple";
const PHC_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";

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

let testDb: TestDatabase;
let environment: ReturnType<typeof createServerEnvironment>;
let app: SecureWebApplication;
let handle: TransportHandle;
let lockedUser: { readonly id: string; readonly email: string };

/** Inserts one active user with a known local credential. */
async function createLoginUser(
  seed: number,
): Promise<{ readonly id: string; readonly email: string }> {
  const id = testUlid(seed);
  const email = `audit-login-${id.toLowerCase()}@example.test`;
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: `Audit Login ${seed}`, email },
  );
  await testDb.db.executeQuery(
    `INSERT INTO local_credentials (principal_id, password_hash, must_change)
     VALUES (:id, :hash, false)`,
    { id, hash: PHC_HASH },
  );
  return { id, email };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS:
      trustedHost === undefined ? "127.0.0.1/32,::1/128" : `127.0.0.1/32,::1/128,${trustedHost}/32`,
  });
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  app = await createTestApplication(environment.config, { database, tls, keyring });
  handle = await app.startTransport({ adminPort: 0, agentPort: 0 });

  lockedUser = await createLoginUser(9_502);
  await testDb.db.executeQuery(
    `UPDATE local_credentials
        SET failed_count = 5, locked_until = now() + interval '10 minutes'
      WHERE principal_id = :id`,
    { id: lockedUser.id },
  );
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

async function login(identifier: string, password: string, address: string): Promise<TestResponse> {
  return testRequest({
    path: "/v1/auth/local/login",
    method: "POST",
    host: trustedHost ?? "127.0.0.1",
    port: handle.adminPort,
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: {
      "content-type": "application/json",
      origin: environment.config.baseUrl.origin,
      "x-forwarded-for": address,
    },
    body: JSON.stringify({ identifier, password }),
  });
}

async function authEvents(): Promise<
  readonly {
    action: string;
    result: string;
    actor_kind: string;
    actor_id: string | null;
    details: Record<string, unknown>;
  }[]
> {
  const rows = await testDb.db.executeQuery<{
    action: string;
    result: string;
    actor_kind: string;
    actor_id: string | null;
    details: Record<string, unknown>;
  }>(
    `SELECT action, result, actor_kind, actor_id, details
       FROM audit_events
      WHERE action IN ('auth.login', 'auth.lockout')
      ORDER BY id ASC`,
  );
  return rows.records;
}

describe.skipIf(trustedHost === undefined)("authentication audit emitters", () => {
  it("should record one allow event for a browser login without credential material", async () => {
    const user = await createLoginUser(9_601);
    const response = await login(user.email, TEST_PASSWORD, "203.0.113.10");
    expect(response.status).toBe(200);
    const events = await authEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "auth.login",
      result: "allow",
      actor_kind: "user",
      actor_id: user.id,
      details: { method: "local", client: "browser" },
    });
    expect(JSON.stringify(events)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(events)).not.toContain(user.email);
  });

  it("should record one system deny event for an unknown identifier", async () => {
    const response = await login("unknown@example.test", TEST_PASSWORD, "203.0.113.11");
    expect(response.status).toBe(401);
    const events = await authEvents();
    expect(events).toEqual([
      expect.objectContaining({
        action: "auth.login",
        result: "deny",
        actor_kind: "system",
        actor_id: null,
        details: expect.objectContaining({ reason: "unknown_credentials" }),
      }),
    ]);
  });

  it("should record five denies and one lockout for five wrong passwords", async () => {
    const user = await createLoginUser(9_602);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await login(user.email, "wrong password", `203.0.113.${20 + attempt}`);
      expect(response.status).toBe(401);
    }
    const events = await authEvents();
    expect(events.filter((event) => event.action === "auth.login")).toHaveLength(5);
    const lockouts = events.filter((event) => event.action === "auth.lockout");
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0]?.details).toMatchObject({ lockSeconds: 900 });
  });

  it("should record one locked denial without a new lockout for an already locked account", async () => {
    const response = await login(lockedUser.email, TEST_PASSWORD, "203.0.113.30");
    expect(response.status).toBe(401);
    const events = await authEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ reason: "locked" });
  });
});

import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import type { AuditService } from "../../src/audit/audit-service.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import {
  type AuditActors,
  auditDraft,
  resetAuditTables,
  seedAuditActors,
} from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

/** Returns a non-loopback IPv4 address for the trusted-proxy path. */
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
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let app: SecureWebApplication;
let handle: TransportHandle;
let actors: AuditActors;
let orgCookie: string;
let projectCookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
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
  const sessions = await app.getService<SessionService>("sessions");
  const orgSession = await sessions.create({
    principalId: actors.orgAdmin,
    authMethod: "local",
  });
  const projectSession = await sessions.create({
    principalId: actors.projectAuditor,
    authMethod: "local",
  });
  orgCookie = `${SESSION_COOKIE_NAME}=${orgSession.secretId}`;
  projectCookie = `${SESSION_COOKIE_NAME}=${projectSession.secretId}`;
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

/** Sends one authenticated admin request. */
async function send(
  path: string,
  cookie: string,
): Promise<Awaited<ReturnType<typeof testRequest>>> {
  return testRequest({
    port: handle.adminPort,
    path,
    host: trustedHost ?? "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: { cookie, origin: environment.config.baseUrl.origin },
  });
}

describe("audit HTTP routes", () => {
  it("should return a filtered event page", async () => {
    const service = await app.getService<AuditService>("auditService");
    await service.record(auditDraft(base));
    const response = await send("/v1/audit/events?action=project.read", orgCookie);
    expect(response.status).toBe(200);
    const body = response.json as {
      data: {
        events: {
          eventId: string;
          hash: string;
          hmac: string;
          prevHash: string;
          projectId: string | null;
        }[];
        nextCursor: null;
      };
    };
    expect(body.data.events).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();
    const event = body.data.events[0];
    expect(event?.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.projectId).toBe(base.projectId);
  });

  it("should reject an invalid limit with 422", async () => {
    const response = await send("/v1/audit/events?limit=0", orgCookie);
    expect(response.status).toBe(422);
    expect((response.json as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("should deny a project filter outside the caller grant with 403", async () => {
    const response = await send(`/v1/audit/events?projectId=${actors.projectB}`, projectCookie);
    expect(response.status).toBe(403);
    expect((response.json as { error: { code: string } }).error.code).toBe("access_denied");
  });

  it("should deny verify to a project auditor and allow an org auditor", async () => {
    const denied = await send("/v1/audit/verify", projectCookie);
    expect(denied.status).toBe(403);

    const allowed = await send("/v1/audit/verify", orgCookie);
    expect(allowed.status).toBe(200);
    expect((allowed.json as { data: { reason: string } }).data.reason).toBe("ok");
  });

  it("should stream NDJSON export with the expected content type", async () => {
    const service = await app.getService<AuditService>("auditService");
    await service.record(auditDraft(base));
    const response = await send("/v1/audit/export?action=project.read", orgCookie);
    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("application/x-ndjson");
    const lines = response.body.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? "{}") as { action: string }).action).toBe("project.read");
  });
});

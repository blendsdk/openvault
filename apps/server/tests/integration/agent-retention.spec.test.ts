import { randomBytes } from "node:crypto";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentMaintenanceRepository,
  AgentMaintenanceService,
  DatabaseAgentMaintenanceRepository,
} from "../../src/agent/agent-maintenance.js";
import type { AgentRuntime } from "../../src/agent/agent-runtime.js";
import { createAgentRuntime } from "../../src/agent/agent-runtime.js";
import { bootstrapAgentRuntime } from "../../src/agent/bootstrap.js";
import { CaSignerUnavailableError } from "../../src/security/ca.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import { DATA_PROBE_SECRET, registerAgentDataProbe } from "./helpers/agent-runtime.js";
import {
  type AgentCaFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  seedCaKey,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), statusCode: z.number() }),
});

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntime;
let actorId: string;
let projectId: string;
let serviceId: string;
let nextId = 6_000;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

async function insertToken(overrides: {
  readonly expiresAt: string;
  readonly usedAt?: string | null;
  readonly revokedAt?: string | null;
}): Promise<string> {
  const tokenId = id();
  await testDb.db.executeQuery(
    `INSERT INTO join_tokens
       (id, token_hash, principal_id, project_id, expires_at, used_at, revoked_at, created_by)
     VALUES
       (:id, :tokenHash, :principalId, :projectId, :expiresAt, :usedAt, :revokedAt, :createdBy)`,
    {
      id: tokenId,
      tokenHash: randomBytes(32),
      principalId: serviceId,
      projectId,
      expiresAt: overrides.expiresAt,
      usedAt: overrides.usedAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
      createdBy: actorId,
    },
  );
  return tokenId;
}

async function insertCertificate(overrides: {
  readonly notAfter: string;
  readonly revokedAt?: string | null;
}): Promise<string> {
  const certificateId = id();
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after, revoked_at)
     VALUES
       (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter, :revokedAt)`,
    {
      id: certificateId,
      principalId: serviceId,
      serial: randomBytes(16).toString("hex"),
      fingerprint: randomBytes(32).toString("hex"),
      notBefore: "2020-01-01T00:00:00.000Z",
      notAfter: overrides.notAfter,
      revokedAt: overrides.revokedAt ?? null,
    },
  );
  return certificateId;
}

async function exists(table: "join_tokens" | "workload_certs", rowId: string): Promise<boolean> {
  const result = await testDb.db.executeQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE id = :id`,
    { id: rowId },
  );
  return (result.records[0]?.count ?? 0) === 1;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  ca = await createAgentCaFixture();
  environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_INTERNAL_CA: ca.certPath,
    OPENVAULT_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  });
  server = await startAgentTestServer({
    testDb,
    environment,
    ca,
    rateLimitOptions: { joinLimit: 1_000, renewPrincipalLimit: 1_000, renewIpLimit: 1_000 },
  });
  runtime = server.runtime;

  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    {
      id: actorId,
      name: "Retention Operator",
      email: `retention-${actorId.toLowerCase()}@example.test`,
    },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
  );
  projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'retention')", {
    id: projectId,
  });
  serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'retention-service', :projectId)`,
    { id: serviceId, projectId },
  );
}, 60_000);

afterAll(async () => {
  if (server !== undefined) {
    await server.stop();
  }
  environment?.cleanup();
  ca?.cleanup();
  await testDb?.cleanup();
});

describe("bounded retention cleanup", () => {
  it("should delete tokens and certificates at the documented boundaries", async () => {
    const now = Date.now();
    const day = 86_400_000;
    const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
    const tokenDelete = await insertToken({
      expiresAt: iso(-3 * day),
      usedAt: iso(-3 * day),
      revokedAt: iso(-3 * day),
    });
    const tokenUsed = await insertToken({
      expiresAt: iso(-3 * day),
      usedAt: iso(-3_600_000),
    });
    const tokenFresh = await insertToken({ expiresAt: iso(100 * day) });
    const tokenRevoked = await insertToken({
      expiresAt: iso(-3 * day),
      revokedAt: iso(-3 * day),
    });

    const certificateDelete = await insertCertificate({
      notAfter: iso(-40 * day),
    });
    const certificatePostExpiryRevoke = await insertCertificate({
      notAfter: iso(-40 * day),
      revokedAt: iso(-2 * day),
    });
    const certificateRecentExpiry = await insertCertificate({
      notAfter: iso(-2 * day),
      revokedAt: iso(-40 * day),
    });
    const certificateRevokedLongAgo = await insertCertificate({
      notAfter: iso(-40 * day),
      revokedAt: iso(-40 * day),
    });

    const result = await runtime.maintenance.runOnce();
    expect(result.tokens).toBeGreaterThanOrEqual(2);
    expect(result.certificates).toBeGreaterThanOrEqual(2);

    expect(await exists("join_tokens", tokenDelete)).toBe(false);
    expect(await exists("join_tokens", tokenRevoked)).toBe(false);
    expect(await exists("join_tokens", tokenUsed)).toBe(true);
    expect(await exists("join_tokens", tokenFresh)).toBe(true);

    expect(await exists("workload_certs", certificateDelete)).toBe(false);
    expect(await exists("workload_certs", certificateRevokedLongAgo)).toBe(false);
    expect(await exists("workload_certs", certificatePostExpiryRevoke)).toBe(true);
    expect(await exists("workload_certs", certificateRecentExpiry)).toBe(true);
  });

  it("should bound one cleanup run to the configured batch size", async () => {
    const now = Date.now();
    const old = new Date(now - 3 * 86_400_000).toISOString();
    for (let index = 0; index < 3; index += 1) {
      await insertToken({ expiresAt: old, usedAt: old, revokedAt: old });
    }
    const service = new AgentMaintenanceService({
      repository: new DatabaseAgentMaintenanceRepository(testDb.db),
      logger: silentLogger(),
      batchSize: 1,
    });
    expect((await service.runOnce()).tokens).toBe(1);
    expect((await service.runOnce()).tokens).toBe(1);
  });

  it("should log a failed cleanup and keep the scheduler stoppable", async () => {
    const entries: { message: string; data: Record<string, unknown> | undefined }[] = [];
    const logger = silentLogger((message, data) => {
      entries.push({ message, data });
    });
    const repository: AgentMaintenanceRepository = {
      cleanupTokens: async () => {
        throw new Error("cleanup failed");
      },
      cleanupCertificates: async () => 0,
    };
    const service = new AgentMaintenanceService({ repository, logger, intervalMs: 60_000 });
    await service.start();
    await service.stop();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("Agent cleanup failed");
    expect(entries[0]?.data).toEqual({ code: "agent_cleanup_failed" });
  });
});

describe("readiness and startup", () => {
  it("should include the CA probe for a production agent runtime", async () => {
    const healthy = await testRequest({
      port: server.handle.adminPort,
      path: "/ready",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
    });
    expect(healthy.status).toBe(200);

    const original = runtime.caSigner.probe.bind(runtime.caSigner);
    runtime.caSigner.probe = async () => {
      throw new Error("ca probe failed");
    };
    try {
      const failing = await testRequest({
        port: server.handle.adminPort,
        path: "/ready",
        host: "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
      });
      expect(failing.status).toBe(503);
      expect(errorEnvelope.parse(failing.json).error.code).toBe("not_ready");
    } finally {
      runtime.caSigner.probe = original;
    }
  });

  it("should abort runtime creation when the CA row is missing or mismatched", async () => {
    const wrongCa = await createAgentCaFixture();
    try {
      const wrongEnvironment = createServerEnvironment({
        OPENVAULT_DB_URL: testDb.url,
        OPENVAULT_INTERNAL_CA: wrongCa.certPath,
      });
      try {
        const wrongTls = TlsMaterial.load(wrongEnvironment.config);
        const keyring = await KeyringProvider.load(wrongEnvironment.keyringPath);
        await expect(
          createAgentRuntime({
            database: testDb.db,
            keyring,
            tls: wrongTls,
            config: wrongEnvironment.config,
          }),
        ).rejects.toBeInstanceOf(CaSignerUnavailableError);
      } finally {
        wrongEnvironment.cleanup();
      }

      await testDb.db.executeQuery("DELETE FROM ca_keys");
      const keyring = await KeyringProvider.load(environment.keyringPath);
      await expect(
        createAgentRuntime({
          database: testDb.db,
          keyring,
          tls: server.tls,
          config: environment.config,
        }),
      ).rejects.toBeInstanceOf(CaSignerUnavailableError);
      await seedCaKey(testDb.db, keyring, ca);
    } finally {
      wrongCa.cleanup();
    }
  });
});

describe("admission-time delivery bound", () => {
  it("should fail revalidation and send no secret after a revoke during a slow route", async () => {
    const project = { id: id(), name: `delivery-${nextId}` };
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", project);
    const service = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'delivery-service', :projectId)`,
      { id: service, projectId: project.id },
    );
    const client = await createAgentClientCertificate(ca, service);
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, :serial, :fingerprint, now() - interval '1 hour',
               now() + interval '1 day')`,
      {
        id: id(),
        principalId: service,
        serial: client.fingerprint.slice(0, 32),
        fingerprint: client.fingerprint,
      },
    );

    const limitedDatabase = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const limited = await startAgentTestServer({
      testDb,
      environment,
      ca,
      seedCa: false,
      database: limitedDatabase,
      configure: (app) =>
        registerAgentDataProbe(app, { delayMs: 5_500, onEnter: () => enteredResolve?.() }),
    });
    try {
      const pending = testRequest({
        port: limited.handle.agentPort,
        path: `/v1/data/${project.name}/secrets/db`,
        host: "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
        cert: client.certPem,
        key: client.keyPem,
      });
      await entered;
      await limited.runtime.identityRuntime.service.revoke(actorId, service);
      const response = await pending;
      expect(response.status).toBe(401);
      expect(errorEnvelope.parse(response.json).error.code).toBe("authentication_required");
      expect(response.body).not.toContain(DATA_PROBE_SECRET);
    } finally {
      await limited.stop();
    }
  }, 30_000);
});

describe("runtime lifecycle", () => {
  it("should start maintenance and dispose the runtime after the listeners stop", async () => {
    await bootstrapAgentRuntime(server.app);
    expect(runtime.maintenance.started).toBe(true);
    runtime.authenticator.clear();

    const project = { id: id(), name: `lifecycle-${nextId}` };
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", project);
    const service = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'lifecycle-service', :projectId)`,
      { id: service, projectId: project.id },
    );
    const client = await createAgentClientCertificate(ca, service);
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, :serial, :fingerprint, now() - interval '1 hour',
               now() + interval '1 day')`,
      {
        id: id(),
        principalId: service,
        serial: client.fingerprint.slice(0, 32),
        fingerprint: client.fingerprint,
      },
    );
    const health = await testRequest({
      port: server.handle.agentPort,
      path: "/health",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
      cert: client.certPem,
      key: client.keyPem,
    });
    expect(health.status).toBe(200);
    runtime.renewalCache.set(service, "hash", {
      certificatePem: "certificate",
      chainPem: "chain",
      identityId: service,
      serial: "01",
      notAfter: "2027-01-01T00:00:00.000Z",
    });
    expect(runtime.authenticator.size).toBeGreaterThan(0);
    expect(runtime.renewalCache.size).toBeGreaterThan(0);

    await server.stop();
    expect(runtime.maintenance.started).toBe(false);
    expect(runtime.authenticator.size).toBe(0);
    expect(runtime.renewalCache.size).toBe(0);
    await expect(runtime.caSigner.probe()).rejects.toBeInstanceOf(CaSignerUnavailableError);
  }, 30_000);
});

function silentLogger(
  onError?: (message: string, data: Record<string, unknown> | undefined) => void,
): Logger {
  return {
    info: async () => undefined,
    warn: async () => undefined,
    debug: async () => undefined,
    error: async (message, data) => {
      onError?.(message, data);
    },
  };
}

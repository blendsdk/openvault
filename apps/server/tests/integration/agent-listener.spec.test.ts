import { Agent as HttpsAgent } from "node:https";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentAuthenticator } from "../../src/agent/agent-authenticator.js";
import type { AgentRuntime } from "../../src/agent/agent-runtime.js";
import { createTestApplication } from "../../src/app.js";
import type { SecureWebApplication } from "../../src/transport/secure-application.js";
import {
  type AgentTestServer,
  createAgentServerEnvironment,
  type ServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import { DATA_PROBE_SECRET, registerAgentDataProbe } from "./helpers/agent-runtime.js";
import {
  type AgentCaFixture,
  type AgentClientFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  createAgentCsr,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), statusCode: z.number() }),
});
const dataEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    secret: z.string(),
    projectId: z.string(),
    hasAuth: z.boolean(),
    agentKind: z.literal("agent"),
  }),
});

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntime;
let actorId: string;
let nextId = 5_000;
let nextName = 1;
let clockNow = Date.now();
const clock = () => clockNow;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

async function insertProject(): Promise<{ id: string; name: string }> {
  const project = { id: id(), name: `listener-${nextName++}` };
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", project);
  return project;
}

async function insertService(projectId: string): Promise<string> {
  const serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', :name, :projectId)`,
    { id: serviceId, name: `listener-svc-${nextName++}`, projectId },
  );
  return serviceId;
}

async function ensureActor(): Promise<string> {
  if (actorId !== undefined) {
    return actorId;
  }
  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    {
      id: actorId,
      name: "Listener Operator",
      email: `listener-${actorId.toLowerCase()}@example.test`,
    },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
  );
  return actorId;
}

async function insertCertificate(
  serviceId: string,
  client: AgentClientFixture,
  options: { readonly notBefore?: Date; readonly notAfter?: Date } = {},
): Promise<string> {
  const certificateId = id();
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after)
     VALUES (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter)`,
    {
      id: certificateId,
      principalId: serviceId,
      serial: client.fingerprint.slice(0, 32),
      fingerprint: client.fingerprint,
      notBefore: options.notBefore ?? new Date(Date.now() - 3_600_000),
      notAfter: options.notAfter ?? new Date(Date.now() + 86_400_000),
    },
  );
  return certificateId;
}

async function insertConsumer(serviceId: string, projectId: string): Promise<void> {
  await testDb.db.executeQuery(
    `INSERT INTO consumers
       (id, principal_id, project_id, compose_project, compose_service, hostname,
        manifest_hash, state, first_seen, last_seen)
     VALUES
       (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
        'ok', now(), now())`,
    { id: id(), principalId: serviceId, projectId, manifestHash: `sha256:${"b".repeat(64)}` },
  );
}

type SendOptions = {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly cert?: AgentClientFixture;
  readonly headers?: Record<string, string>;
  readonly agent?: HttpsAgent;
};

function send(options: SendOptions): Promise<TestResponse> {
  return testRequest({
    method: options.method ?? "GET",
    port: server.handle.agentPort,
    path: options.path,
    host: "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    ...(options.cert === undefined ? {} : { cert: options.cert.certPem, key: options.cert.keyPem }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function errorCode(response: TestResponse): string {
  return errorEnvelope.parse(response.json).error.code;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  ca = await createAgentCaFixture();
  environment = await createAgentServerEnvironment(ca, {
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_INTERNAL_CA: ca.certPath,
    OPENVAULT_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  });
  server = await startAgentTestServer({
    testDb,
    environment,
    ca,
    now: clock,
    rateLimitOptions: { joinLimit: 1_000, renewPrincipalLimit: 1_000, renewIpLimit: 1_000 },
    configure: (app) => registerAgentDataProbe(app),
  });
  runtime = server.runtime;
}, 60_000);

afterAll(async () => {
  if (server !== undefined) {
    await server.stop();
  }
  environment?.cleanup();
  ca?.cleanup();
  await testDb?.cleanup();
});

describe("data-route guard", () => {
  it("should allow the certificate project and reject foreign or deleted projects", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const client = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, client);
    const other = await insertProject();
    const deleted = await insertProject();
    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: deleted.id,
    });

    const matching = await send({
      path: `/v1/data/${project.name}/probe`,
      cert: client,
    });
    expect(matching.status).toBe(200);
    expect(dataEnvelope.parse(matching.json).data).toEqual({
      secret: DATA_PROBE_SECRET,
      projectId: project.id,
      hasAuth: false,
      agentKind: "agent",
    });

    const listAttempt = await send({
      path: `/v1/data/${project.name}/secrets`,
      cert: client,
    });
    expect(listAttempt.status).toBe(401);
    expect(errorCode(listAttempt)).toBe("authentication_required");

    const certificateList = await send({
      path: `/v1/data/${project.name}/certificates`,
      cert: client,
    });
    expect(certificateList.status).toBe(401);
    expect(errorCode(certificateList)).toBe("authentication_required");

    const foreignCertificate = await send({
      path: `/v1/data/${other.name}/certificates`,
      cert: client,
    });
    expect(foreignCertificate.status).toBe(403);

    for (const name of [other.name, deleted.name]) {
      const denied = await send({ path: `/v1/data/${name}/probe`, cert: client });
      expect(denied.status, name).toBe(403);
      expect(errorCode(denied)).toBe("access_denied");
    }

    const missing = await send({ path: `/v1/data/${project.name}/probe` });
    expect(missing.status).toBe(401);
    expect(errorCode(missing)).toBe("authentication_required");
  });

  it("should apply listener scope before authentication", async () => {
    const client = await createAgentClientCertificate(
      ca,
      await insertService((await insertProject()).id),
    );
    const agentAdmin = await send({ path: "/v1/admin/identities", cert: client });
    expect(agentAdmin.status).toBe(404);

    const adminAgent = await testRequest({
      port: server.handle.adminPort,
      path: "/v1/agent/renew",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
    });
    expect(adminAgent.status).toBe(404);
  });
});

describe("authenticator cache and revocation", () => {
  it("should serve a cached context, invalidate locally, and expire after five seconds", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const client = await createAgentClientCertificate(ca, serviceId);
    const certificateId = await insertCertificate(serviceId, client);
    runtime.authenticator.clear();

    expect((await send({ path: "/health", cert: client })).status).toBe(200);
    expect(runtime.authenticator.size).toBe(1);
    expect((await send({ path: "/health", cert: client })).status).toBe(200);

    await testDb.db.executeQuery("UPDATE workload_certs SET revoked_at = now() WHERE id = :id", {
      id: certificateId,
    });
    expect((await send({ path: "/health", cert: client })).status).toBe(200);

    runtime.authenticator.invalidatePrincipal(serviceId);
    const invalidated = await send({ path: "/health", cert: client });
    expect(invalidated.status).toBe(401);
    expect(errorCode(invalidated)).toBe("authentication_required");

    await testDb.db.executeQuery("UPDATE workload_certs SET revoked_at = NULL WHERE id = :id", {
      id: certificateId,
    });
    expect((await send({ path: "/health", cert: client })).status).toBe(200);
    await testDb.db.executeQuery("UPDATE workload_certs SET revoked_at = now() WHERE id = :id", {
      id: certificateId,
    });
    clockNow += 5_001;
    expect((await send({ path: "/health", cert: client })).status).toBe(401);
  });

  it("should accept a newly issued certificate immediately", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const first = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, first);
    expect((await send({ path: "/health", cert: first })).status).toBe(200);

    const second = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, second);
    expect((await send({ path: "/health", cert: second })).status).toBe(200);
  });

  it("should revoke new, reused, and renewal connections within the process", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const client = await createAgentClientCertificate(ca, serviceId);
    const certificateId = await insertCertificate(serviceId, client);
    await insertConsumer(serviceId, project.id);

    let connections = 0;
    server.handle.agentServer.on("secureConnection", () => {
      connections += 1;
    });
    const agent = new HttpsAgent({
      keepAlive: true,
      ca: environment.tls.caPem,
      cert: client.certPem,
      key: client.keyPem,
      servername: "localhost",
    });
    try {
      expect((await send({ path: "/health", cert: client, agent })).status).toBe(200);
      expect(connections).toBe(1);
      await runtime.identityRuntime.service.revoke(await ensureActor(), serviceId);
      expect((await send({ path: "/health", cert: client, agent })).status).toBe(401);
      expect(connections).toBe(1);
    } finally {
      agent.destroy();
    }

    expect((await send({ path: "/health", cert: client })).status).toBe(401);
    const renewal = await send({
      path: "/v1/agent/renew",
      method: "POST",
      cert: client,
      headers: { "content-type": "application/json" },
      body: {
        csr: (await createAgentCsr()).csrPem,
        consumer: {
          composeProject: "payments",
          composeService: "api",
          hostname: "api-1",
          manifestHash: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    expect(renewal.status).toBe(401);

    const state = await testDb.db.executeQuery<{
      cert_revoked: Date | null;
      consumer_state: string;
    }>(
      `SELECT c.revoked_at AS cert_revoked, u.state AS consumer_state
         FROM workload_certs c JOIN consumers u ON u.principal_id = c.principal_id
        WHERE c.id = :id`,
      { id: certificateId },
    );
    expect(state.records[0]?.cert_revoked).not.toBeNull();
    expect(state.records[0]?.consumer_state).toBe("failed");
  });

  it("should make concurrent revokes idempotent and leave one consistent state", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const client = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, client);
    const actor = await ensureActor();

    await expect(
      Promise.all([
        runtime.identityRuntime.service.revoke(actor, serviceId),
        runtime.identityRuntime.service.revoke(actor, serviceId),
      ]),
    ).resolves.toBeDefined();

    const state = await testDb.db.executeQuery<{ status: string; disabled_at: Date | null }>(
      "SELECT status, disabled_at FROM principals WHERE id = :id",
      { id: serviceId },
    );
    expect(state.records[0]?.status).toBe("disabled");
    expect(state.records[0]?.disabled_at).not.toBeNull();
  });
});

describe("mixed credentials on the agent listener", () => {
  it("should skip browser cookie and CLI bearer resolution", async () => {
    const project = await insertProject();
    const serviceId = await insertService(project.id);
    const client = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, client);

    const response = await send({
      path: `/v1/data/${project.name}/probe`,
      cert: client,
      headers: {
        cookie: "openvault_session=not-a-session",
        authorization: "Bearer not-a-token",
      },
    });
    expect(response.status).toBe(200);
    expect(dataEnvelope.parse(response.json).data.hasAuth).toBe(false);
  });
});

describe("agent authentication failure", () => {
  it("should fail closed with 503 when authentication throws", async () => {
    const throwing: AgentAuthenticator = {
      authenticate: async () => {
        throw new Error("database unavailable");
      },
      revalidate: async () => {
        throw new Error("database unavailable");
      },
      invalidatePrincipal: () => undefined,
    };
    const database = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    const app: SecureWebApplication = await createTestApplication(environment.config, {
      database,
      tls: server.tls,
      keyring: server.keyring,
      agentOverrides: {
        authenticator: throwing,
        projectResolver: { resolveActiveByName: async () => undefined },
      },
    });
    const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
    try {
      const response = await testRequest({
        port: handle.agentPort,
        path: "/health",
        host: "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
      });
      expect(response.status).toBe(503);
      expect(errorCode(response)).toBe("service_unavailable");
    } finally {
      await handle.stop();
    }
  }, 30_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SecretService } from "../../src/secrets/service.js";
import type { AgentTestServer } from "./helpers/agent-app.js";
import {
  createAgentServerEnvironment,
  type ServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  type AgentClientFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), statusCode: z.number() }),
});

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let client: AgentClientFixture;
let projectId: string;
let projectName: string;
let serviceId: string;
let secretName: string;
let nextSeed = 7_000;

function id(): string {
  nextSeed += 1;
  return testUlid(nextSeed);
}

function send(options: {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): Promise<TestResponse> {
  return testRequest({
    method: options.method ?? "GET",
    port: server.handle.agentPort,
    path: options.path,
    host: "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    cert: client.certPem,
    key: client.keyPem,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function errorCode(response: TestResponse): string {
  return errorEnvelope.parse(response.json).error.code;
}

async function consumerRow(): Promise<{ state: string; last_seen: Date } | undefined> {
  const result = await testDb.db.executeQuery<{ state: string; last_seen: Date }>(
    "SELECT state, last_seen FROM consumers WHERE principal_id = :id",
    { id: serviceId },
  );
  return result.records[0];
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
    rateLimitOptions: { joinLimit: 1_000, renewPrincipalLimit: 1_000, renewIpLimit: 1_000 },
  });

  const adminId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', 'Consumer Admin', :email, 'active')`,
    { id: adminId, email: `consumer-${adminId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: adminId },
  );
  projectId = id();
  projectName = `consumer-${id().slice(-8).toLowerCase()}`;
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id: projectId,
    name: projectName,
  });
  const service = await server.app.getService<SecretService>("secretService");
  secretName = `consumer-secret-${id().slice(-6).toLowerCase()}`;
  await service.create(adminId, projectName, { name: secretName, value: "consumer-value" });

  serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id, status)
     VALUES (:id, 'service', 'consumer-agent', :projectId, 'active')`,
    { id: serviceId, projectId },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'secrets.reader', 'project', :projectId, :principalId)`,
    { id: id(), principalId: serviceId, projectId },
  );
  client = await createAgentClientCertificate(ca, serviceId);
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after)
     VALUES (:id, :principalId, :serial, :fingerprint, now() - interval '1 hour',
             now() + interval '1 day')`,
    {
      id: id(),
      principalId: serviceId,
      serial: client.fingerprint.slice(0, 32),
      fingerprint: client.fingerprint,
    },
  );
  await testDb.db.executeQuery(
    `INSERT INTO consumers
       (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash,
        state, first_seen, last_seen)
     VALUES (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :hash,
             'ok', now() - interval '1 hour', now() - interval '1 hour')`,
    {
      id: id(),
      principalId: serviceId,
      projectId,
      hash: `sha256:${"b".repeat(64)}`,
    },
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

describe("agent consumer state", () => {
  it("should update last_seen and state from the fetch headers", async () => {
    const before = await consumerRow();
    const response = await send({
      path: `/v1/data/${projectName}/secrets/${secretName}`,
      headers: {
        "x-openvault-consumer-state": "degraded",
        "x-openvault-entry-optional": "false",
      },
    });
    expect(response.status).toBe(200);
    const after = await consumerRow();
    expect(after?.state).toBe("degraded");
    expect(after?.last_seen.getTime()).toBeGreaterThan(before?.last_seen.getTime() ?? 0);
  });

  it("should mark a required missing entry failed and an optional one degraded", async () => {
    const missing = `/v1/data/${projectName}/secrets/does-not-exist`;
    expect(
      (
        await send({
          path: missing,
          headers: { "x-openvault-entry-optional": "false" },
        })
      ).status,
    ).toBe(404);
    expect((await consumerRow())?.state).toBe("failed");
    expect(
      (
        await send({
          path: missing,
          headers: { "x-openvault-entry-optional": "true" },
        })
      ).status,
    ).toBe(404);
    expect((await consumerRow())?.state).toBe("degraded");
  });

  it("should reject an invalid state header before the read", async () => {
    const response = await send({
      path: `/v1/data/${projectName}/secrets/${secretName}`,
      headers: { "x-openvault-consumer-state": "unknown" },
    });
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("validation_error");
  });

  it("should accept an aggregate heartbeat and audit the state change", async () => {
    const response = await send({
      method: "POST",
      path: "/v1/agent/consumer",
      body: { state: "ok" },
    });
    expect(response.status).toBe(200);
    expect((await consumerRow())?.state).toBe("ok");
    const events = await testDb.db.executeQuery<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_events
        WHERE action = 'consumer.update' AND object_id IN (
          SELECT id::text FROM consumers WHERE principal_id = :id
        )
        ORDER BY id DESC LIMIT 1`,
      { id: serviceId },
    );
    expect(events.records[0]?.action).toBe("consumer.update");
  });

  it("should mark a hidden 404 as failed", async () => {
    await testDb.db.executeQuery(
      "DELETE FROM role_assignments WHERE principal_id = :id AND role = 'secrets.reader'",
      { id: serviceId },
    );
    const response = await send({
      path: `/v1/data/${projectName}/secrets/${secretName}`,
      headers: { "x-openvault-entry-optional": "false" },
    });
    expect(response.status).toBe(404);
    expect((await consumerRow())?.state).toBe("failed");
  });
});

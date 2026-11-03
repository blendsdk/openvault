import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../src/agent/agent-runtime.js";
import { AgentTokenService } from "../../src/agent/agent-token-service.js";
import { IdentityAuthorizer } from "../../src/identity/identity-authorizer.js";
import { IdentityRepository } from "../../src/identity/identity-repository.js";
import { IdentityService } from "../../src/identity/identity-service.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntime;
let actorId: string;
let nextId = 7_000;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
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
    { id: actorId, name: "Revoke Operator", email: `revoke-${actorId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
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

async function createIdentity(): Promise<{ projectId: string; serviceId: string }> {
  const projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id: projectId,
    name: `revoke-${nextId}`,
  });
  const serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', :name, :projectId)`,
    { id: serviceId, name: `revoke-svc-${nextId}`, projectId },
  );
  return { projectId, serviceId };
}

async function insertCertificate(
  serviceId: string,
  fingerprint: string,
  notAfter: Date,
): Promise<string> {
  const certificateId = id();
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after)
     VALUES (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter)`,
    {
      id: certificateId,
      principalId: serviceId,
      serial: fingerprint.slice(0, 32),
      fingerprint,
      notBefore: new Date(notAfter.getTime() - 86_400_000),
      notAfter,
    },
  );
  return certificateId;
}

describe("revocation internals", () => {
  it("should clear both local caches after an atomic revoke", async () => {
    const { projectId, serviceId } = await createIdentity();
    const client = await createAgentClientCertificate(ca, serviceId);
    await insertCertificate(serviceId, client.fingerprint, new Date(Date.now() + 86_400_000));
    await testDb.db.executeQuery(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname,
          manifest_hash, state, first_seen, last_seen)
       VALUES
         (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
          'ok', now(), now())`,
      { id: id(), principalId: serviceId, projectId, manifestHash: `sha256:${"b".repeat(64)}` },
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
    expect(runtime.authenticator.size).toBe(1);
    runtime.renewalCache.set(serviceId, "hash", {
      certificatePem: "certificate",
      chainPem: "chain",
      identityId: serviceId,
      serial: "01",
      notAfter: "2027-01-01T00:00:00.000Z",
    });
    expect(runtime.renewalCache.size).toBe(1);

    await runtime.identityRuntime.service.revoke(actorId, serviceId);
    expect(runtime.authenticator.size).toBe(0);
    expect(runtime.renewalCache.size).toBe(0);

    const state = await testDb.db.executeQuery<{
      status: string;
      cert_revoked: Date | null;
      consumer_state: string;
    }>(
      `SELECT p.status, c.revoked_at AS cert_revoked, u.state AS consumer_state
         FROM principals p
         JOIN workload_certs c ON c.principal_id = p.id
         JOIN consumers u ON u.principal_id = p.id
        WHERE p.id = :id`,
      { id: serviceId },
    );
    expect(state.records[0]?.status).toBe("disabled");
    expect(state.records[0]?.cert_revoked).not.toBeNull();
    expect(state.records[0]?.consumer_state).toBe("failed");
  });

  it("should roll back the whole revoke when token revocation fails", async () => {
    const { projectId, serviceId } = await createIdentity();
    const certificateId = await insertCertificate(
      serviceId,
      "c".repeat(64),
      new Date(Date.now() + 86_400_000),
    );
    await testDb.db.executeQuery(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname,
          manifest_hash, state, first_seen, last_seen)
       VALUES
         (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
          'ok', now(), now())`,
      { id: id(), principalId: serviceId, projectId, manifestHash: `sha256:${"b".repeat(64)}` },
    );

    class FailingTokens extends AgentTokenService {
      public override async revokeUnused(): Promise<void> {
        throw new Error("token revocation failed");
      }
    }
    let invalidated = false;
    const service = new IdentityService({
      repository: new IdentityRepository(testDb.db),
      authorizer: new IdentityAuthorizer(testDb.db),
      tokens: new FailingTokens({
        database: testDb.db,
        config: { joinTokenTtlMs: 900_000 },
      }),
      database: testDb.db,
      onRevoked: () => {
        invalidated = true;
      },
    });

    await expect(service.revoke(actorId, serviceId)).rejects.toThrow("token revocation failed");
    expect(invalidated).toBe(false);

    const state = await testDb.db.executeQuery<{
      status: string;
      cert_revoked: Date | null;
      consumer_state: string;
    }>(
      `SELECT p.status, c.revoked_at AS cert_revoked, u.state AS consumer_state
         FROM principals p
         JOIN workload_certs c ON c.principal_id = p.id
         JOIN consumers u ON u.principal_id = p.id
        WHERE c.id = :id`,
      { id: certificateId },
    );
    expect(state.records[0]?.status).toBe("active");
    expect(state.records[0]?.cert_revoked).toBeNull();
    expect(state.records[0]?.consumer_state).toBe("ok");
  });

  it("should disable a principal without rewriting an already expired certificate", async () => {
    const { serviceId } = await createIdentity();
    const certificateId = await insertCertificate(
      serviceId,
      "e".repeat(64),
      new Date(Date.now() - 86_400_000),
    );

    await expect(
      runtime.identityRuntime.service.revoke(actorId, serviceId),
    ).resolves.toBeUndefined();
    const state = await testDb.db.executeQuery<{ status: string; revoked_at: Date | null }>(
      `SELECT p.status, c.revoked_at
         FROM principals p JOIN workload_certs c ON c.principal_id = p.id
        WHERE c.id = :id`,
      { id: certificateId },
    );
    expect(state.records[0]?.status).toBe("disabled");
    expect(state.records[0]?.revoked_at).toBeNull();
  });
});

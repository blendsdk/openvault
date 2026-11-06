import type { AgentConsumer } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentJoinService } from "../../src/agent/agent-join-service.js";
import type { AgentRuntimeCore } from "../../src/agent/agent-runtime.js";
import { ConsumerRepository } from "../../src/agent/consumer-repository.js";
import { CaSigner } from "../../src/security/ca.js";
import {
  type AgentTestServer,
  createAgentServerEnvironment,
  type ServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import { type AgentCaFixture, createAgentCaFixture, createAgentCsr } from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const consumer: AgentConsumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
};

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntimeCore;
let actorId: string;
let projectId: string;
let serviceId: string;
let nextId = 3_000;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
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
  runtime = server.runtime;

  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id: actorId, name: "Impl Operator", email: `impl-${actorId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
  );

  projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'impl-project')", {
    id: projectId,
  });
  serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'impl-service', :projectId)`,
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

async function issueToken(): Promise<{ id: string; token: string }> {
  return runtime.identityRuntime.service.issueJoinToken(actorId, serviceId, undefined);
}

describe("join transaction internals", () => {
  it("should roll back the token when the serial keeps colliding", async () => {
    const otherService = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'conflict-owner', :projectId)`,
      { id: otherService, projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, 'deadbeef', :fingerprint, now() - interval '1 hour', now() + interval '1 day')`,
      { id: id(), principalId: otherService, fingerprint: "a".repeat(64) },
    );

    const signer = await CaSigner.load({
      database: testDb.db,
      keyring: server.keyring,
      caPem: ca.certPem,
      serialSource: () => "deadbeef",
    });
    const service = new AgentJoinService({
      database: testDb.db,
      tokens: runtime.identityRuntime.tokens,
      consumers: new ConsumerRepository(testDb.db),
      signer,
      config: { certTtlDays: 30 },
    });
    const token = await issueToken();
    const csr = await createAgentCsr();

    await expect(
      service.join({ token: token.token, csr: csr.csrPem, consumer }),
    ).rejects.toMatchObject({ code: "ca_unavailable", statusCode: 503 });

    const row = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(row.records[0]?.used_at).toBeNull();
    expect(
      (
        await testDb.db.executeQuery<{ count: number }>(
          "SELECT count(*)::int AS count FROM workload_certs WHERE principal_id = :id",
          { id: serviceId },
        )
      ).records[0]?.count,
    ).toBe(0);
    signer.destroy();
  });

  it("should succeed after a transient serial collision", async () => {
    const otherService = id();
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'transient-owner', :projectId)`,
      { id: otherService, projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, 'cafebabe', :fingerprint, now() - interval '1 hour', now() + interval '1 day')`,
      { id: id(), principalId: otherService, fingerprint: "c".repeat(64) },
    );
    const serials = ["cafebabe", "cafebabe", "feed1234"];
    let serialIndex = 0;
    const signer = await CaSigner.load({
      database: testDb.db,
      keyring: server.keyring,
      caPem: ca.certPem,
      serialSource: () => serials[Math.min(serialIndex++, serials.length - 1)] ?? "feed1234",
    });
    const service = new AgentJoinService({
      database: testDb.db,
      tokens: runtime.identityRuntime.tokens,
      consumers: new ConsumerRepository(testDb.db),
      signer,
      config: { certTtlDays: 30 },
    });
    const token = await issueToken();
    const csr = await createAgentCsr();
    const response = await service.join({ token: token.token, csr: csr.csrPem, consumer });
    expect(response.serial).toBe("feed1234");
    signer.destroy();
  });

  it("should roll back the token when the signer fails", async () => {
    const signer = await CaSigner.load({
      database: testDb.db,
      keyring: server.keyring,
      caPem: ca.certPem,
    });
    signer.destroy();
    const service = new AgentJoinService({
      database: testDb.db,
      tokens: runtime.identityRuntime.tokens,
      consumers: new ConsumerRepository(testDb.db),
      signer,
      config: { certTtlDays: 30 },
    });
    const token = await issueToken();
    const csr = await createAgentCsr();

    await expect(
      service.join({ token: token.token, csr: csr.csrPem, consumer }),
    ).rejects.toMatchObject({ code: "ca_unavailable", statusCode: 503 });

    const row = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(row.records[0]?.used_at).toBeNull();
  });

  it("should claim one token once under concurrent service calls", async () => {
    const token = await issueToken();
    const csr = await createAgentCsr();
    const results = await Promise.allSettled([
      runtime.joinService.join({ token: token.token, csr: csr.csrPem, consumer }),
      runtime.joinService.join({ token: token.token, csr: csr.csrPem, consumer }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "join_failed",
      statusCode: 401,
    });
  });
});

describe("consumer upsert internals", () => {
  it("should preserve first_seen while moving metadata and last_seen", async () => {
    const repository = new ConsumerRepository(testDb.db);
    const first = await repository.upsert(testDb.db, {
      principalId: serviceId,
      projectId,
      consumer,
    });
    const second = await repository.upsert(testDb.db, {
      principalId: serviceId,
      projectId,
      consumer: { ...consumer, composeService: "worker", hostname: "api-2" },
    });

    expect(second.id).toBe(first.id);
    expect(second.firstSeen.getTime()).toBe(first.firstSeen.getTime());
    expect(second.lastSeen.getTime()).toBeGreaterThanOrEqual(first.lastSeen.getTime());
    expect(second.composeService).toBe("worker");
    expect(second.state).toBe("ok");

    const rows = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM consumers WHERE principal_id = :id",
      { id: serviceId },
    );
    expect(rows.records[0]?.count).toBe(1);
    expect(newUlid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

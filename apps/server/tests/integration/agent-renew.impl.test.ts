import type { AgentConsumer } from "@openvault/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRenewService, RenewalReplayCache } from "../../src/agent/agent-renew-service.js";
import { ConsumerRepository } from "../../src/agent/consumer-repository.js";
import type { AgentAuthContext } from "../../src/agent/types.js";
import { CaSigner } from "../../src/security/ca.js";
import {
  type AgentTestServer,
  createAgentServerEnvironment,
  type ServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  createAgentCsr,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const consumer: AgentConsumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
};
const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;

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
}, 60_000);

afterAll(async () => {
  if (server !== undefined) {
    await server.stop();
  }
  environment?.cleanup();
  ca?.cleanup();
  await testDb?.cleanup();
});

function context(publicKeySha256: string): AgentAuthContext {
  return {
    kind: "agent",
    principalId: PRINCIPAL,
    projectId: testUlid(4_001),
    projectName: "renew-impl",
    certificateId: testUlid(4_002),
    serial: "01",
    fingerprint: "a".repeat(64),
    publicKeySha256,
    notAfter: Date.now() + 86_400_000,
  };
}

describe("renewal serial handling", () => {
  it("should retry a serial collision and fail closed with 503", async () => {
    const projectId = testUlid(4_100);
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'renew-serial')", {
      id: projectId,
    });
    const serviceId = testUlid(4_101);
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'renew-serial-target', :projectId)`,
      { id: serviceId, projectId },
    );
    const otherService = testUlid(4_102);
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', 'renew-serial-owner', :projectId)`,
      { id: otherService, projectId },
    );
    const client = await createAgentClientCertificate(ca, serviceId);
    const currentId = testUlid(4_103);
    const now = Date.now();
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, 'c0ffee', :fingerprint, :notBefore, :notAfter)`,
      {
        id: currentId,
        principalId: serviceId,
        fingerprint: client.fingerprint,
        notBefore: new Date(now - 25 * 86_400_000),
        notAfter: new Date(now + 5 * 86_400_000),
      },
    );
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after)
       VALUES (:id, :principalId, 'deadbeef', :fingerprint, now() - interval '1 hour', now() + interval '1 day')`,
      { id: testUlid(4_104), principalId: otherService, fingerprint: "d".repeat(64) },
    );

    const signer = await CaSigner.load({
      database: testDb.db,
      keyring: server.keyring,
      caPem: ca.certPem,
      serialSource: () => "deadbeef",
    });
    const service = new AgentRenewService({
      database: testDb.db,
      consumers: new ConsumerRepository(testDb.db),
      signer,
      config: { certTtlDays: 30 },
      cache: new RenewalReplayCache(),
    });
    const csr = await createAgentCsr();
    await expect(
      service.renew(
        {
          kind: "agent",
          principalId: serviceId,
          projectId,
          projectName: "renew-serial",
          certificateId: currentId,
          serial: "c0ffee",
          fingerprint: client.fingerprint,
          publicKeySha256: client.publicKeySha256,
          notAfter: now + 5 * 86_400_000,
        },
        { csr: csr.csrPem, consumer },
      ),
    ).rejects.toMatchObject({ code: "ca_unavailable", statusCode: 503 });

    const count = await testDb.db.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM workload_certs WHERE principal_id = :id",
      { id: serviceId },
    );
    expect(count.records[0]?.count).toBe(1);
    signer.destroy();
  });
});

describe("renewal service internals", () => {
  it("should reject the authenticating key before any database work", async () => {
    const csr = await createAgentCsr();
    await expect(
      server.runtime.renewService.renew(context(csr.publicKeySha256), {
        csr: csr.csrPem,
        consumer,
      }),
    ).rejects.toMatchObject({ code: "validation_error", statusCode: 422 });
  });

  it("should reject a malformed CSR before any database work", async () => {
    await expect(
      server.runtime.renewService.renew(context("b".repeat(64)), {
        csr: "not a csr",
        consumer,
      }),
    ).rejects.toMatchObject({ code: "validation_error", statusCode: 422 });
  });

  it("should clear replay entries for one principal only", () => {
    const cache = server.runtime.renewalCache;
    const response = {
      certificatePem: "certificate",
      chainPem: "chain",
      identityId: PRINCIPAL,
      serial: "01",
      notAfter: "2027-01-01T00:00:00.000Z",
    };
    cache.set(PRINCIPAL, "hash-a", response);
    cache.set(PRINCIPAL, "hash-b", response);
    cache.set(OTHER, "hash-a", response);

    server.runtime.renewService.invalidatePrincipal(PRINCIPAL);
    expect(cache.get(PRINCIPAL, "hash-a")).toBeUndefined();
    expect(cache.get(PRINCIPAL, "hash-b")).toBeUndefined();
    expect(cache.get(OTHER, "hash-a")).toEqual(response);
    server.runtime.renewService.clear();
    expect(cache.size).toBe(0);
  });
});

import type { AgentConsumer } from "@openvault/api-contract";
import { agentCertificateResponseSchema } from "@openvault/api-contract";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { RenewalReplayCache } from "../../src/agent/agent-renew-service.js";
import { ConsumerRepository } from "../../src/agent/consumer-repository.js";
import type { AgentAuthContext } from "../../src/agent/types.js";
import { x509 } from "../../src/security/x509.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  type AgentClientFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  createAgentCsr,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), statusCode: z.number() }),
});
const certificateEnvelope = z.object({
  success: z.literal(true),
  data: agentCertificateResponseSchema,
});

const consumer: AgentConsumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"b".repeat(64)}`,
};
const DAY = 86_400_000;

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let clockNow = Date.now();
const clock = () => clockNow;
let nextId = 2_000;
let nextName = 1;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

async function insertProject(): Promise<string> {
  const projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id: projectId,
    name: `renew-${nextName++}`,
  });
  return projectId;
}

async function insertService(projectId: string): Promise<string> {
  const serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', :name, :projectId)`,
    { id: serviceId, name: `renew-svc-${nextName++}`, projectId },
  );
  return serviceId;
}

interface RenewalFixture {
  readonly projectId: string;
  readonly serviceId: string;
  readonly certificateId: string;
  readonly client: AgentClientFixture;
}

async function createRenewalFixture(input: {
  readonly notBeforeOffsetDays: number;
  readonly notAfterOffsetDays: number;
}): Promise<RenewalFixture> {
  const projectId = await insertProject();
  const serviceId = await insertService(projectId);
  const client = await createAgentClientCertificate(ca, serviceId);
  clockNow = Date.now();
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
      notBefore: new Date(clockNow + input.notBeforeOffsetDays * DAY),
      notAfter: new Date(clockNow + input.notAfterOffsetDays * DAY),
    },
  );
  return { projectId, serviceId, certificateId, client };
}

type RenewOptions = {
  readonly path?: string;
  readonly body?: unknown;
  readonly cert?: AgentClientFixture;
  readonly headers?: Record<string, string>;
};

function renew(
  fixture: RenewalFixture,
  csr: string,
  options: RenewOptions = {},
): Promise<TestResponse> {
  const certificate = options.cert ?? fixture.client;
  return testRequest({
    method: "POST",
    port: server.handle.agentPort,
    path: options.path ?? "/v1/agent/renew",
    host: "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    cert: certificate.certPem,
    key: certificate.keyPem,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(options.body ?? { csr, consumer }),
  });
}

async function certificateCount(serviceId: string): Promise<number> {
  const result = await testDb.db.executeQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM workload_certs WHERE principal_id = :id",
    { id: serviceId },
  );
  return result.records[0]?.count ?? 0;
}

async function consumerRows(serviceId: string) {
  const result = await testDb.db.executeQuery<{
    id: string;
    first_seen: Date;
    last_seen: Date;
    state: string;
    compose_service: string;
  }>(
    `SELECT id, first_seen, last_seen, state, compose_service
       FROM consumers WHERE principal_id = :id`,
    { id: serviceId },
  );
  return result.records;
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
    now: clock,
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

describe("renewal threshold and current certificate", () => {
  it("should reject renewal before two thirds of the actual lifetime", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -10,
      notAfterOffsetDays: 20,
    });
    const csr = await createAgentCsr();
    const response = await renew(fixture, csr.csrPem);
    expect(response.status).toBe(409);
    expect(errorEnvelope.parse(response.json).error.code).toBe("renewal_not_due");
    expect(await certificateCount(fixture.serviceId)).toBe(1);
  });

  it("should renew at the two-thirds boundary with a fresh key and keep the old certificate valid", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const first = await renew(fixture, (await createAgentCsr()).csrPem);
    expect(first.status).toBe(200);
    const issued = certificateEnvelope.parse(first.json).data;
    expect(issued.identityId).toBe(fixture.serviceId);
    expect(await certificateCount(fixture.serviceId)).toBe(2);

    const old = await testDb.db.executeQuery<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM workload_certs WHERE id = :id",
      { id: fixture.certificateId },
    );
    expect(old.records[0]?.revoked_at).toBeNull();

    const certificate = new x509.X509Certificate(issued.certificatePem);
    expect(certificate.notAfter.getTime() - certificate.notBefore.getTime()).toBe(30 * DAY);

    const stale = await renew(fixture, (await createAgentCsr()).csrPem);
    expect(stale.status).toBe(409);
    expect(errorEnvelope.parse(stale.json).error.code).toBe("renewal_not_current");
  });

  it("should reject renewal from an older certificate", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const newerCertificateId = id();
    await testDb.db.executeQuery(
      `INSERT INTO workload_certs
         (id, principal_id, serial, fingerprint, not_before, not_after, issued_at)
       VALUES
         (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter, now() + interval '1 second')`,
      {
        id: newerCertificateId,
        principalId: fixture.serviceId,
        serial: `newer-${newerCertificateId}`,
        fingerprint: "f".repeat(64),
        notBefore: new Date(clockNow - DAY),
        notAfter: new Date(clockNow + 10 * DAY),
      },
    );
    const response = await renew(fixture, (await createAgentCsr()).csrPem);
    expect(response.status).toBe(409);
    expect(errorEnvelope.parse(response.json).error.code).toBe("renewal_not_current");
    expect(await certificateCount(fixture.serviceId)).toBe(2);
  });
});

describe("renewal replay", () => {
  it("should replay the same certificate response inside five minutes without a new row", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const csr = await createAgentCsr();
    const first = await renew(fixture, csr.csrPem);
    expect(first.status).toBe(200);
    const issued = certificateEnvelope.parse(first.json).data;
    expect(await certificateCount(fixture.serviceId)).toBe(2);

    const replay = await renew(fixture, csr.csrPem);
    expect(replay.status).toBe(200);
    expect(certificateEnvelope.parse(replay.json).data).toEqual(issued);
    expect(await certificateCount(fixture.serviceId)).toBe(2);
  });

  it("should miss the replay cache after five minutes and require a current certificate", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const csr = await createAgentCsr();
    expect((await renew(fixture, csr.csrPem)).status).toBe(200);
    clockNow += 5 * 60_000 + 1;
    const stale = await renew(fixture, csr.csrPem);
    expect(stale.status).toBe(409);
    expect(errorEnvelope.parse(stale.json).error.code).toBe("renewal_not_current");
  });
});

describe("renewal authentication and validation", () => {
  it("should reject an expired database certificate at the middleware", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -10,
      notAfterOffsetDays: -1 / 86_400,
    });
    const response = await renew(fixture, (await createAgentCsr()).csrPem);
    expect(response.status).toBe(401);
    expect(errorEnvelope.parse(response.json).error.code).toBe("authentication_required");
    expect(await certificateCount(fixture.serviceId)).toBe(1);
  });

  it("should reject the authenticating certificate key and a malformed CSR", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const sameKeyCsr = await createAgentCsr({ keys: fixture.client.keys });
    const sameKey = await renew(fixture, sameKeyCsr.csrPem);
    expect(sameKey.status).toBe(422);
    expect(errorEnvelope.parse(sameKey.json).error.code).toBe("validation_error");

    const malformed = await renew(fixture, "not a csr");
    expect(malformed.status).toBe(422);
    expect(errorEnvelope.parse(malformed.json).error.code).toBe("validation_error");
    expect(await certificateCount(fixture.serviceId)).toBe(1);
  });

  it("should reject renewal after revoke, disable, or project deletion", async () => {
    for (const mutation of ["revoked", "disabled", "deleted"] as const) {
      const fixture = await createRenewalFixture({
        notBeforeOffsetDays: -25,
        notAfterOffsetDays: 5,
      });
      if (mutation === "revoked") {
        await server.runtime.identityRuntime.service.revoke(await ensureActor(), fixture.serviceId);
      } else if (mutation === "disabled") {
        await testDb.db.executeQuery(
          "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
          { id: fixture.serviceId },
        );
      } else {
        await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
          id: fixture.projectId,
        });
      }
      const response = await renew(fixture, (await createAgentCsr()).csrPem);
      expect(response.status, mutation).toBe(401);
      expect(errorEnvelope.parse(response.json).error.code).toBe("authentication_required");
      expect(await certificateCount(fixture.serviceId)).toBe(1);
    }
  });
});

let actorId: string | undefined;

async function ensureActor(): Promise<string> {
  if (actorId !== undefined) {
    return actorId;
  }
  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id: actorId, name: "Renew Operator", email: `renew-${actorId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
  );
  return actorId;
}

describe("renewal TTL and consumer", () => {
  it("should derive validity from the configured 1 and 90 day TTL", async () => {
    for (const ttlDays of [1, 90]) {
      const fixture = await createRenewalFixture({
        notBeforeOffsetDays: -10,
        notAfterOffsetDays: 5,
      });
      const csr = await createAgentCsr();
      const context: AgentAuthContext = {
        kind: "agent",
        principalId: fixture.serviceId,
        projectId: fixture.projectId,
        projectName: "renew",
        certificateId: fixture.certificateId,
        serial: fixture.client.fingerprint.slice(0, 32),
        fingerprint: fixture.client.fingerprint,
        publicKeySha256: fixture.client.publicKeySha256,
        notAfter: clockNow + 5 * DAY,
      };
      const service = new (
        await import("../../src/agent/agent-renew-service.js")
      ).AgentRenewService({
        database: testDb.db,
        consumers: new ConsumerRepository(testDb.db),
        signer: server.runtime.caSigner,
        config: { certTtlDays: ttlDays },
        cache: new RenewalReplayCache({ now: clock }),
        now: clock,
      });
      const response = await service.renew(context, { csr: csr.csrPem, consumer });
      const certificate = new x509.X509Certificate(response.certificatePem);
      expect(certificate.notAfter.getTime() - certificate.notBefore.getTime()).toBe(ttlDays * DAY);
    }
  });

  it("should update consumer metadata and preserve first_seen on renewal", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -25,
      notAfterOffsetDays: 5,
    });
    const firstJoin = await testDb.db.executeQuery<{ first_seen: Date }>(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname,
          manifest_hash, state, first_seen, last_seen)
       VALUES
         (:id, :principalId, :projectId, 'payments', 'api', 'api-1', :manifestHash,
          'ok', now() - interval '1 hour', now() - interval '1 hour')
       RETURNING first_seen`,
      {
        id: id(),
        principalId: fixture.serviceId,
        projectId: fixture.projectId,
        manifestHash: consumer.manifestHash,
      },
    );
    const before = firstJoin.records[0]?.first_seen;
    const response = await renew(fixture, (await createAgentCsr()).csrPem, {
      body: { csr: "", consumer: { ...consumer, composeService: "worker" } },
    });
    expect(response.status).toBe(422);

    const csr = await createAgentCsr();
    const renewed = await renew(fixture, csr.csrPem, {
      body: { csr: csr.csrPem, consumer: { ...consumer, composeService: "worker" } },
    });
    expect(renewed.status).toBe(200);
    const rows = await consumerRows(fixture.serviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.first_seen.getTime()).toBe(before?.getTime());
    expect(rows[0]?.compose_service).toBe("worker");
    expect(rows[0]?.state).toBe("ok");
  });
});

describe("renewal rate limiting", () => {
  it("should reject the eleventh renewal for one principal with 429", async () => {
    const fixture = await createRenewalFixture({
      notBeforeOffsetDays: -1,
      notAfterOffsetDays: 29,
    });
    const limitedDatabase = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    const limitedServer = await startAgentTestServer({
      testDb,
      environment,
      ca,
      seedCa: false,
      database: limitedDatabase,
    });
    const limitedRenew = (csr: string): Promise<TestResponse> =>
      testRequest({
        method: "POST",
        port: limitedServer.handle.agentPort,
        path: "/v1/agent/renew",
        host: "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
        cert: fixture.client.certPem,
        key: fixture.client.keyPem,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csr, consumer }),
      });
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await limitedRenew("not a csr");
        expect(response.status).toBe(422);
      }
      const limited = await limitedRenew("not a csr");
      expect(limited.status).toBe(429);
    } finally {
      await limitedServer.stop();
    }
  }, 30_000);
});

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type AgentConsumer, agentCertificateResponseSchema } from "@openvault/api-contract";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentRuntimeCore } from "../../src/agent/agent-runtime.js";
import { x509 } from "../../src/security/x509.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  createAgentCsr,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { type TestRequestOptions, type TestResponse, testRequest } from "./helpers/https.js";
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

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntimeCore;
let actorId: string;
let nextId = 1_000;
let nextService = 1;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

async function insertProject(): Promise<string> {
  const projectId = id();
  const name = `proj-${nextService++}`;
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, :name)", {
    id: projectId,
    name,
  });
  return projectId;
}

async function insertService(projectId: string): Promise<string> {
  const serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', :name, :projectId)`,
    { id: serviceId, name: `svc-${nextService++}`, projectId },
  );
  return serviceId;
}

async function insertActor(): Promise<string> {
  const userId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id: userId, name: "Join Operator", email: `join-${userId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: userId },
  );
  return userId;
}

async function issueToken(serviceId: string, ttlSeconds?: number) {
  return runtime.identityRuntime.service.issueJoinToken(actorId, serviceId, ttlSeconds);
}

type SendOptions = Omit<TestRequestOptions, "port" | "host" | "ca" | "servername" | "body"> & {
  readonly body?: unknown;
};

function send(options: SendOptions): Promise<TestResponse> {
  const { body, ...requestOptions } = options;
  return testRequest({
    ...requestOptions,
    port: server.handle.agentPort,
    host: "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function joinBody(token: string, csr: string, metadata: AgentConsumer = consumer) {
  return { token, csr, consumer: metadata };
}

function errorCode(response: TestResponse): string {
  return errorEnvelope.parse(response.json).error.code;
}

async function join(token: string, csr: string, metadata: AgentConsumer = consumer) {
  return send({
    method: "POST",
    path: "/v1/agent/join",
    headers: { "content-type": "application/json" },
    body: joinBody(token, csr, metadata),
  });
}

async function certificateRows(principalId: string) {
  const result = await testDb.db.executeQuery<{
    id: string;
    serial: string;
    fingerprint: string;
    revoked_at: Date | null;
  }>("SELECT id, serial, fingerprint, revoked_at FROM workload_certs WHERE principal_id = :id", {
    id: principalId,
  });
  return result.records;
}

async function consumerRows(principalId: string) {
  const result = await testDb.db.executeQuery<{
    id: string;
    first_seen: Date;
    last_seen: Date;
    compose_service: string;
    state: string;
  }>(
    `SELECT id, first_seen, last_seen, compose_service, state
       FROM consumers WHERE principal_id = :id`,
    { id: principalId },
  );
  return result.records;
}

async function insertWorkloadCertificate(
  principalId: string,
  certificate: Awaited<ReturnType<typeof createAgentClientCertificate>>,
  dates: { readonly notBefore: Date; readonly notAfter: Date },
): Promise<string> {
  const certificateId = id();
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after)
     VALUES (:id, :principalId, :serial, :fingerprint, :notBefore, :notAfter)`,
    {
      id: certificateId,
      principalId,
      serial: certificate.fingerprint.slice(0, 32),
      fingerprint: certificate.fingerprint,
      notBefore: dates.notBefore,
      notAfter: dates.notAfter,
    },
  );
  return certificateId;
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
  actorId = await insertActor();
}, 60_000);

afterAll(async () => {
  if (server !== undefined) {
    await server.stop();
  }
  environment?.cleanup();
  ca?.cleanup();
  await testDb?.cleanup();
});

describe("join tokens", () => {
  it("should issue a default 15-minute token with only its 32-byte hash stored", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const issued = await issueToken(serviceId);
    expect(issued.token).toHaveLength(43);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await testDb.db.executeQuery<{
      token_hash: Buffer;
      created_at: Date;
      expires_at: Date;
      created_by: string;
    }>("SELECT token_hash, created_at, expires_at, created_by FROM join_tokens WHERE id = :id", {
      id: issued.id,
    });
    const token = row.records[0];
    expect(token?.token_hash).toHaveLength(32);
    expect(token?.token_hash.equals(createHash("sha256").update(issued.token).digest())).toBe(true);
    expect(token?.created_by).toBe(actorId);
    expect(
      Math.round(((token?.expires_at.getTime() ?? 0) - (token?.created_at.getTime() ?? 0)) / 1000),
    ).toBe(900);
    expect(token?.token_hash.toString("base64url")).not.toBe(issued.token);
  });

  it("should accept the exact 1 and 86,400 second TTL boundaries and reject others", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    for (const ttlSeconds of [1, 86_400]) {
      await expect(issueToken(serviceId, ttlSeconds)).resolves.toMatchObject({});
    }
    for (const ttlSeconds of [0, 86_401]) {
      await expect(issueToken(serviceId, ttlSeconds)).rejects.toMatchObject({
        code: "validation_error",
        statusCode: 422,
      });
    }
  });
});

describe("join", () => {
  it("should join with a valid token and create one certificate and one consumer", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();
    const response = await join(token.token, csr.csrPem);

    expect(response.status).toBe(200);
    const body = certificateEnvelope.parse(response.json).data;
    expect(body.identityId).toBe(serviceId);
    expect(body.chainPem).toBe(ca.certPem);
    expect(response.body).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain(token.token);

    const certificate = new x509.X509Certificate(body.certificatePem);
    expect(certificate.serialNumber.toLowerCase()).toBe(body.serial);
    expect(certificate.notAfter.toISOString()).toBe(body.notAfter);
    expect(certificate.subject).toBe(`CN=${serviceId}`);

    const tokenRow = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(tokenRow.records[0]?.used_at).not.toBeNull();

    const certificates = await certificateRows(serviceId);
    expect(certificates).toHaveLength(1);
    expect(certificates[0]?.serial).toBe(body.serial);
    expect(certificates[0]?.revoked_at).toBeNull();

    const consumers = await consumerRows(serviceId);
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toMatchObject({
      compose_service: "api",
      state: "ok",
    });
  });

  it("should allow exactly one of two concurrent joins with the same token", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();

    const responses = await Promise.all([
      join(token.token, csr.csrPem),
      join(token.token, csr.csrPem),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await certificateRows(serviceId)).toHaveLength(1);
    expect(await consumerRows(serviceId)).toHaveLength(1);
  });

  it("should return the same 401 for unknown, expired, used, and revoked tokens", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const csr = await createAgentCsr();
    const bodies: string[] = [];

    const unknown = await join("u".repeat(43), csr.csrPem);
    bodies.push(JSON.stringify(errorEnvelope.parse(unknown.json).error));
    expect(unknown.status).toBe(401);

    for (const mutate of [
      "UPDATE join_tokens SET expires_at = now() - interval '1 hour' WHERE id = :id",
      "UPDATE join_tokens SET used_at = now() WHERE id = :id",
      "UPDATE join_tokens SET revoked_at = now() WHERE id = :id",
    ]) {
      const token = await issueToken(serviceId);
      await testDb.db.executeQuery(mutate, { id: token.id });
      const response = await join(token.token, csr.csrPem);
      expect(response.status).toBe(401);
      bodies.push(JSON.stringify(errorEnvelope.parse(response.json).error));
    }

    expect(new Set(bodies).size).toBe(1);
    expect(await certificateRows(serviceId)).toHaveLength(0);
    expect(await consumerRows(serviceId)).toHaveLength(0);
  });

  it("should reject a disabled principal and a soft-deleted project without consuming the token", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();
    await testDb.db.executeQuery(
      "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
      { id: serviceId },
    );
    const disabled = await join(token.token, csr.csrPem);
    expect(disabled.status).toBe(401);
    expect(errorCode(disabled)).toBe("join_failed");
    expect(await certificateRows(serviceId)).toHaveLength(0);

    const otherProject = await insertProject();
    const otherService = await insertService(otherProject);
    const otherToken = await issueToken(otherService);
    await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
      id: otherProject,
    });
    const deleted = await join(otherToken.token, csr.csrPem);
    expect(deleted.status).toBe(401);
    expect(errorCode(deleted)).toBe("join_failed");
    expect(await certificateRows(otherService)).toHaveLength(0);

    const tokenState = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(tokenState.records[0]?.used_at).toBeNull();
  });

  it("should reject a malformed CSR without consuming the token", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const response = await join(token.token, "not a certificate request");
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("validation_error");
    expect(await certificateRows(serviceId)).toHaveLength(0);
    const tokenState = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(tokenState.records[0]?.used_at).toBeNull();
  });

  it("should preserve one consumer row and first_seen across two joins", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const firstToken = await issueToken(serviceId);
    const secondToken = await issueToken(serviceId);
    const firstCsr = await createAgentCsr();
    const secondCsr = await createAgentCsr();

    expect((await join(firstToken.token, firstCsr.csrPem)).status).toBe(200);
    const first = await consumerRows(serviceId);
    await delay(10);
    expect(
      (
        await join(secondToken.token, secondCsr.csrPem, {
          ...consumer,
          composeService: "worker",
          hostname: "api-2",
        })
      ).status,
    ).toBe(200);
    const second = await consumerRows(serviceId);

    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.first_seen.getTime()).toBe(first[0]?.first_seen.getTime());
    expect(second[0]?.compose_service).toBe("worker");
    expect(second[0]?.last_seen.getTime()).toBeGreaterThanOrEqual(
      first[0]?.last_seen.getTime() ?? 0,
    );
    expect(second[0]?.state).toBe("ok");
  });

  it("should reject unknown fields, ownership overrides, and invalid metadata", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();

    const invalidBodies = [
      { ...joinBody(token.token, csr.csrPem), extra: true },
      { ...joinBody(token.token, csr.csrPem), projectId },
      {
        ...joinBody(token.token, csr.csrPem),
        consumer: { ...consumer, assertedBy: "agent" },
      },
      {
        ...joinBody(token.token, csr.csrPem),
        consumer: { ...consumer, hostname: "bad/host" },
      },
      {
        ...joinBody(token.token, csr.csrPem),
        consumer: { ...consumer, hostname: "h".repeat(256) },
      },
    ];
    for (const body of invalidBodies) {
      const response = await send({
        method: "POST",
        path: "/v1/agent/join",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(422);
      expect(errorCode(response)).toBe("validation_error");
    }
    expect(await certificateRows(serviceId)).toHaveLength(0);
  });

  it("should join and revoke without leaving a live certificate", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();

    const [joined] = await Promise.allSettled([
      join(token.token, csr.csrPem),
      runtime.identityRuntime.service.revoke(actorId, serviceId),
    ]);
    expect(joined.status).toBe("fulfilled");
    const certificates = await certificateRows(serviceId);
    const consumers = await consumerRows(serviceId);
    if (joined.status === "fulfilled" && joined.value.status === 200) {
      expect(certificates.every((certificate) => certificate.revoked_at !== null)).toBe(true);
      expect(consumers.every((row) => row.state === "failed")).toBe(true);
    } else {
      expect(certificates).toHaveLength(0);
      expect(consumers).toHaveLength(0);
    }
  });
});

describe("agent listener authentication", () => {
  it("should allow join without a certificate but protect health", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();
    expect((await join(token.token, csr.csrPem)).status).toBe(200);

    const health = await send({ path: "/health" });
    expect(health.status).toBe(401);
    expect(errorCode(health)).toBe("authentication_required");
  });

  it("should reject untrusted and unknown-fingerprint certificates", async () => {
    const untrusted = await send({
      path: "/health",
      cert: environment.tls.wrongClientCertPem,
      key: environment.tls.wrongClientKeyPem,
    });
    expect(untrusted.status).toBe(401);
    expect(errorCode(untrusted)).toBe("authentication_required");

    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const unknown = await createAgentClientCertificate(ca, serviceId);
    const response = await send({
      path: "/health",
      cert: unknown.certPem,
      key: unknown.keyPem,
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("authentication_required");
  });

  it("should accept a live workload certificate on health", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const certificate = await createAgentClientCertificate(ca, serviceId);
    const now = Date.now();
    await insertWorkloadCertificate(serviceId, certificate, {
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 86_400_000),
    });

    const response = await send({
      path: "/health",
      cert: certificate.certPem,
      key: certificate.keyPem,
    });
    expect(response.status).toBe(200);
  });

  it("should reject revoked certificates, disabled principals, and deleted projects", async () => {
    for (const mutation of ["revoked", "disabled", "deleted"] as const) {
      const projectId = await insertProject();
      const serviceId = await insertService(projectId);
      const certificate = await createAgentClientCertificate(ca, serviceId);
      const now = Date.now();
      const certificateId = await insertWorkloadCertificate(serviceId, certificate, {
        notBefore: new Date(now - 3_600_000),
        notAfter: new Date(now + 86_400_000),
      });
      if (mutation === "revoked") {
        await testDb.db.executeQuery(
          "UPDATE workload_certs SET revoked_at = now() WHERE id = :id",
          { id: certificateId },
        );
      } else if (mutation === "disabled") {
        await testDb.db.executeQuery(
          "UPDATE principals SET status = 'disabled', disabled_at = now() WHERE id = :id",
          { id: serviceId },
        );
      } else {
        await testDb.db.executeQuery("UPDATE projects SET deleted_at = now() WHERE id = :id", {
          id: projectId,
        });
      }

      const response = await send({
        path: "/health",
        cert: certificate.certPem,
        key: certificate.keyPem,
      });
      expect(response.status, mutation).toBe(401);
      expect(errorCode(response)).toBe("authentication_required");
    }
  });

  it("should reject in-bound 42/44-character tokens and bound the envelope at 400", async () => {
    const csr = await createAgentCsr();
    for (const token of ["t".repeat(42), "t".repeat(44)]) {
      const response = await join(token, csr.csrPem);
      expect(response.status).toBe(401);
      expect(errorCode(response)).toBe("join_failed");
    }
    for (const token of ["", "t".repeat(129)]) {
      const response = await join(token, csr.csrPem);
      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe("validation_error");
    }
  });
});

describe("join failure handling", () => {
  it("should return 503 and leave the token unused when the CA signer is unavailable", async () => {
    const projectId = await insertProject();
    const serviceId = await insertService(projectId);
    const token = await issueToken(serviceId);
    const csr = await createAgentCsr();
    runtime.caSigner.destroy();

    const response = await join(token.token, csr.csrPem);
    expect(response.status).toBe(503);
    expect(errorCode(response)).toBe("ca_unavailable");
    expect(await certificateRows(serviceId)).toHaveLength(0);
    const tokenState = await testDb.db.executeQuery<{ used_at: Date | null }>(
      "SELECT used_at FROM join_tokens WHERE id = :id",
      { id: token.id },
    );
    expect(tokenState.records[0]?.used_at).toBeNull();
  });
});

describe("join rate limiting", () => {
  it("should reject the eleventh join from one source address with 429", async () => {
    const limitedDatabase = new PostgreSQLDatabase({
      ...environment.config.database,
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    const limited = await startAgentTestServer({
      testDb,
      environment,
      ca,
      seedCa: false,
      database: limitedDatabase,
    });
    try {
      const csr = await createAgentCsr();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await testRequest({
          method: "POST",
          port: limited.handle.agentPort,
          path: "/v1/agent/join",
          host: "127.0.0.1",
          ca: environment.tls.caPem,
          servername: "localhost",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(joinBody("z".repeat(43), csr.csrPem)),
        });
        expect(response.status).toBe(401);
      }
      const limitedResponse = await testRequest({
        method: "POST",
        port: limited.handle.agentPort,
        path: "/v1/agent/join",
        host: "127.0.0.1",
        ca: environment.tls.caPem,
        servername: "localhost",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(joinBody("z".repeat(43), csr.csrPem)),
      });
      expect(limitedResponse.status).toBe(429);
    } finally {
      await limited.stop();
    }
  }, 30_000);
});

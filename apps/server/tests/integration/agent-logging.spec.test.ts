import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../src/agent/agent-runtime.js";
import {
  type AgentTestServer,
  createAgentServerEnvironment,
  type ServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import {
  type AgentCaFixture,
  type AgentClientFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
  createAgentCsr,
} from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { MemoryDestination } from "./helpers/memory-destination.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let ca: AgentCaFixture;
let server: AgentTestServer;
let runtime: AgentRuntime;
let destination: MemoryDestination;
let actorId: string;
let projectId: string;
let serviceId: string;
let renewalServiceId: string;
let renewalClient: AgentClientFixture;
let token = "";
let csrBody = "";
let nextId = 9_000;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

const consumer = {
  composeProject: "payments",
  composeService: "api",
  hostname: "api-1",
  manifestHash: `sha256:${"a".repeat(64)}`,
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  ca = await createAgentCaFixture();
  environment = await createAgentServerEnvironment(ca, {
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_INTERNAL_CA: ca.certPath,
    OPENVAULT_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  });
  destination = new MemoryDestination();
  server = await startAgentTestServer({
    testDb,
    environment,
    ca,
    loggerDestination: destination,
    rateLimitOptions: { joinLimit: 1_000, renewPrincipalLimit: 1_000, renewIpLimit: 1_000 },
  });
  runtime = server.runtime;

  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id: actorId, name: "Log Operator", email: `log-${actorId.toLowerCase()}@example.test` },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: id(), principalId: actorId },
  );
  projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'logging')", {
    id: projectId,
  });
  serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'logging-service', :projectId)`,
    { id: serviceId, projectId },
  );
  renewalServiceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'logging-renewal', :projectId)`,
    { id: renewalServiceId, projectId },
  );
  renewalClient = await createAgentClientCertificate(ca, renewalServiceId);
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after)
     VALUES
       (:id, :principalId, :serial, :fingerprint, now() - interval '25 days',
        now() + interval '5 days')`,
    {
      id: id(),
      principalId: renewalServiceId,
      serial: renewalClient.fingerprint.slice(0, 32),
      fingerprint: renewalClient.fingerprint,
    },
  );
  token = (await runtime.identityRuntime.service.issueJoinToken(actorId, serviceId, 900)).token;
  csrBody = (await createAgentCsr()).csrPem;
}, 60_000);

afterAll(async () => {
  if (server !== undefined) {
    await server.stop();
  }
  environment?.cleanup();
  ca?.cleanup();
  await testDb?.cleanup();
});

function join(body: unknown) {
  return testRequest({
    method: "POST",
    port: server.handle.agentPort,
    path: "/v1/agent/join",
    host: "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agent log redaction", () => {
  it("should log stable outcomes without tokens, CSRs, or key material", async () => {
    expect((await join({ token, csr: csrBody, consumer })).status).toBe(200);
    const used = await join({ token, csr: csrBody, consumer });
    expect(used.status).toBe(401);

    const expiredToken = await runtime.identityRuntime.service.issueJoinToken(
      actorId,
      serviceId,
      900,
    );
    await testDb.db.executeQuery(
      "UPDATE join_tokens SET expires_at = now() - interval '1 hour' WHERE id = :id",
      { id: expiredToken.id },
    );
    expect((await join({ token: expiredToken.token, csr: csrBody, consumer })).status).toBe(401);

    const revokedToken = await runtime.identityRuntime.service.issueJoinToken(
      actorId,
      serviceId,
      900,
    );
    await testDb.db.executeQuery("UPDATE join_tokens SET revoked_at = now() WHERE id = :id", {
      id: revokedToken.id,
    });
    expect((await join({ token: revokedToken.token, csr: csrBody, consumer })).status).toBe(401);

    const malformed = await join({
      token: "z".repeat(43),
      csr: "not a certificate request",
      consumer,
    });
    expect(malformed.status).toBe(422);
    const error = (malformed.json as { error: Record<string, unknown> }).error;
    for (const key of Object.keys(error)) {
      expect(["code", "message", "statusCode", "timestamp", "requestId", "path"]).toContain(key);
    }
    expect(error.code).toBe("validation_error");

    const renewal = await testRequest({
      method: "POST",
      port: server.handle.agentPort,
      path: "/v1/agent/renew",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
      cert: renewalClient.certPem,
      key: renewalClient.keyPem,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csr: (await createAgentCsr()).csrPem, consumer }),
    });
    expect(renewal.status).toBe(200);
    await runtime.identityRuntime.service.revoke(actorId, renewalServiceId);
    const revokedCertificate = await testRequest({
      port: server.handle.agentPort,
      path: "/health",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
      cert: renewalClient.certPem,
      key: renewalClient.keyPem,
    });
    expect(revokedCertificate.status).toBe(401);
    await runtime.identityRuntime.service.revoke(actorId, serviceId);

    const unauthorized = await testRequest({
      port: server.handle.agentPort,
      path: "/health",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
    });
    expect(unauthorized.status).toBe(401);

    const logs = destination.lines().join("\n");
    const tokenHashes = await testDb.db.executeQuery<{ token_hash: Buffer }>(
      "SELECT token_hash FROM join_tokens",
    );
    const wrapped = await testDb.db.executeQuery<{
      wrapped_key: Buffer;
      wrap_nonce: Buffer;
      wrap_tag: Buffer;
    }>("SELECT wrapped_key, wrap_nonce, wrap_tag FROM ca_keys LIMIT 1");
    const wrappedRow = wrapped.records[0];

    const forbidden: readonly (readonly [string, string])[] = [
      ["raw join token", token],
      ["expired token", expiredToken.token],
      ["revoked token", revokedToken.token],
      ["CSR body", csrBody.split("\n")[1] ?? ""],
      ["CA private key body", ca.keyPem.split("\n")[1] ?? ""],
      ["CA scalar", ca.scalar.toString("hex")],
      ["private-key marker", "PRIVATE KEY"],
      ["CSR marker", "BEGIN CERTIFICATE REQUEST"],
      ["token hash hex", createHash("sha256").update(token).digest("hex")],
      ["wrapped key hex", wrappedRow?.wrapped_key.toString("hex") ?? ""],
      ["wrapped key JSON", JSON.stringify(wrappedRow?.wrapped_key)],
      ["nonce JSON", JSON.stringify(wrappedRow?.wrap_nonce)],
      ["tag JSON", JSON.stringify(wrappedRow?.wrap_tag)],
      ...tokenHashes.records.map(
        (row, index) => [`token hash ${index} JSON`, JSON.stringify(row.token_hash)] as const,
      ),
      ...tokenHashes.records.map(
        (row, index) => [`token hash ${index} base64`, row.token_hash.toString("base64")] as const,
      ),
    ];
    for (const [label, value] of forbidden) {
      if (value.length > 0) {
        expect(logs, label).not.toContain(value);
      }
    }
    expect(logs).toContain("/v1/agent/join");
    expect(logs).toContain("/v1/agent/renew");
    expect(logs).toContain('"statusCode":200');
    expect(logs).toContain('"statusCode":401');
    expect(logs).toContain('"statusCode":422');
  }, 30_000);
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../src/agent/agent-runtime.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import { type AgentCaFixture, createAgentCaFixture, createAgentCsr } from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { MemoryDestination } from "./helpers/memory-destination.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
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
let token = "";
let csrBody = "";
let nextId = 9_000;

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
    const consumer = {
      composeProject: "payments",
      composeService: "api",
      hostname: "api-1",
      manifestHash: `sha256:${"a".repeat(64)}`,
    };
    expect((await join({ token, csr: csrBody, consumer })).status).toBe(200);
    expect(
      (
        await join({
          token: "z".repeat(43),
          csr: "not a certificate request",
          consumer,
        })
      ).status,
    ).toBe(422);

    const unauthorized = await testRequest({
      port: server.handle.agentPort,
      path: "/health",
      host: "127.0.0.1",
      ca: environment.tls.caPem,
      servername: "localhost",
    });
    expect(unauthorized.status).toBe(401);

    await runtime.identityRuntime.service.revoke(actorId, serviceId);

    const logs = destination.lines().join("\n");
    const wrapped = await testDb.db.executeQuery<{ wrapped_key: Buffer }>(
      "SELECT wrapped_key FROM ca_keys LIMIT 1",
    );
    const wrappedKey = wrapped.records[0]?.wrapped_key.toString("hex") ?? "";
    for (const forbidden of [
      token,
      csrBody.split("\n")[1] ?? "",
      ca.keyPem.split("\n")[1] ?? "",
      "PRIVATE KEY",
      "BEGIN CERTIFICATE REQUEST",
      createHash("sha256").update(token).digest("hex"),
      wrappedKey,
    ]) {
      if (forbidden.length > 0) {
        expect(logs, forbidden).not.toContain(forbidden);
      }
    }
    expect(logs).toContain("/v1/agent/join");
    expect(logs).toContain('"statusCode":200');
    expect(logs).toContain('"statusCode":422');
  }, 30_000);
});

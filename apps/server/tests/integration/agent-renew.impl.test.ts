import type { AgentConsumer } from "@openvault/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentAuthContext } from "../../src/agent/types.js";
import { type AgentTestServer, startAgentTestServer } from "./helpers/agent-app.js";
import { type AgentCaFixture, createAgentCaFixture, createAgentCsr } from "./helpers/agent-tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
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

import type { AgentConsumer } from "@openvault/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentServiceError } from "../../src/agent/errors.js";
import {
  type AgentTestServer,
  createAgentServerEnvironment,
  startAgentTestServer,
} from "./helpers/agent-app.js";
import { createAgentCaFixture, createAgentCsr } from "./helpers/agent-tls.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import type { ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let server: AgentTestServer;
let base: BaseFixture;
let actors: AuditActors;

const consumer: AgentConsumer = {
  composeProject: "compose",
  composeService: "api",
  hostname: "agent-1",
  manifestHash: `sha256:${"a".repeat(64)}`,
};

async function joinEvents(): Promise<
  readonly { result: string; actor_kind: string; details: Record<string, unknown> }[]
> {
  const rows = await testDb.db.executeQuery<{
    result: string;
    actor_kind: string;
    details: Record<string, unknown>;
  }>(
    "SELECT result, actor_kind, details FROM audit_events WHERE action = 'agent.join' ORDER BY id ASC",
  );
  return rows.records;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  const ca = await createAgentCaFixture();
  environment = await createAgentServerEnvironment(ca, {
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_INTERNAL_CA: ca.certPath,
  });
  server = await startAgentTestServer({ testDb, environment, ca });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
  await testDb.db.executeQuery("DELETE FROM consumers");
});

describe("agent audit emitters", () => {
  it("should record one join allow and one consumer register", async () => {
    const token = await server.runtime.identityRuntime.service.issueJoinToken(
      actors.orgAdmin,
      base.serviceId,
      undefined,
      { requestId: "token-1" },
    );
    const csr = await createAgentCsr();
    const response = await server.runtime.joinService.join(
      { token: token.token, csr: csr.csrPem, consumer },
      { requestId: "join-1" },
    );
    expect(response.identityId).toBe(base.serviceId);

    const joins = await joinEvents();
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      result: "allow",
      actor_kind: "service",
      details: { certificateSerial: response.serial },
    });
    const consumers = await testDb.db.executeQuery<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_events WHERE action = 'consumer.register'",
    );
    expect(consumers.records).toHaveLength(1);
    expect(consumers.records[0]?.details).toMatchObject({ consumerId: expect.any(String) });
    const auditRows = await testDb.db.executeQuery<Record<string, unknown>>(
      "SELECT event_id, request_id, actor_id, action, details, user_agent FROM audit_events",
    );
    expect(JSON.stringify(auditRows.records)).not.toContain(token.token);
  });

  it("should record a system deny for an unknown token", async () => {
    const csr = await createAgentCsr();
    await expect(
      server.runtime.joinService.join(
        { token: "x".repeat(43), csr: csr.csrPem, consumer },
        { requestId: "join-unknown" },
      ),
    ).rejects.toBeInstanceOf(AgentServiceError);

    const joins = await joinEvents();
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      result: "deny",
      actor_kind: "system",
      details: { reason: "join_token_unknown" },
    });
  });

  it("should record a consumer update only when metadata changes", async () => {
    const issue = async (): Promise<string> =>
      (
        await server.runtime.identityRuntime.service.issueJoinToken(
          actors.orgAdmin,
          base.serviceId,
          undefined,
          { requestId: "token-2" },
        )
      ).token;

    const firstCsr = await createAgentCsr();
    await server.runtime.joinService.join(
      { token: await issue(), csr: firstCsr.csrPem, consumer },
      { requestId: "join-2" },
    );
    const secondCsr = await createAgentCsr();
    await server.runtime.joinService.join(
      {
        token: await issue(),
        csr: secondCsr.csrPem,
        consumer: { ...consumer, composeService: "worker" },
      },
      { requestId: "join-3" },
    );
    const thirdCsr = await createAgentCsr();
    await server.runtime.joinService.join(
      {
        token: await issue(),
        csr: thirdCsr.csrPem,
        consumer: { ...consumer, composeService: "worker" },
      },
      { requestId: "join-4" },
    );

    const updates = await testDb.db.executeQuery<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_events WHERE action = 'consumer.update'",
    );
    expect(updates.records).toHaveLength(1);
    expect(updates.records[0]?.details.changed).toEqual(["composeService"]);
    const registers = await testDb.db.executeQuery(
      "SELECT 1 FROM audit_events WHERE action = 'consumer.register'",
    );
    expect(registers.records).toHaveLength(1);
  }, 60_000);
});

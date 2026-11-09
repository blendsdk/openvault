import { createHmac } from "node:crypto";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { SecretRepository } from "../../../src/secrets/repository.js";
import { SecretRotationRepository } from "../../../src/secrets/rotation/repository.js";
import { SecretRotationScheduler } from "../../../src/secrets/rotation/scheduler.js";
import {
  type RotationLogger,
  type RotationRunSummary,
  SecretRotationService,
} from "../../../src/secrets/rotation/service.js";
import { SecretRotationWebhook } from "../../../src/secrets/rotation/webhook.js";
import { SecretService } from "../../../src/secrets/service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import { createServerEnvironment } from "../helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";
import { startTestWebhook, type TestWebhook } from "../helpers/webhook.js";
import { createSecretAt, replaceVersionAt, setRotationPolicy } from "./rotation-helpers.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const logger: RotationLogger = {
  info: async () => undefined,
  error: async () => undefined,
};

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
let webhookServer: TestWebhook;

function secretName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

function rotationService(webhook?: SecretRotationWebhook): SecretRotationService {
  return new SecretRotationService({
    database: testDb.db,
    repository: new SecretRotationRepository(),
    ...(webhook === undefined ? {} : { webhook }),
    audit: createAuditCore({ database: testDb.db, keyring, now: () => NOW }).writer,
    logger,
    warningDays: 7,
    now: () => NOW,
  });
}

async function createAt(
  name: string,
  createdAt: string,
  intervalDays: number,
): Promise<{ readonly dueAt: string }> {
  await createSecretAt(
    testDb.db,
    secrets,
    actors.orgAdmin,
    "foundation",
    name,
    createdAt,
    base.userId,
  );
  await setRotationPolicy(secrets, actors.orgAdmin, "foundation", name, intervalDays);
  const dueAt = new Date(Date.parse(createdAt) + intervalDays * DAY).toISOString();
  return { dueAt };
}

function payloadOf(index: number): Record<string, unknown> {
  return JSON.parse(webhookServer.requests[index]?.body ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring, now: () => NOW });
  const policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
    now: () => NOW,
  });
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
    rotationWarningDays: 7,
    now: () => NOW,
  });
  webhookServer = await startTestWebhook();
}, 60_000);

afterAll(async () => {
  await webhookServer?.close();
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
  webhookServer.requests.length = 0;
  webhookServer.setStatus(200);
});

describe("secret rotation notifications", () => {
  it("should send one due-soon and one overdue warning with the correct payload", async () => {
    const dueSoonName = secretName("due-soon");
    const overdueName = secretName("overdue");
    const dueSoon = await createAt(dueSoonName, "2026-10-10T12:00:00.000Z", 30);
    const overdue = await createAt(overdueName, "2026-10-01T12:00:00.000Z", 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));

    const summary = await service.runOnce();
    expect(summary.sent).toBe(2);
    expect(webhookServer.requests).toHaveLength(2);
    const payloads = [payloadOf(0), payloadOf(1)];
    const dueSoonPayload = payloads.find((payload) => payload.name === dueSoonName);
    const overduePayload = payloads.find((payload) => payload.name === overdueName);
    expect(dueSoonPayload).toMatchObject({
      event: "secret.rotation_warning",
      status: "due_soon",
      dueAt: dueSoon.dueAt,
      daysUntilDue: 5,
      name: dueSoonName,
      versionId: expect.any(String),
    });
    expect(overduePayload).toMatchObject({
      event: "secret.rotation_warning",
      status: "overdue",
      dueAt: overdue.dueAt,
      daysUntilDue: -4,
      name: overdueName,
    });
    expect(JSON.stringify(payloads)).not.toContain("rotation-value");
  });

  it("should not send the same warning twice", async () => {
    await createAt(secretName("dedupe"), "2026-10-10T12:00:00.000Z", 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));
    const first = await service.runOnce();
    const second = await service.runOnce();
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(webhookServer.requests).toHaveLength(1);
  });

  it("should allow a new warning when a policy change moves the due date", async () => {
    const name = secretName("policy-change");
    await createAt(name, "2026-10-10T12:00:00.000Z", 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));
    await service.runOnce();
    expect(webhookServer.requests).toHaveLength(1);
    await setRotationPolicy(secrets, actors.orgAdmin, "foundation", name, 20);
    await service.runOnce();
    expect(webhookServer.requests).toHaveLength(2);
    expect(payloadOf(1).status).toBe("overdue");
  });

  it("should retry a failed delivery and audit the failure", async () => {
    await createAt(secretName("retry"), "2026-10-10T12:00:00.000Z", 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));
    webhookServer.setStatus(500);
    const first = await service.runOnce();
    expect(first.failed).toBe(1);
    webhookServer.setStatus(200);
    const second = await service.runOnce();
    expect(second.sent).toBe(1);
    const events = await testDb.db.executeQuery<{ result: string }>(
      "SELECT result FROM audit_events WHERE action = 'secret.rotation_warning' ORDER BY id ASC",
    );
    expect(events.records.map((event) => event.result)).toEqual(["error", "allow"]);
  });

  it("should audit a skipped delivery when no webhook is configured", async () => {
    await createAt(secretName("no-webhook"), "2026-10-10T12:00:00.000Z", 30);
    const summary = await rotationService().runOnce();
    expect(summary.sent).toBe(1);
    const event = await testDb.db.executeQuery<{ details: { webhook?: string } }>(
      "SELECT details FROM audit_events WHERE action = 'secret.rotation_warning'",
    );
    expect(event.records[0]?.details.webhook).toBe("skipped");
  });

  it("should sign the timestamped body and keep values out", async () => {
    await createAt(secretName("signed"), "2026-10-10T12:00:00.000Z", 30);
    const secret = "rotation-webhook-secret-1234";
    const service = rotationService(
      new SecretRotationWebhook({ url: new URL(webhookServer.url), secret }),
    );
    await service.runOnce();
    const request = webhookServer.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      return;
    }
    const timestamp = request.headers["x-openvault-timestamp"];
    expect(typeof timestamp).toBe("string");
    const expected = `sha256=${createHmac("sha256", secret)
      .update(`${String(timestamp)}.${request.body}`, "utf8")
      .digest("hex")}`;
    expect(request.headers["x-openvault-signature"]).toBe(expected);
    expect(request.body).not.toContain("rotation-value");
  });

  it("should write the warning audit details without a value", async () => {
    const name = secretName("audit");
    await createAt(name, "2026-10-10T12:00:00.000Z", 30);
    await rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) })).runOnce();
    const event = await testDb.db.executeQuery<{
      action: string;
      result: string;
      details: Record<string, unknown>;
    }>("SELECT action, result, details FROM audit_events WHERE action = 'secret.rotation_warning'");
    expect(event.records[0]?.result).toBe("allow");
    expect(event.records[0]?.details).toMatchObject({
      status: "due_soon",
      daysUntilDue: 5,
      webhook: "sent",
    });
    expect(JSON.stringify(event.records[0]?.details)).not.toContain("rotation-value");
  });

  it("should send once when two scans run concurrently", async () => {
    await createAt(secretName("concurrent"), "2026-10-10T12:00:00.000Z", 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));
    await Promise.all([service.runOnce(), service.runOnce()]);
    expect(webhookServer.requests).toHaveLength(1);
  });

  it("should reclaim a stale claim", async () => {
    const name = secretName("stale");
    const { dueAt } = await createAt(name, "2026-10-10T12:00:00.000Z", 30);
    const secret = await testDb.db.executeQuery<{ id: string; current_version_id: string }>(
      "SELECT id, current_version_id FROM secrets WHERE name = :name",
      { name },
    );
    await testDb.db.executeQuery(
      `INSERT INTO secret_rotation_notifications
         (id, secret_id, project_id, version_id, status, due_at, days_until_due,
          audit_event_id, claimed_at)
       VALUES
         (:id, :secretId, :projectId, :versionId, 'due_soon', :dueAt, 5,
          :auditEventId, :claimedAt)`,
      {
        id: newUlid(),
        secretId: secret.records[0]?.id,
        projectId: base.projectId,
        versionId: secret.records[0]?.current_version_id,
        dueAt,
        auditEventId: newUlid(),
        claimedAt: new Date(NOW - 2 * 60 * 60_000),
      },
    );
    const summary = await rotationService(
      new SecretRotationWebhook({ url: new URL(webhookServer.url) }),
    ).runOnce();
    expect(summary.sent).toBe(1);
  });

  it("should skip a secret whose policy was cleared or whose version changed", async () => {
    const cleared = secretName("cleared");
    const newVersion = secretName("new-version");
    await createAt(cleared, "2026-10-10T12:00:00.000Z", 30);
    await createAt(newVersion, "2026-10-10T12:00:00.000Z", 30);
    await setRotationPolicy(secrets, actors.orgAdmin, "foundation", cleared, null);
    await replaceVersionAt(testDb.db, newVersion, "2026-11-04T12:00:00.000Z", base.userId);
    const summary = await rotationService(
      new SecretRotationWebhook({ url: new URL(webhookServer.url) }),
    ).runOnce();
    expect(summary.sent).toBe(0);
    expect(webhookServer.requests).toHaveLength(0);
  });

  it("should compute daysUntilDue at the due boundary", async () => {
    const before = secretName("before-due");
    const atDue = secretName("at-due");
    const after = secretName("after-due");
    await createAt(before, new Date(NOW - 30 * DAY + 1).toISOString(), 30);
    await createAt(atDue, new Date(NOW - 30 * DAY).toISOString(), 30);
    await createAt(after, new Date(NOW - 30 * DAY - 1).toISOString(), 30);
    const service = rotationService(new SecretRotationWebhook({ url: new URL(webhookServer.url) }));
    await service.runOnce();
    const payloads = webhookServer.requests.map(
      (request) =>
        JSON.parse(request.body) as {
          readonly name: string;
          readonly status: string;
          readonly daysUntilDue: number;
        },
    );
    const byName = new Map(payloads.map((payload) => [payload.name, payload]));
    expect(byName.get(before)).toMatchObject({ status: "due_soon", daysUntilDue: 1 });
    expect(byName.get(atDue)).toMatchObject({ status: "overdue", daysUntilDue: 0 });
    expect(byName.get(after)).toMatchObject({ status: "overdue", daysUntilDue: -1 });
  });

  it("should isolate a rejected scan and still schedule the next run", async () => {
    const errors: string[] = [];
    class FailingRotationService extends SecretRotationService {
      public override async runOnce(): Promise<RotationRunSummary> {
        throw new Error("scan failed");
      }
    }
    const scheduler = new SecretRotationScheduler({
      service: new FailingRotationService({
        database: testDb.db,
        repository: new SecretRotationRepository(),
        audit: createAuditCore({ database: testDb.db, keyring, now: () => NOW }).writer,
        logger,
        warningDays: 7,
        now: () => Date.UTC(2026, 10, 4, 1, 0, 0),
      }),
      hour: 0,
      logger: {
        info: async () => undefined,
        error: async (message) => {
          errors.push(message);
        },
      },
      now: () => Date.UTC(2026, 10, 4, 1, 0, 0),
    });
    await scheduler.start();
    expect(errors).toContain("secret rotation scan failed");
    await scheduler.stop();
  });
});

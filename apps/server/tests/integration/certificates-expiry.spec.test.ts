import { createHmac } from "node:crypto";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateExpiryRepository } from "../../src/certificates/expiry/repository.js";
import { CertificateExpiryScheduler } from "../../src/certificates/expiry/scheduler.js";
import {
  CertificateExpiryService,
  type ExpiryLogger,
  type ExpiryRunSummary,
  thresholdFor,
} from "../../src/certificates/expiry/service.js";
import { CertificateExpiryWebhook } from "../../src/certificates/expiry/webhook.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createExpiredFixture, createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";
import { startTestWebhook, type TestWebhook } from "./helpers/webhook.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const logger: ExpiryLogger = {
  info: async () => undefined,
  error: async () => undefined,
};

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let service: CertificateService;
let webhookServer: TestWebhook;

function certificateName(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

function expiryService(webhook?: CertificateExpiryWebhook): CertificateExpiryService {
  return new CertificateExpiryService({
    database: testDb.db,
    repository: new CertificateExpiryRepository(),
    ...(webhook === undefined ? {} : { webhook }),
    audit: createAuditCore({ database: testDb.db, keyring, now: () => NOW }).writer,
    logger,
    now: () => NOW,
  });
}

async function importAt(
  name: string,
  offsetDays: number,
): Promise<{ id: string; versionId: string }> {
  const fixture = await createSelfSignedFixture({
    now: NOW,
    notBefore: new Date(NOW - DAY),
    notAfter: new Date(NOW + offsetDays * DAY),
  });
  const created = await service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
  return { id: created.response.id, versionId: created.response.version.id };
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
  service = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new CertificateRepository(),
    certMaxBytes: 131_072,
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

describe("certificate expiry", () => {
  it("should fire 30, 14, and 7-day warnings once per threshold", async () => {
    await importAt(certificateName("thirty"), 30);
    await importAt(certificateName("fourteen"), 14);
    await importAt(certificateName("seven"), 7);
    const webhook = new CertificateExpiryWebhook({ url: new URL(webhookServer.url) });
    const expiry = expiryService(webhook);
    const first = await expiry.runOnce();
    expect(first.sent).toBe(3);
    expect(webhookServer.requests).toHaveLength(3);
    const thresholds = webhookServer.requests
      .map((request) => (JSON.parse(request.body) as { thresholdDays: number }).thresholdDays)
      .sort((left, right) => left - right);
    expect(thresholds).toEqual([7, 14, 30]);
    const events = await testDb.db.executeQuery<{ result: string; details: unknown }>(
      "SELECT result, details FROM audit_events WHERE action = 'certificate.expiry_warning'",
    );
    expect(events.records).toHaveLength(3);
    expect(events.records.every((event) => event.result === "allow")).toBe(true);
    expect(
      events.records.every(
        (event) => typeof (event.details as { version?: string }).version === "string",
      ),
    ).toBe(true);
    const second = await expiry.runOnce();
    expect(second.sent).toBe(0);
    expect(webhookServer.requests).toHaveLength(3);
  });

  it("should send only the 14-day warning for a certificate ending in 10 days", async () => {
    await importAt(certificateName("ten"), 10);
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    const summary = await expiry.runOnce();
    expect(summary.sent).toBe(1);
    expect(
      (JSON.parse(webhookServer.requests[0]?.body ?? "{}") as { thresholdDays: number })
        .thresholdDays,
    ).toBe(14);
  });

  it("should retry after a webhook failure", async () => {
    await importAt(certificateName("retry"), 7);
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    webhookServer.setStatus(500);
    const first = await expiry.runOnce();
    expect(first.failed).toBe(1);
    expect(webhookServer.requests).toHaveLength(1);
    webhookServer.setStatus(200);
    const second = await expiry.runOnce();
    expect(second.sent).toBe(1);
    expect(webhookServer.requests).toHaveLength(2);
    const events = await testDb.db.executeQuery<{ result: string }>(
      "SELECT result FROM audit_events WHERE action = 'certificate.expiry_warning' ORDER BY id ASC",
    );
    expect(events.records.map((event) => event.result)).toEqual(["error", "allow"]);
  });

  it("should sign the timestamped body and keep secrets out of the payload", async () => {
    await importAt(certificateName("signed"), 7);
    const secret = "test-webhook-secret-1234";
    const expiry = expiryService(
      new CertificateExpiryWebhook({ url: new URL(webhookServer.url), secret }),
    );
    await expiry.runOnce();
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
    expect(request.body).not.toContain("BEGIN CERTIFICATE");
    expect(request.body).not.toContain("BEGIN PRIVATE KEY");
  });

  it("should audit skipped delivery when no webhook is configured", async () => {
    await importAt(certificateName("no-webhook"), 7);
    const summary = await expiryService().runOnce();
    expect(summary.sent).toBe(1);
    const event = await testDb.db.executeQuery<{ details: { webhook?: string } }>(
      "SELECT details FROM audit_events WHERE action = 'certificate.expiry_warning'",
    );
    expect(event.records[0]?.details.webhook).toBe("skipped");
  });

  it("should skip deleted, expired, and non-current certificates", async () => {
    const deleted = await importAt(certificateName("deleted"), 7);
    await testDb.db.executeQuery("UPDATE certificates SET deleted_at = now() WHERE id = :id", {
      id: deleted.id,
    });
    const expiredFixture = await createExpiredFixture(NOW);
    await service.import(actors.orgAdmin, "foundation", {
      name: certificateName("expired"),
      certificatePem: expiredFixture.certificatePem,
      privateKeyPem: expiredFixture.privateKeyPem,
    });
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    const summary = await expiry.runOnce();
    expect(summary.sent).toBe(0);
    expect(webhookServer.requests).toHaveLength(0);
  });

  it("should not warn for a superseded version", async () => {
    const name = certificateName("superseded");
    await importAt(name, 7);
    const renewal = await createSelfSignedFixture({
      now: NOW,
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 60 * DAY),
    });
    await service.import(actors.orgAdmin, "foundation", {
      name,
      certificatePem: renewal.certificatePem,
      privateKeyPem: renewal.privateKeyPem,
    });
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    const summary = await expiry.runOnce();
    expect(summary.sent).toBe(0);
    expect(webhookServer.requests).toHaveLength(0);
  });

  it("should send once when two scans run concurrently", async () => {
    await importAt(certificateName("concurrent"), 7);
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    await Promise.all([expiry.runOnce(), expiry.runOnce()]);
    expect(webhookServer.requests).toHaveLength(1);
  });

  it("should reclaim a stale pending claim", async () => {
    const created = await importAt(certificateName("stale"), 7);
    await testDb.db.executeQuery(
      `INSERT INTO certificate_expiry_notifications
         (certificate_id, version_id, threshold_days, days_to_expiry, status,
          audit_event_id, claimed_at)
       VALUES (:certificateId, :versionId, 7, 7, 'pending', :auditEventId, :claimedAt)`,
      {
        certificateId: created.id,
        versionId: created.versionId,
        auditEventId: newUlid(),
        claimedAt: new Date(NOW - 2 * 60 * 60_000),
      },
    );
    const expiry = expiryService(new CertificateExpiryWebhook({ url: new URL(webhookServer.url) }));
    const summary = await expiry.runOnce();
    expect(summary.sent).toBe(1);
    expect(webhookServer.requests).toHaveLength(1);
  });

  it("should isolate a rejected scan and still schedule the next run", async () => {
    const errors: string[] = [];
    class FailingExpiryService extends CertificateExpiryService {
      public override async runOnce(): Promise<ExpiryRunSummary> {
        throw new Error("scan failed");
      }
    }
    const scheduler = new CertificateExpiryScheduler({
      service: new FailingExpiryService({
        database: testDb.db,
        repository: new CertificateExpiryRepository(),
        audit: createAuditCore({ database: testDb.db, keyring, now: () => NOW }).writer,
        logger,
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
    expect(errors).toContain("certificate expiry scan failed");
    await scheduler.stop();
  });

  it("should select thresholds from raw milliseconds and calculate the next UTC run", () => {
    expect(thresholdFor(30 * DAY + 1)).toBeUndefined();
    expect(thresholdFor(30 * DAY)).toBe(30);
    expect(thresholdFor(14 * DAY + 1)).toBe(30);
    expect(thresholdFor(14 * DAY)).toBe(14);
    expect(thresholdFor(7 * DAY + 1)).toBe(14);
    expect(thresholdFor(7 * DAY)).toBe(7);
    const scheduler = new CertificateExpiryScheduler({
      service: expiryService(),
      hour: 3,
      logger,
      now: () => NOW,
    });
    expect(scheduler.nextRunAt(Date.UTC(2026, 10, 4, 2, 0, 0)).toISOString()).toBe(
      "2026-11-04T03:00:00.000Z",
    );
    expect(scheduler.nextRunAt(Date.UTC(2026, 10, 4, 4, 0, 0)).toISOString()).toBe(
      "2026-11-05T03:00:00.000Z",
    );
  });
});

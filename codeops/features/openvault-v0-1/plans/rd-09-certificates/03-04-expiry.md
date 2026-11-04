# Expiry: RD-09 Certificates

> **Document**: 03-04-expiry.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the daily certificate-expiry scan, the durable notification claim, the
optional webhook, and the expiry audit event.

**Governing decisions:** AR-16, AR-17, AR-18, AR-19, AR-20, AR-21, AR-26, AR-30, AR-34.

## Architecture

### Current Architecture

`certificate_versions.not_after` stores the leaf expiry. There is no scheduler, no notification
table, no webhook client, and no expiry audit action. The audit writer and chain lock are
complete.

### Proposed Changes

Add one additive table, one expiry repository, one scheduler, one webhook sender, one expiry
service, and the `certificate.expiry_warning` business action. Add the expiry hour and webhook
settings to the configuration.

## Implementation Details

### Schema

Add to `apps/server/src/database/schema.ts`:

```ts
const certificateExpiryNotifications = db.table("certificate_expiry_notifications");
certificateExpiryNotifications.bigserial("id");
certificateExpiryNotifications.text("certificate_id");
certificateExpiryNotifications.text("version_id");
certificateExpiryNotifications.integer("threshold_days").check("threshold_days IN (7, 14, 30)");
certificateExpiryNotifications
  .integer("days_to_expiry")
  .check("days_to_expiry BETWEEN 0 AND 30");
certificateExpiryNotifications
  .text("status")
  .default("pending", true)
  .check("status IN ('pending', 'sent')");
certificateExpiryNotifications.text("audit_event_id").check(ulidExpression("audit_event_id"));
certificateExpiryNotifications.timestamptz("created_at").default("now()");
certificateExpiryNotifications.timestamptz("claimed_at").default("now()");
certificateExpiryNotifications.timestamptz("sent_at").nullable();
certificateExpiryNotifications.primaryKey().column("id");
certificateExpiryNotifications
  .uniqueConstraint()
  .column("version_id", "threshold_days");
certificateExpiryNotifications.uniqueConstraint().column("audit_event_id");
certificateExpiryNotifications
  .index()
  .column("certificate_id")
  .indexName("certificate_expiry_notifications_certificate_idx");
certificateExpiryNotifications
  .index()
  .column("status", "created_at")
  .indexName("certificate_expiry_notifications_status_idx");

certificateVersions
  .index()
  .column("not_after")
  .indexName("certificate_versions_not_after_idx");
```

Foreign keys:

```ts
certificateExpiryNotifications
  .foreignKeyConstraint(certificates)
  .from("certificate_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
certificateExpiryNotifications
  .foreignKeyConstraint(certificateVersions)
  .from("certificate_id", "version_id")
  .to("certificate_id", "id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
```

The migration is generated from this declaration with the BlendSDK migration generator. It is
additive: one table, five indexes (two unique and three lookup, including the `not_after`
index used by the scan), a composite certificate/version foreign key plus a certificate
foreign key, and their checks.
No existing row changes.

### Expiry Repository

```ts
export interface ExpiringCertificate {
  readonly certificateId: string;
  readonly projectId: string;
  readonly name: string;
  readonly versionId: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
}

export interface NotificationClaim {
  readonly id: string;
  readonly certificateId: string;
  readonly versionId: string;
  readonly thresholdDays: 7 | 14 | 30;
  readonly daysToExpiry: number;
  readonly auditEventId: string;
}

export class CertificateExpiryRepository {
  listExpiring(tx, now: Date): Promise<readonly ExpiringCertificate[]>;
  claim(tx, input: {
    readonly certificateId: string;
    readonly versionId: string;
    readonly thresholdDays: number;
    readonly daysToExpiry: number;
    readonly auditEventId: string;
    readonly now: Date;
  }): Promise<NotificationClaim | undefined>;
  markSent(tx, claimId: string): Promise<void>;
  deleteClaim(tx, claimId: string): Promise<void>;
  hasAuditEvent(tx, eventId: string): Promise<boolean>;
}
```

`listExpiring` selects:

```sql
SELECT c.id, c.project_id, c.name, v.id AS version_id, v.fingerprint, v.not_after
  FROM certificates c
  JOIN projects p ON p.id = c.project_id
  JOIN certificate_versions v ON v.id = c.current_version_id
 WHERE c.deleted_at IS NULL
   AND p.deleted_at IS NULL
   AND v.not_after > :now
   AND v.not_after <= :now + interval '30 days'
 ORDER BY v.not_after ASC, c.id ASC
```

`claim` first locks the project and certificate rows `FOR SHARE` and re-checks that the
certificate, project, and current version are still active and unexpired. This serializes with
data writes (which take the project `FOR SHARE` and the certificate row lock) and with project
deletes, so a delete or renewal cannot commit between the check and the claim. It then inserts
with `ON CONFLICT (version_id, threshold_days) DO NOTHING RETURNING ...`. If no row is
returned, it selects the existing row `FOR UPDATE` and still requires the active-state check
before reclaiming:
- `status = 'sent'` -> no claim; skip.
- `status = 'pending'` and `claimed_at > now - interval '1 hour'` -> another live run owns it;
  skip.
- `status = 'pending'` and `claimed_at <= now - interval '1 hour'` -> update `claimed_at` and
  `days_to_expiry`. Keep the original `audit_event_id` when its audit event is absent or an
  `allow`; if it is an `error`, generate a new `audit_event_id` so a later success can record
  an allow. Return the claim. This is the lease that recovers a crash after claim or a failed
  mark-sent.

A returned row means this process owns the warning.

### Threshold Selection

```ts
const DAY_MS = 86_400_000;

export function thresholdFor(remainingMs: number): 7 | 14 | 30 | undefined {
  if (remainingMs <= 0 || remainingMs > 30 * DAY_MS) return undefined;
  if (remainingMs > 14 * DAY_MS) return 30;
  if (remainingMs > 7 * DAY_MS) return 14;
  return 7;
}
```

`daysToExpiry = Math.ceil((notAfter.getTime() - now.getTime()) / DAY_MS)` is for display and
the ledger; threshold selection uses the raw remaining milliseconds so 14 days + 1 ms maps to
the 30-day threshold, exactly 14 days maps to 14, and 7 days + 1 ms maps to 14. A certificate
first seen at 10 days receives the 14-day warning only. Expired certificates are excluded by
the query.

### Expiry Service

```ts
export interface ExpiryRunSummary {
  readonly scanned: number;
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

export class CertificateExpiryService {
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly repository: CertificateExpiryRepository;
    readonly webhook: CertificateExpiryWebhook | undefined;
    readonly audit: AuditWriter;
    readonly now?: () => number;
    readonly logger: Logger;
  });
  public async runOnce(): Promise<ExpiryRunSummary>;
}
```

Flow:

1. Generate one run id (ULID) and `requestId = "certificate-expiry-" + runId`.
2. Load the expiring rows in one read.
3. For each row:
   - compute `daysToExpiry` and `thresholdDays`; skip when undefined;
   - claim the unique row in one short transaction with a new stable `auditEventId`; skip when
     another process owns a live lease. The claim transaction commits before any webhook or
     audit work, so no notification row lock is held while the audit chain lock is taken;
   - send the webhook when configured; a non-2xx response, timeout, or network error is a
     failure;
   - if `auditEventResult(claim.auditEventId)` is not `"allow"`, write one
     `certificate.expiry_warning` audit event in its own transaction:
     - success: `result: "allow"`, details
       `{ thresholdDays, daysToExpiry, version, webhook: "sent" }` or `webhook: "skipped"`
       when unconfigured;
     - failure: `result: "error"`, details
       `{ thresholdDays, daysToExpiry, version, webhook: "failed", reason: "webhook_failed" }`;
   - on success, mark the claim `sent` with `sent_at = now()` in a short transaction that takes
     only the notification row lock;
   - on webhook or audit failure, delete the claim so a later run retries. If the mark-sent
     write fails, the claim stays pending with a stale `claimed_at`; a later run reclaims it
     after the one-hour lease and may send a duplicate with the same stable event id.
   The purger takes the audit chain lock and then deletes notification rows; the expiry path
   never holds a notification row lock while taking the audit chain lock, so the two orders do
   not form a cycle.
4. Return `{ scanned, claimed, sent, failed, skipped }` for tests and logs.
5. No expiry warning is written for a deleted certificate, a deleted project, a non-current
   version, or an expired certificate.

### Webhook

`apps/server/src/certificates/expiry/webhook.ts`:

```ts
export interface ExpiryWebhookPayload {
  readonly event: "certificate.expiry_warning";
  readonly eventId: string;
  readonly certificateId: string;
  readonly projectId: string;
  readonly name: string;
  readonly versionId: string;
  readonly fingerprint: string;
  readonly notAfter: string;
  readonly daysToExpiry: number;
  readonly thresholdDays: number;
  readonly occurredAt: string;
}

export class CertificateExpiryWebhook {
  public constructor(options: {
    readonly url: URL;
    readonly secret?: string;
    readonly timeoutMs?: number;
  });
  public async send(payload: ExpiryWebhookPayload): Promise<void>;
}
```

- `eventId = `${certificateId}:${versionId}:${thresholdDays}``.
- POST JSON with `content-type: application/json`, `user-agent: openvault-expiry/1`,
  `redirect: "error"`, and `AbortSignal.timeout(5_000)`.
- Send `X-OpenVault-Timestamp` (the ISO `occurredAt`) and, when a secret is configured,
  compute `sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>` and set
  `X-OpenVault-Signature`. Receivers should reject an old timestamp to prevent replay.
- A 2xx response resolves; anything else throws a typed `CertificateExpiryDeliveryError`.
- The payload contains no PEM, private key, or key id.
- The URL is operator configuration; the config loader requires HTTPS, except loopback HTTP
  in development/test. Credentials and fragments are rejected. In production, a literal
  link-local or cloud-metadata address (`169.254.0.0/16`, `fd00:ec2::254`) is rejected; private
  RFC1918 and loopback HTTPS remain allowed for internal receivers. DNS rebinding is a
  documented residual because the URL is operator-controlled, not user-controlled.
- The webhook URL is never logged and is not included in the redacted configuration; only a
  `webhookConfigured` boolean is exposed.

### Scheduler

`apps/server/src/certificates/expiry/scheduler.ts`:

```ts
export class CertificateExpiryScheduler {
  public constructor(options: {
    readonly service: CertificateExpiryService;
    readonly hour: number;
    readonly now?: () => number;
    readonly logger: Logger;
  });
  public start(): Promise<void>;
  public stop(): Promise<void>;
  public nextRunAt(from: number): Date;
}
```

- The configured hour is interpreted in UTC.
- `start()` runs one scan when the current time is at or after today's configured hour, then
  schedules the next occurrence with a single `setTimeout`.
- Each scan is wrapped in `try/catch/finally`: a failure is logged, and the next run is always
  scheduled in `finally` so one rejected scan cannot stop the job.
- The timer is `unref()`d so it never blocks shutdown.
- `stop()` clears the timer, marks the scheduler stopped, and awaits any in-flight scan so a
  late `finally` does not schedule another run. `start()` is idempotent: a second call while
  running is a no-op. This mirrors the existing agent maintenance lifecycle.
- The scheduler starts only when the application dependency `disableBackgroundJobs` is not
  `true`. `createTestApplication` sets that flag, so tests call `runOnce()` directly while the
  service remains available. Production and development start it.
- Multiple instances are safe because the unique claim decides the sender.

### Configuration

| Variable | Default | Validation |
|---|---|---|
| `OPENVAULT_CERT_EXPIRY_HOUR` | `3` | integer 0–23, UTC |
| `OPENVAULT_CERT_EXPIRY_WEBHOOK_URL` | none | absolute HTTPS (loopback HTTP only outside production), no credentials, max 2,048 |
| `OPENVAULT_CERT_EXPIRY_WEBHOOK_SECRET` | none | 16–256 characters, not included in redacted config or logs; the redacted config reports only whether the webhook is configured |
| `OPENVAULT_CERT_MAX_BYTES` | `131072` | 1,024–131,072 |

### Audit Action

Add `certificate.expiry_warning` to `BUSINESS_AUDIT_ACTIONS` and to
`apps/server/src/audit/actions.ts`:

```ts
const EXPIRY_DETAIL_KEYS = new Set([
  "thresholdDays",
  "daysToExpiry",
  "version",
  "webhook",
  "reason",
]);
```

The event uses:

```ts
{
  actorKind: "system",
  actorId: null,
  action: "certificate.expiry_warning",
  scopeType: "object",
  scopeId: certificateId,
  projectId,
  objectType: "certificate",
  objectId: certificateId,
  result: "allow" | "error",
  details: { thresholdDays, daysToExpiry, version, webhook, ... },
}
```

### Failure Semantics

- Webhook failure: the claim is deleted; the next daily run retries.
- Audit failure after a successful send: the claim is deleted; the next run retries. The
  stable `eventId` lets the receiver dedupe.
- Mark-sent failure: the claim remains `pending`; a later run reclaims it after the one-hour
  lease and retries.
- A crash after claim but before send: the pending row is reclaimed after the lease on a later
  run (normally the next daily run; the lease is a concurrency guard, not a retry timer).
- A crash after send but before mark-sent has the same reclaim behavior. Document this as
  at-least-once with receiver dedupe and a stable `audit_event_id`.
- A crash after the destructive certificate purge but before the claim cleanup cannot leave a
  live claim because the purge deletes the notification rows.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Webhook is not configured | Log and audit with `webhook: "skipped"`; mark sent | AR-19 |
| Webhook returns non-2xx or times out | Audit error; delete claim; retry next run | AR-20 |
| Audit write fails | Delete claim; retry next run | AR-20 |
| Mark-sent fails | Leave the claim pending; retry next run | AR-20 |
| Another instance claimed the row | Skip without a send | AR-18 |
| Certificate/project deleted | Excluded by the query | AR-17 |
| Certificate expired | Excluded by the query | AR-17 |
| Invalid configuration | Boot fails with a safe ConfigError | AR-26 |

## Integration Points

- `apps/server/src/app.ts` composes the expiry service, webhook, repository, and scheduler and
  registers them for disposal.
- The scheduler starts unless `disableBackgroundJobs` is set; the test application sets it.
- The audit writer records the expiry event on the independent chain.
- RD-13 can back up the notification rows and the webhook configuration manifest.

## Testing Requirements

- Specification tests for thresholds 30/14/7, nearest-threshold selection, current-version
  selection, idempotent second runs, webhook success/failure/retry, audit events, deleted
  certificate/project, expired certificate, and no-webhook mode.
- Implementation tests for concurrent `runOnce` calls, stale-pending lease reclaim,
  crash-after-claim, mark-sent failure, audit-event dedupe, the `version` detail, HMAC
  timestamp/signature, timeout, redirect rejection, and the scheduler's next-run calculation.
- No test uses the real clock; the service takes a clock seam.

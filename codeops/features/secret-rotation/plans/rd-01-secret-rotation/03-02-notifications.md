# Notifications: Secret Rotation Workflow

> **Document**: 03-02-notifications.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the optional daily rotation scan, its durable notification table, the signed
webhook, the audit event, and the purge/dump/grants integration. It mirrors the certificate-expiry
service and does not read secret plaintext.

## Architecture

### Current pattern

The certificate-expiry feature has four modules under `apps/server/src/certificates/expiry/`:

- `repository.ts` — list expiring rows, claim, mark sent, release/delete claims.
- `service.ts` — scan, threshold selection, webhook send, audit, mark sent.
- `scheduler.ts` — daily UTC run with a lease.
- `webhook.ts` — URL validation, HMAC, timeout.

The `certificate_expiry_notifications` table makes delivery durable. The scan runs once per UTC day
at `OPENVAULT_CERT_EXPIRY_HOUR`. [AR-13]

### Proposed modules

```text
apps/server/src/secrets/rotation/repository.ts
apps/server/src/secrets/rotation/service.ts
apps/server/src/secrets/rotation/scheduler.ts
apps/server/src/secrets/rotation/webhook.ts
```

The modules are dedicated to secrets; do not generalize the certificate-expiry service. [AR-27]

## Implementation Details

### Notification table

```ts
const secretRotationNotifications = db.table("secret_rotation_notifications");
secretRotationNotifications.text("id").check(ulidExpression("id"));
secretRotationNotifications.text("secret_id");
secretRotationNotifications.text("project_id");
secretRotationNotifications.text("version_id");
secretRotationNotifications.text("status").check("status IN ('due_soon', 'overdue')");
secretRotationNotifications.timestamptz("due_at");
secretRotationNotifications.integer("days_until_due");
secretRotationNotifications.text("claim_id").nullable();
secretRotationNotifications.timestamptz("claimed_at").nullable();
secretRotationNotifications.timestamptz("sent_at").nullable();
secretRotationNotifications.text("audit_event_id").nullable();
secretRotationNotifications.timestamptz("created_at").default("now()");
secretRotationNotifications.primaryKey().column("id");
secretRotationNotifications
  .uniqueConstraint()
  .column("secret_id", "version_id", "status", "due_at");
secretRotationNotifications
  .index()
  .indexName("secret_rotation_notifications_status_idx")
  .column("status", "claimed_at");
```

No value, ciphertext, or key material. [AR-13]

### Scan eligibility

- Active secret, active project, policy interval not null, current version not null.
- `dueAt = current_version.created_at + interval`.
- `status = "overdue"` when `now >= dueAt`.
- `status = "due_soon"` when `dueAt - warningDays <= now < dueAt`.
- Nothing when `now < dueAt - warningDays`.

The scan lists only rows inside the warning window or overdue, in batches of 500. [AR-10, AR-13]

### Claim and delivery

1. Claim a `(secret, version, status, dueAt)` row with a one-hour lease in a short transaction.
2. Re-check eligibility in the same transaction.
3. Send the webhook if configured; otherwise record `webhook: "skipped"`.
4. Write the `secret.rotation_warning` audit event.
5. Mark the claim sent.
6. On failure, delete the claim so a later scan retries; audit the failure with
   `webhook: "failed"` and a stable reason.

The audit chain lock is not held while sending the webhook. [AR-13, AR-23]

### Webhook

Payload:

```json
{
  "event": "secret.rotation_warning",
  "eventId": "<secretId>:<versionId>:<status>:<dueAt>",
  "secretId": "01J...",
  "projectId": "01J...",
  "name": "db-password",
  "versionId": "01J...",
  "dueAt": "2026-12-09T00:00:00.000Z",
  "daysUntilDue": 7,
  "status": "due_soon",
  "occurredAt": "2026-12-02T04:00:00.000Z"
}
```

Request headers:

```text
Content-Type: application/json
User-Agent: openvault-rotation/1
X-OpenVault-Timestamp: <occurredAt>
X-OpenVault-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + rawBody)>
```

URL validation, loopback rules, timeout, and header redaction mirror
`apps/server/src/certificates/expiry/webhook.ts`. The value is never included. [AR-14, PAR-05]

### Configuration

| Variable | Default | Validation |
|---|---|---|
| `OPENVAULT_ROTATION_SCAN_HOUR` | `4` | integer 0–23 |
| `OPENVAULT_ROTATION_WARNING_DAYS` | `7` | integer 1–30 |
| `OPENVAULT_ROTATION_WEBHOOK_URL` | none | absolute HTTPS URL; loopback HTTP outside production; no credentials/fragments; reject production link-local/metadata targets |
| `OPENVAULT_ROTATION_WEBHOOK_SECRET` | none | 16–256 characters; never logged or exposed in redacted config |

Add the settings to `Config` and the redacted configuration output. [AR-22, PAR-14]

### Audit

Add `"secret.rotation_warning"` to `BUSINESS_AUDIT_ACTIONS` in
`packages/api-contract/src/actions.ts`, then add the detail allowlist in
`apps/server/src/audit/actions.ts`:

```ts
"secret.rotation_warning",
```

and a detail allowlist:

```ts
const ROTATION_DETAIL_KEYS = new Set([
  "status",
  "daysUntilDue",
  "version",
  "webhook",
  "reason",
]);
```

The warning event is written with the project id and the secret object id. It never includes the
value or key material. [AR-15, PAR-06]

### Purge, dump, and grants

- `apps/server/src/purge/vault-purger.ts`: add `secret_rotation_notifications` to the allowed
  relation set and delete rows by `secret_id` before the secret delete.
- `apps/server/src/ops/database-dump.ts`: add the table to the dump table list.
- `deploy/postgres/grants.sql` and `docs/reference/configuration.md`: grant/delete as required by the
  purge role and any backup role.
- The purge test asserts no orphan rows. [AR-21, PAR-07]

### Scheduler wiring

- Add `SecretRotationScheduler` next to `CertificateExpiryScheduler` in `apps/server/src/app.ts`.
- Start it only when the server has a migration/role configuration that permits it; mirror the
  existing scheduler lifecycle.
- The scheduler uses the same daily lease pattern as certificate expiry. [AR-13, PAR-04]

## Error Handling

| Case | Handling | Ref |
|---|---|---|
| Webhook unreachable or non-2xx | Audit `webhook: "failed"`; release the claim; retry next scan | AR-23 |
| Audit write fails | Keep the claim until the lease; retry later | AR-23 |
| Claim lost to another process | Skip; the owner delivers | AR-23 |
| No webhook configured | Audit `webhook: "skipped"`; log | AR-4 |
| Secret deleted or policy cleared before send | Re-check eligibility; delete the claim; skip | AR-13 |
| New version written before send | The old `(secret, version, status)` claim is ineligible; skip | AR-9 |

## Testing Requirements

- Repository tests for claim, lease, uniqueness, eligibility, and mark-sent.
- Service tests for due-soon/overdue thresholds, no webhook, webhook failure, retry, audit, and no
  value in the payload.
- Webhook tests for URL validation, HMAC, timeout, and SSRF.
- Scheduler test with an injected clock.
- Purge/dump tests.
- Integration test with the real database. [AR-25, PAR-11]

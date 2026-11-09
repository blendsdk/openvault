# RD-01: Secret Rotation Workflow

> **Document**: RD-01-secret-rotation.md
> **Status**: Draft (preflight ready)
> **Created**: 2026-11-09 09:54
> **Project**: OpenVault
> **Depends On**: openvault-v0-1/RD-08 (Projects and secrets), openvault-v0-1/RD-10 (Agent delivery), openvault-v0-1/RD-11 (CLI), openvault-v0-1/RD-12 (Web UI)
> **Target Release**: v1.2.0
> **CodeOps Artifact Schema**: 1

## Feature Overview

OpenVault already supports immutable secret versions, an optional per-version expiry, agent delivery,
and a web UI action that writes a new version. What it lacks is a **rotation workflow**: a way to say
"this secret must be rotated every N days", see which secrets are due or overdue, rotate with a
supplied or generated value, and optionally deliver a signed reminder to an operator endpoint.

This requirement adds that workflow. A secret may carry a rotation policy expressed as an interval in
days. The server derives the due date from the current version's creation time, so writing a new
version naturally completes the rotation and starts the next interval. A project **Rotation** screen
and a rotation card on the secret detail page show the policy, due state, last rotation, and current
consumers. The CLI gains an `ov rotation` group for the same operations. An optional daily scan sends
a signed, metadata-only webhook for due-soon and overdue secrets; the UI itself always shows live
status, so the webhook is a notification convenience, not the source of truth.

The workflow is operator-driven. It does not generate or write values automatically, does not call
external providers, does not track which agent or application holds which version, and does not delete
old versions. The old version remains readable, as it is today. A running application still needs to
restart or watch its secret file to use the new value.

## Functional Requirements

### Must Have

- [ ] A secret can store an optional rotation interval of 1–3650 days. Setting, changing, or clearing
  the interval uses the existing secret metadata update path. [AR-9, AR-12]
- [ ] The server derives `rotationDueAt` from the current version's `createdAt` plus the interval and
  returns `rotationIntervalDays`, `rotationDueAt`, and `rotationStatus` in secret metadata. [AR-9, AR-12]
- [ ] `rotationStatus` is `null` when no policy exists, `ok` before the warning window, `due_soon`
  inside the warning window, and `overdue` at or after the due date. [AR-10]
- [ ] The warning window defaults to 7 days and is configurable from 1 to 30 days. [AR-10, AR-22]
- [ ] The existing secret list accepts `rotation=policy` (any policy), `rotation=due` (due-soon or
  overdue), and `rotation=overdue` (overdue only). The due and overdue filters exclude secrets without
  a policy. [AR-12, AR-19]
- [ ] A project has a **Rotation** section at `/projects/:project/rotation` that lists secrets with a
  policy, their status, due date, interval, last rotation, and consumer count. [AR-18]
- [ ] The Rotation page supports search, a status filter (all/due/overdue), cursor pagination, and a
  **Rotate** action per row. [AR-18, AR-19]
- [ ] The secret detail page shows a rotation card with the policy, status, due date, last rotation,
  consumers, **Set policy**, and **Rotate now**. [AR-18, AR-20]
- [ ] The secrets list shows a rotation status badge when a policy exists and links to the Rotation
  page. [AR-18, AR-19]
- [ ] The project overview shows due-soon and overdue counts with a link to the Rotation page. [AR-18]
- [ ] **Rotate now** accepts a manually entered value or an optional generated value, an optional
  version expiry, and writes a new version through the existing secret value write path. [AR-5, AR-17]
- [ ] The generated value is 32 random bytes encoded as base64url, shown once, and never written to
  browser storage, the URL, the console, or logs. [AR-17]
- [ ] A successful rotation shows the new version id and the next due date. The previous version
  remains readable. [AR-6, AR-9]
- [ ] The CLI adds `ov rotation set`, `ov rotation clear`, `ov rotation list`, `ov rotation status`, and
  `ov rotation rotate`. [AR-16]
- [ ] `ov rotation rotate --generate` uses Node's cryptographic random source. With `--out FILE` it
  writes the value to a mode-`0600` file; without `--out` it prints the value once and warns on stderr.
  [AR-17]
- [ ] An optional daily scan sends a signed webhook for `due_soon` and `overdue` secrets. The payload
  contains metadata only and no value, key, or ciphertext. [AR-4, AR-13, AR-14]
- [ ] The scan records one warning per `(secret, version, status, dueAt)` and retries failed
  deliveries on a later run. [AR-13, AR-23]
- [ ] Rotation warnings write a `secret.rotation_warning` audit event. [AR-15]
- [ ] The new notification table is included in purge, database dump, and role-grant handling. [AR-21]
- [ ] The UI states that the agent fetches the new version on refresh and the application must restart
  or watch the file. No application control is added. [AR-28]
- [ ] Every read and write remains authorized by the server. The UI hides write actions when
  `canWrite` is false. [AR-11]

### Should Have

- [ ] The CLI `ov rotation list` prints name, status, due date, interval, and last rotation. [AR-16]
- [ ] The CLI `ov rotation status <name>` prints the policy, due state, current version, and consumers.
- [ ] The Rotation page has empty states for no policies, no matching secrets, and no overdue secrets.
- [ ] The Rotate dialog offers **Generate value**, **Copy value**, and **Regenerate** before submit.
- [ ] The UI shows the warning window and the exact due date, not only a badge.
- [ ] The webhook payload is HMAC-signed and includes a timestamp for replay rejection. [AR-14]
- [ ] The UI and CLI docs explain the restart requirement and the absence of version-level tracking. [AR-28]

### Won't Have (Out of Scope)

- Automatic server-side rotation or automatic value generation without an operator. [AR-2, AR-8]
- External provider rotation (database, cloud, or third-party credential APIs). [AR-8]
- Version-level consumer tracking or application acknowledgement. [AR-3]
- Deleting or expiring the previous version as part of rotation. [AR-6]
- Email notifications, chat integrations, or a notification inbox. [AR-4]
- A global cross-project rotation page. The feature is project-scoped. [AR-18]
- A new dependency, workflow engine, queue, or generic notification framework. [AR-27]
- Release tagging or publication in this plan. [AR-26]

## Technical Requirements

### Data model

Add one nullable column to `secrets`:

```sql
rotation_interval_days integer NULL
  CHECK (rotation_interval_days BETWEEN 1 AND 3650)
```

The due date is not stored. It is derived:

```text
rotationDueAt = currentVersion.createdAt + rotationIntervalDays days
```

A partial index on `rotation_interval_days IS NOT NULL` supports the rotation scans and filters. The
current version's `createdAt` is already returned by the list query. [AR-9, AR-24]

### Metadata API

`secretMetadataSchema` gains:

| Field | Type | Meaning |
|---|---|---|
| `rotationIntervalDays` | `number \| null` | Configured interval in days |
| `rotationDueAt` | ISO timestamp \| null | Next due date derived from the current version |
| `rotationStatus` | `"ok" \| "due_soon" \| "overdue" \| null` | Live status, computed by the server |

`secretMetadataUpdateRequestSchema` gains
`rotationIntervalDays: z.number().int().min(1).max(3650).nullable().optional()`. `null` clears the
policy. The existing "at least one field" refinement includes the new field. The create request is
unchanged; a policy can be set immediately after creation. [AR-12]

### List API

`secretListQuerySchema` gains `rotation: z.enum(["policy", "due", "overdue"]).optional()`. The
repository adds the status predicate:

```sql
-- policy
s.rotation_interval_days IS NOT NULL

-- due
s.rotation_interval_days IS NOT NULL
AND v.created_at + make_interval(days => s.rotation_interval_days)
    <= :now + make_interval(days => :warningDays)

-- overdue
s.rotation_interval_days IS NOT NULL
AND v.created_at + make_interval(days => s.rotation_interval_days) <= :now
```

The existing name/tag/cursor filters compose with it. The response shape is unchanged except for the
new metadata fields. [AR-12, AR-19]

### Status computation

The server computes status against its own clock:

```text
if no interval: null
else if now >= dueAt: overdue
else if now >= dueAt - warningDays: due_soon
else ok
```

The UI uses the returned status; it does not compute its own due logic. The CLI uses the returned
status. [AR-10, AR-12]

### Rotation write path

The workflow reuses `PUT /v1/data/:project/secrets/:name` with the existing request schema. The UI
and CLI pass the new value, encoding, optional `expiresAt`, and optional idempotency key. A new
version becomes current; `rotationDueAt` recomputes on the next read. The previous version remains
readable. [AR-5, AR-6, AR-9]

### Webhook scan

A dedicated `SecretRotationService` mirrors the certificate-expiry service:

- Daily at `OPENVAULT_ROTATION_SCAN_HOUR` (default 4, UTC).
- Considers only active secrets in active projects, with a policy and a current version.
- Claims one `secret_rotation_notifications` row per `(secret, version, status)`.
- Sends the webhook when configured; otherwise records `webhook: "skipped"` and logs.
- Writes `secret.rotation_warning`; marks the claim sent.
- Retries a failed delivery on a later run after a one-hour claim lease.

The scan never reads secret plaintext and never includes a value in the payload, audit event, or log.
[AR-4, AR-13, AR-14, AR-15, AR-23]

### Webhook payload

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

With a secret configured, the request includes `X-OpenVault-Timestamp` and
`X-OpenVault-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + rawBody)>`. The URL validation,
timeout, and SSRF protections mirror the certificate-expiry webhook. [AR-14]

### Notification persistence

`secret_rotation_notifications` stores:

| Column | Purpose |
|---|---|
| `id` | ULID claim id |
| `secret_id`, `project_id` | Ownership |
| `version_id` | The version that triggered the warning |
| `status` | `due_soon` or `overdue` |
| `due_at` | Due date at claim time |
| `days_until_due` | Integer; 0 on the due date, negative when overdue |
| `claim_id`, `claimed_at` | Lease ownership |
| `sent_at` | Delivery completion |
| `audit_event_id` | The warning audit event |
| `created_at` | Row creation |

A unique constraint on `(secret_id, version_id, status, due_at)` prevents duplicate warnings for the
same due date while allowing a new warning if a policy change moves the due date. [AR-13, AR-23]

### Audit, purge, and dump

- Add `secret.rotation_warning` to the business audit actions and an allowlist for
  `status`, `daysUntilDue`, `version`, `webhook`, and `reason`.
- Add `secret_rotation_notifications` to the purger's allowed relation set and delete path.
- Add it to the database dump table list.
- Update the purge role grants and documentation so a purge cannot leave orphan rows. [AR-15, AR-21]

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENVAULT_ROTATION_SCAN_HOUR` | `4` | UTC hour for the daily scan (0–23) |
| `OPENVAULT_ROTATION_WARNING_DAYS` | `7` | Due-soon window (1–30) |
| `OPENVAULT_ROTATION_WEBHOOK_URL` | none | Optional HTTPS endpoint; loopback HTTP outside production |
| `OPENVAULT_ROTATION_WEBHOOK_SECRET` | none | Optional 16–256 character HMAC secret |

Validation and redaction follow the certificate-expiry settings. [AR-22]

### CLI

| Command | Options | Purpose |
|---|---|---|
| `ov rotation set <name>` | `--every-days`, `--project` | Set the interval |
| `ov rotation clear <name>` | `--project` | Remove the policy |
| `ov rotation list` | `--project`, `--due`, `--overdue`, `--limit`, `--cursor` | List policy secrets |
| `ov rotation status <name>` | `--project` | Show one secret's policy and state |
| `ov rotation rotate <name>` | `--generate`, `--out`, `--expires-at`, `--encoding`, `--stdin`, `--from-file`, `--idempotency-key`, `--project` | Write a new version |

`--generate` and `--stdin`/`--from-file` are mutually exclusive. With `--generate --out FILE`, the
value is written to a mode-`0600` file and only metadata is printed. Without `--out`, the value is
printed once to stdout with a warning on stderr. [AR-16, AR-17]

### Web UI

- `RotationPage` at `/projects/:project/rotation`.
- `RotationPolicyDialog` and `RotationDialog` (or a shared rotate dialog).
- A rotation card on `SecretDetailPage` and a status badge on `SecretsPage`.
- A rotation summary card on `ProjectOverviewPage`.
- Section navigation, launcher entry, and docs mapping.
- Generated value shown once with copy/regenerate; no storage.
- Capability gating with `canWrite`.
- Axe coverage for the Rotation page and the rotate dialog. [AR-17, AR-18, AR-20]

### Documentation

Update `docs/guide/rotation.md`, `docs/guide/secrets.md`, `docs/guide/web-ui.md`,
`docs/guide/cli.md`, `docs/reference/cli.md`, `docs/reference/configuration.md`,
`docs/reference/api.md`, `docs/changelog.md`, `docs/guide/versioning.md`, `docs/index.md`, and
`README.md`. The reader docs must explain the restart requirement and the absence of version-level
tracking. [AR-26, AR-28]

## Integration Points

### With openvault-v0-1/RD-08 (Secrets)

The feature extends secret metadata and the list query. It reuses the existing write, version, expiry,
and audit paths.

### With openvault-v0-1/RD-10 (Agent delivery)

The agent continues to fetch the newest active version on its refresh. No agent protocol change is
required. The docs state that the application must restart or watch the file.

### With openvault-v0-1/RD-11 (CLI)

The new `ov rotation` group composes the generated client and the existing secure file writer.

### With openvault-v0-1/RD-12 (Web UI)

The new page follows the project shell, filter bar, table, dialog, feedback, and capability patterns.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|----------|-------------------|--------|-----------|--------|
| Feature location | New feature set, extend v1.1, standalone | `secret-rotation`, RD-01 | Keeps the closed v1.1 set intact | AR-1 |
| Rotation model | Policy + reminders + guided, automatic, external | Policy + reminders + guided | Operator control and a realistic scope | AR-2 |
| Consumer tracking | Visibility, version-level, none | Visibility only | The agent cannot prove application reload | AR-3 |
| Notifications | In-app + webhook, in-app only, email | In-app + optional webhook | Reuses the certificate-expiry pattern | AR-4 |
| Value supply | Manual + generator, manual only, server-only | Manual + generator | Keeps the write path and gives operators a safe default | AR-5 |
| Old versions | Keep, retire, delete | Keep | Avoids a destructive lifecycle change | AR-6 |
| Release and surfaces | v1.2.0 UI + CLI, UI only, CLI only | v1.2.0 UI + CLI | Consistent with the certificate UI | AR-7 |
| Policy model | Interval from current version, explicit date, both | Interval from current version | Natural rotation semantics, no new mutable date | AR-9 |
| Authorization | Reuse `secret.write`, new action | Reuse `secret.write` | Rotation writes a value | AR-11 |
| API shape | Metadata + list filter, new routes | Metadata + list filter | No duplicate read path | AR-12 |
| Webhook | Mirror certificate expiry, generic scheduler, none | Mirror certificate expiry | Durable, deduplicated, no new framework | AR-13 |
| Complexity | Reuse stack, new dependency | Reuse stack | No material support surface | AR-27 |

## Security Considerations

- **Data sensitivity**: The workflow handles secret values only during the rotate write. The generated
  value is shown once; it is never stored in browser storage, the URL, the console, logs, the webhook,
  or the audit event. [AR-17, AR-14, AR-15]
- **Input validation**: The interval is an integer 1–3650; the status filter is a closed enum; the
  policy update uses the strict schema. Values use the existing limits and encoding validation.
  [AR-12, AR-24]
- **Authentication and authorization**: Policy and rotation require `secret.write`; viewing requires
  `secret.list`/`secret.read`. The server authorizes every request; the UI hides write actions when
  `canWrite` is false. [AR-11]
- **Injection**: The list query remains parameterized; the interval is bound as a number; the webhook
  URL is validated; no user text is evaluated. [AR-12, AR-14]
- **Encryption**: The new value uses the existing envelope encryption. The notification table contains
  metadata only. [AR-9, AR-13]
- **Rate limiting**: The existing secret write and list limits apply. The scan has its own internal
  cadence and does not touch the public rate limiters. [AR-13]
- **Webhook security**: HTTPS (loopback HTTP outside production), SSRF rejection, timeout, timestamp,
  and HMAC; no value or key material. [AR-14]
- **Audit**: Policy changes and rotations are authorized writes; warnings are a distinct event. A
  warning never contains the value. [AR-15]
- **Destructive actions**: No old-version deletion, no automatic value change, no application control.
  [AR-6, AR-28]
- **Browser storage**: No secret value or generated value in local storage, session storage,
  IndexedDB, JavaScript-readable cookies, or the URL. [AR-17]

## Non-Functional Requirements

### Performance

- The list query uses the existing cursor and an index for policy rows.
- The scan processes active policy secrets in batches; it never loads plaintext.
- The UI first page is 25 rows; the Rotation page uses cursor pagination.
- The due status is computed from the already-loaded current version; no extra query per row. [AR-9, AR-13]

### Accessibility

- Every field has a label and an error; the Rotation table has a caption and header scope.
- Dialogs trap focus and restore it; status uses text and an icon.
- The Rotation page and rotate dialog are covered by axe. [AR-18]

### Compatibility

- One nullable column and one new table; existing routes and fields are unchanged.
- The new metadata fields and filter are additive; older clients ignore them.
- The new CLI group is additive. [AR-24]

## Acceptance Criteria

1. [ ] Setting `rotationIntervalDays=30` on a secret with a current version created today returns
   `rotationDueAt` 30 days later and `rotationStatus="ok"`.
2. [ ] Setting `rotationIntervalDays=null` clears the policy and returns null rotation fields.
3. [ ] A secret whose current version is 25 days old with a 30-day interval and a 7-day warning
   window returns `rotationStatus="due_soon"`; at 30 days it returns `"overdue"`.
4. [ ] `GET /v1/data/payments/secrets?rotation=policy` returns only secrets with a policy.
5. [ ] `GET /v1/data/payments/secrets?rotation=due` returns due-soon and overdue policy secrets and
   excludes secrets without a policy.
6. [ ] `GET /v1/data/payments/secrets?rotation=overdue` returns only overdue policy secrets.
7. [ ] The Rotation page lists policy secrets with name, status, due date, interval, last rotation,
   and consumer count; the filters and Load more work.
8. [ ] The secret detail rotation card shows the policy, status, due date, last rotation, and
   consumers, and exposes Set policy and Rotate now only when `canWrite` is true.
9. [ ] **Rotate now** with a manual value writes a new version and shows its version id and next due
   date; the previous version remains readable.
10. [ ] **Generate value** produces a 32-byte base64url value, shows it once, and supports copy and
   regenerate; the value is not in storage, the URL, the console, or logs.
11. [ ] `ov rotation set db-password --every-days 30` sets the policy; `ov rotation clear` removes it.
12. [ ] `ov rotation list --due` prints the due/overdue rows; `ov rotation status db-password` prints
    the policy and state.
13. [ ] `ov rotation rotate db-password --generate --out /secure/db-password` writes a mode-`0600`
    file and prints metadata; without `--out`, it prints the value once and a warning on stderr.
14. [ ] The daily scan sends one `due_soon` warning and one `overdue` warning per secret version, with
    a valid HMAC and no value.
15. [ ] A failed webhook delivery is retried on a later scan; a duplicate scan does not send the same
    warning twice.
16. [ ] The warning writes a `secret.rotation_warning` audit event with status, days until due,
    version, and webhook outcome.
17. [ ] Purging a secret removes its notification rows; a database dump includes the table; the purge
    role can delete the rows.
18. [ ] The UI and docs state that the agent fetches the new version on refresh and the application
    must restart or watch the file.
19. [ ] No new dependency, service, queue, or generic notification framework is added.
20. [ ] `pnpm api:check` reports no drift.
21. [ ] `pnpm verify` passes, including the documentation guard.
22. [ ] The reader docs and version labels state 1.2.0 at the end of the final phase.

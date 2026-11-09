# Testing Strategy: Secret Rotation Workflow

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage goals

| Code type | Target |
|---|---|
| Rotation status and list logic | 90% |
| Scheduler, claims, and webhook | 90% |
| CLI commands and generator | 80% |
| Web pages and dialogs | 80% |
| Docs guard | 100% of stated rules |

Test names state behavior: `should [expected behavior] when [condition]`. Server tests use the real
services and PostgreSQL integration harness. Web tests render the real pages and generated client
through `FakeVault`. CLI tests use the real parser and a test runtime.

## 🚨 Specification Test Cases

> Derived from RD-01, the component specs, and the Ambiguity Register. The expectations are the oracle;
> a failing spec test means the implementation is wrong, not the test. In-code traceability comments
> quote behavior in plain language, never an ST/RD/AR id.

### Data and API

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | PATCH a secret with `rotationIntervalDays=30` | Metadata returns 30, a due date 30 days after the current version createdAt, and `ok` | RD-01 AC-1 |
| ST-2 | PATCH `rotationIntervalDays=null` | Rotation fields are null | RD-01 AC-2 |
| ST-3 | Current version 25 days old, interval 30, warning 7 | `due_soon`; at exactly 30 days, `overdue`; at 24 days, `ok` | RD-01 AC-3 |
| ST-4 | `GET ...?rotation=policy` | Only secrets with an interval | RD-01 AC-4 |
| ST-5 | `GET ...?rotation=due` | Due-soon and overdue only | RD-01 AC-5 |
| ST-6 | `GET ...?rotation=overdue` | Overdue only | RD-01 AC-6 |
| ST-7 | PATCH interval 0, 3651, or a fraction | 422 `validation_error` | RD-01 AC-1 |
| ST-8 | `GET ...?rotation=attention` | 422 `validation_error` | RD-01 AC-4 |
| ST-9 | Existing list with no rotation filter | Unchanged behavior; rotation fields present when a policy exists | AR-24 |
| ST-9a | Secret metadata for an `ok`, `degraded`, and `failed` consumer | `consumers[].state` returns the stored value | AR-3, AR-20 |
| ST-9b | Apply the full migration set to a fresh database | The migration ledger, table inventory, foreign keys, view columns, role grants, and purge grants match the updated assertions | PF-001 |
| ST-10 | Run `pnpm api:check`, `pnpm db:types:check`, and the integration suite | Exit 0; no generated contract or database-type drift | RD-01 AC-20 |

### Notifications

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-11 | Scan a due-soon secret | One `due_soon` claim and webhook payload with the correct due date and `daysUntilDue` | RD-01 AC-14 |
| ST-11a | Scan at `dueAt - 1ms`, `dueAt`, and `dueAt + 1ms` | `due_soon` with `1`, `overdue` with `0`, and `overdue` with `-1` days respectively | RD-01 AC-14, PF-010 |
| ST-12 | Scan an overdue secret | One `overdue` claim with a negative `daysUntilDue` | RD-01 AC-14 |
| ST-13 | Run the scan twice for the same version/status/due date | The second run sends nothing | RD-01 AC-15 |
| ST-13a | Change the policy so the due date moves on the same version | A new warning is allowed for the new due date | AR-23 |
| ST-14 | Webhook returns 503 | Audit `webhook: "failed"`, release the claim, retry on the next scan | RD-01 AC-15 |
| ST-15 | No webhook configured | Audit `webhook: "skipped"`; no network call | AR-4 |
| ST-16 | Inspect the webhook payload | No value, key, ciphertext, or tags; only metadata | RD-01 AC-14 |
| ST-17 | Inspect the webhook headers | Timestamp and valid HMAC signature | RD-01 AC-14 |
| ST-18 | Configure a metadata/link-local URL in production | Boot validation rejects it | AR-14 |
| ST-19 | Inspect the audit event | `secret.rotation_warning` with status, days, version, webhook | RD-01 AC-16 |
| ST-20 | Purge a secret with notification rows | Rows are removed; no orphans | RD-01 AC-17 |
| ST-21 | Create a database dump | `secret_rotation_notifications` is included | RD-01 AC-17 |
| ST-22 | Boot with invalid scan hour/warning days | Startup fails closed with a clear setting name | AR-22 |

### CLI

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-23 | `ov rotation set db-password --every-days 30` | PATCH sends 30; output shows due/status | RD-01 AC-11 |
| ST-24 | `ov rotation clear db-password` | PATCH sends null | RD-01 AC-11 |
| ST-25 | `ov rotation list --due` | List request uses `rotation=due`; table shows name/status/due/interval | RD-01 AC-12 |
| ST-26 | `ov rotation status db-password` | Shows policy or “No policy”, due, current version, consumers | RD-01 AC-12 |
| ST-27 | `ov rotation rotate db-password --stdin` | PUT sends the value, encoding, expiry, idempotency key | RD-01 AC-13 |
| ST-28 | `ov rotation rotate --generate --out FILE` | 43-character base64url value written mode 0600; stdout has no value | RD-01 AC-13 |
| ST-28a | `--out` with an existing file, with and without `--force` | Fails without force; replaces with force | PF-007 |
| ST-28b | Server write fails after `--out` succeeds | The file is removed and the command exits non-zero | PF-007 |
| ST-29 | `ov rotation rotate --generate` without `--out` | Value printed once after success; warning on stderr | RD-01 AC-13 |
| ST-30 | `--generate` with `--stdin` or `--from-file`; `--out` without `--generate`; `--due` with `--overdue` | Exit 2 with a clear message | AR-17, PF-007, PF-016 |
| ST-31 | Generate a value | No value in the JSON metadata, logs, or error output | AR-17 |

### Web

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-32 | Open `/projects/payments/rotation` | Table shows policy secrets with status/due/interval/last rotated/consumers | RD-01 AC-7 |
| ST-32a | Open `/projects/payments/rotation?status=due` | The due filter is selected and the request uses `rotation=due` | PF-014 |
| ST-33 | Apply search/status filters and Load more | Correct query parameters; rows append; cursor resets on filter change | RD-01 AC-7 |
| ST-34 | Open with no policies / no matches / no overdue | Three distinct empty states | AR-19 |
| ST-35 | Reader without `canWrite` | Rotate and Set policy are absent | AR-11 |
| ST-36 | Secret detail with a policy | Rotation card shows interval, due, status, last rotated, consumers | RD-01 AC-8 |
| ST-37 | Set policy dialog | Sends the interval; clear sends null; invalid values block | RD-01 AC-8 |
| ST-38 | Rotate dialog with a manual value | Sends the value/expiry; success shows version and next due | RD-01 AC-9 |
| ST-39 | Generate, regenerate, copy | Value is 43 base64url chars; copy equals it; regenerate replaces it | RD-01 AC-10 |
| ST-40 | Close/unmount the rotate dialog | Generated value is gone; no storage/URL/console entry | RD-01 AC-10 |
| ST-41 | Secrets list with a due secret | Due badge and Needs rotation link | RD-01 AC-7 |
| ST-42 | Project overview | Due/overdue counts and link | RD-01 AC-7 |
| ST-43 | Navigate to Rotation | Section current; launcher entry; Docs link to `/guide/rotation` | AR-18 |
| ST-44 | Server 403/422/409 | Documented error text; no raw internals | AR-11, AR-12 |
| ST-45 | Run axe on Rotation and the dialog | No violations | AR-25 |

### Documentation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-46 | Read `docs/guide/rotation.md` | Explains policy, due status, UI/CLI, generated value, restart, webhook | RD-01 AC-18 |
| ST-47 | Read `docs/guide/web-ui.md` | Lists the Rotation page/card and restart note | RD-01 AC-18 |
| ST-48 | Read `docs/reference/cli.md` | Lists all `ov rotation` commands/options | RD-01 AC-13 |
| ST-49 | Read `docs/reference/configuration.md` | Lists the four env vars and purge table note | RD-01 AC-17 |
| ST-50 | Read release labels | README, docs index, versioning state 1.2.0 | RD-01 AC-22 |
| ST-51 | Run `tests/docs.spec.test.mjs` | Version, terms, rotation coverage guards pass | RD-01 AC-21 |

## Test Categories

### Specification tests

| Test file | ST cases | Component |
|---|---|---|
| `apps/server/tests/integration/secrets/rotation-policy.spec.test.ts` | ST-1..ST-10 (including ST-9a) | Data/API |
| `apps/server/tests/integration/secrets/rotation-notifications.spec.test.ts` | ST-11..ST-22 (including ST-11a/ST-13a) | Notifications |
| `apps/server/tests/integration/migrations.spec.test.ts` | ST-9b | Database lifecycle |
| `apps/server/tests/integration/schema.spec.test.ts` | ST-9b | Database lifecycle |
| `apps/cli/tests/rotation.spec.test.ts` | ST-23..ST-31 (including ST-28a/ST-28b) | CLI |
| `apps/web/tests/rotation-page.test.tsx` | ST-32..ST-44 (including ST-32a) | Web |
| `apps/web/tests/accessibility.test.tsx` | ST-45 | Web accessibility |
| `tests/docs.spec.test.mjs` | ST-46..ST-51 | Docs |

### Implementation tests

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/integration/secrets/rotation-repository.impl.test.ts` | Boundary math with a fixed clock, keyset cursor, policy filter, consumer state | High |
| `apps/server/tests/integration/secrets/rotation-webhook.impl.test.ts` | URL validation, HMAC, timeout, SSRF | High |
| `apps/server/tests/integration/secrets/rotation-scheduler.impl.test.ts` | Claim lease, row-lock race, retry, duplicate scan, background-job gate | High |
| `apps/server/tests/integration/secrets/rotation-purge.impl.test.ts` | Purge removes notification rows; no orphans under a concurrent claim | High |
| `apps/web/tests/rotation-validation.impl.test.ts` | Interval bounds, generator length, date formatting, URL status fallback | High |
| `apps/cli/tests/rotation-generator.impl.test.ts` | 43-char value, `--out` mode/force/cleanup, no value in metadata | High |

### Integration tests

| Test | Components | Description |
|---|---|---|
| Policy and list | API + service + repository + PostgreSQL | Status boundaries and filters |
| Notification scan | Scheduler + service + repository + audit + webhook | Due-soon, overdue, retry, duplicate |
| Purge/dump | Purger + dump + PostgreSQL | New table integration |
| Generated contract | API generator + clients | `api:check` |

### End-to-end tests

The project has no browser automation dependency and the plan does not add one. The manual E2E check:

1. Start the review stack with the new build.
2. Create a secret and set a 30-day policy.
3. Confirm the Rotation page and secret card show the due date.
4. Use **Rotate now** with a manual value and with a generated value; confirm the version and due date.
5. Confirm the old version remains readable.
6. Configure a loopback webhook and a short warning window; run the scan; confirm one signed payload
   with no value.
7. Purge the secret and confirm no notification rows remain.
8. Confirm the docs state the restart requirement.

## Test Data

- Project `payments`; active secret `db-password` with a current version created 25 days ago.
- Due-soon secret `api-key`; overdue secret `smtp-password`; no-policy secret `feature-flag`.
- Reader/officer/admin actors from the existing RBAC fixtures.
- Fixed ULIDs for the notification and version rows.
- Injected clock for the status and scheduler tests.
- No real secret value in the webhook fixtures.

## Verification Checklist

- [ ] Every ST case has a concrete input and expected output.
- [ ] Every ST case traces to RD-01, a component spec, or an AR/PAR entry.
- [ ] Spec tests precede implementation in every phase.
- [ ] Red phase observed for every phase.
- [ ] Integration tests pass on PostgreSQL 16 and 17 in CI.
- [ ] The phase and final gates run `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm test:integration`;
      `pnpm --filter @openvault/server test` alone is not sufficient.
- [ ] `pnpm api:check` and `pnpm db:types:check` pass.
- [ ] `pnpm verify` passes.
- [ ] The generated migration, snapshot, and schema/role/view assertions are updated together.
- [ ] Axe covers the Rotation page and rotate dialog.
- [ ] No value appears in webhook, audit, logs, storage, URL, console, or CLI metadata tests.

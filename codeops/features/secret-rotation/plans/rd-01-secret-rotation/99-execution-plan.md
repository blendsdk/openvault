# Execution Plan: Secret Rotation Workflow

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-09
> **Progress**: 15/85 tasks (18%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the secret rotation workflow in seven spec-first phases: data/API, notifications, CLI, the
Rotation page, the secret-detail rotate flow, verification/accessibility, then documentation and
v1.2.0 metadata. Each phase writes its specification tests first, confirms red, implements, adds
implementation tests, and verifies. The plan does not tag or publish.

**🚨 Update this document after EACH completed task.**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Data model and API | 15 |
| 2 | Notifications, audit, and lifecycle | 19 |
| 3 | CLI | 8 |
| 4 | Web Rotation page and navigation | 11 |
| 5 | Web secret detail and rotate dialog | 10 |
| 6 | Verification and accessibility | 6 |
| 7 | Documentation and release metadata | 16 |

**Total: 85 tasks across 7 phases** (no fabricated hour estimates; scope is bounded by the
task-size criteria in the quality checklist)

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the single source of truth. Mark `[~]` with a timestamp while
> implementing, `[x]` when verification passes, and `[!]` with a reason when blocked. Update the
> Progress header and Last Updated stamp after every task. Resume at the first `[~]`, else the first
> `[ ]`.

---

## Phase 1: Data model and API

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: api-contract, database, security
> **Reasoning**: high — the metadata shape and status boundary feed every later phase.

### Step 1.1: Specification tests

**Reference**: [03-01](03-01-data-api.md) · ST-1..ST-10, ST-9a, ST-9b · AR-9, AR-10, AR-12, PAR-02, PAR-03
**Objective**: Pin the interval, status boundaries, metadata fields, list filters, consumer state, and
migration/schema invariants.

- [x] 1.1.1 [spec-author] Write policy/status/list/consumer-state spec tests — `apps/server/tests/integration/secrets/rotation-policy.spec.test.ts`
- [x] 1.1.2 [spec-author] Extend the migration/schema/role/view assertions for the new column and view state — `apps/server/tests/integration/migrations.spec.test.ts`, `apps/server/tests/integration/schema.spec.test.ts`, `apps/server/tests/integration/roles.spec.test.ts`, `apps/server/tests/integration/security/auth-boundary.spec.test.ts`
- [x] 1.1.3 Run the tests and confirm red

### Step 1.2: Implementation

**Reference**: [03-01](03-01-data-api.md) · AR-9, AR-10, AR-12, AR-24
**Objective**: Add the column, mapping, metadata, status computation, and list filter.

- [x] 1.2.1 Add `rotation_interval_days`, the partial index, and the consumer view `state` — `apps/server/src/database/schema.ts`
- [x] 1.2.2 Add the field and consumer state to `SECRET_COLUMNS`, `SecretRow`, `SecretRecord`, `ConsumerSummary`, `toSecret`, the consumer query, and the metadata update SQL — `apps/server/src/secrets/repository.ts`
- [x] 1.2.3 Add the rotation filter with a passed `now`/`warningDays`, the status computation, and the consumer state mapping — `apps/server/src/secrets/repository.ts`, `apps/server/src/secrets/service.ts`
- [x] 1.2.4 Add the metadata fields, PATCH field, list filter, and consumer state to the contract — `packages/api-contract/src/secrets.ts`
- [x] 1.2.5 Compute `rotationDueAt` and `rotationStatus` with a null-current-version guard; pass the configured warning days through `createSecretRuntime` with default 7 — `apps/server/src/secrets/service.ts`, `apps/server/src/secrets/runtime.ts`, `apps/server/src/app.ts`
- [x] 1.2.6 Update every secret-metadata fixture with the new required fields and consumer state — `packages/api-contract/tests/`, `apps/web/tests/helpers/fake-vault.ts`, `apps/cli/tests/helpers/fake-vault.ts`
- [x] 1.2.7 Generate the column/index migration and snapshot, add the reviewed manual view migration, and update migration/schema/role/view assertions — `apps/server/migrations/`, `apps/server/tests/integration/{migrations,schema,roles}.spec.test.ts`, `apps/server/tests/integration/security/auth-boundary.spec.test.ts`
- [x] 1.2.8 Run `pnpm api:generate` and `pnpm db:types`; review the generated contract and database types — `packages/api-contract/openapi.json`, `apps/cli/src/generated/`, `apps/web/src/generated/`, `apps/server/src/database/generated-types.ts`, `apps/server/src/database/ctypes.ts`
- [x] 1.2.9 Run the Phase 1 spec and integration tests and confirm green

### Step 1.3: Implementation tests and hardening

**Reference**: ST-1..ST-10, ST-9a, ST-9b · PAR-03
**Objective**: Cover boundaries, the policy filter, consumer state, migration, and generated drift.

- [x] 1.3.1 Add boundary tests at exactly the warning and due instants with a fixed clock — `apps/server/tests/integration/secrets/rotation-repository.impl.test.ts`
- [x] 1.3.2 Add a test for the `policy` filter, the no-policy default, and all three consumer states — `apps/server/tests/integration/secrets/rotation-policy.impl.test.ts`
- [x] 1.3.3 Run `pnpm --filter @openvault/server typecheck`, `pnpm api:check`, and `pnpm db:types:check`

**Deliverables**:
- [ ] Policy, status, metadata, filters, consumer state, and migration pass; generated clients and database types are current

**Verify**: `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm --filter @openvault/server test:integration && pnpm --filter @openvault/server test && pnpm --filter @openvault/server typecheck && pnpm api:check && pnpm db:types:check`; the integration suite is required, not optional.

---

## Phase 2: Notifications, audit, and lifecycle

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: security, scheduler, database
> **Reasoning**: high — durable claims, signed delivery, and lifecycle integration are security-sensitive.

### Step 2.1: Specification tests

**Reference**: [03-02](03-02-notifications.md) · ST-11..ST-22 · AR-13, AR-14, AR-15, AR-21, AR-23
**Objective**: Pin due-soon/overdue delivery, dedupe, retry, audit, purge, and config.

- [ ] 2.1.1 [spec-author] Write notification scan, webhook, days-boundary, and concurrency spec tests — `apps/server/tests/integration/secrets/rotation-notifications.spec.test.ts`
- [ ] 2.1.2 [spec-author] Write purge/dump/grant/config and migration-inventory spec tests — `apps/server/tests/integration/secrets/rotation-lifecycle.spec.test.ts`
- [ ] 2.1.3 Run the tests and confirm red

### Step 2.2: Implementation

**Reference**: [03-02](03-02-notifications.md) · AR-13, AR-14, AR-15, AR-21, AR-22, PAR-04, PAR-05, PAR-06, PAR-07, PAR-14
**Objective**: Add the table, scan, webhook, audit, config, scheduler, and lifecycle integration.

- [ ] 2.2.1 Add `secret_rotation_notifications` to the schema with the unique constraints (including `audit_event_id`), index, and two `ON DELETE CASCADE` foreign keys — `apps/server/src/database/schema.ts`
- [ ] 2.2.2 Implement the notification repository with row locks (`FOR SHARE OF s, p`), claim, lease, mark-sent, release, and a `(dueAt, secretId)` keyset — `apps/server/src/secrets/rotation/repository.ts`
- [ ] 2.2.3 Implement the scan service with due-soon/overdue thresholds, the `daysUntilDue` ceil/floor rule, retry, and audit — `apps/server/src/secrets/rotation/service.ts`
- [ ] 2.2.4 Implement the signed webhook with URL validation and HMAC — `apps/server/src/secrets/rotation/webhook.ts`
- [ ] 2.2.5 Implement the daily scheduler with the existing catch-up/next-run pattern — `apps/server/src/secrets/rotation/scheduler.ts`
- [ ] 2.2.6 Add the four config settings, validation, parameterized URL error path, and `rotationScanHour`/`rotationWarningDays`/`rotationWebhookConfigured` redaction — `apps/server/src/config/loader.ts`, `apps/server/src/config/types.ts`
- [ ] 2.2.7 Wire the scheduler into the app lifecycle under `disableBackgroundJobs !== true`; register the disposer — `apps/server/src/app.ts`
- [ ] 2.2.8 Add `secret.rotation_warning` to the audit action catalog and detail allowlist — `packages/api-contract/src/actions.ts`, `apps/server/src/audit/actions.ts`
- [ ] 2.2.9 Add the table to purge, dump, grants, and the purge test helper — `apps/server/src/purge/vault-purger.ts`, `apps/server/src/ops/database-dump.ts`, `deploy/postgres/grants.sql`, `apps/server/tests/integration/helpers/purger.ts`
- [ ] 2.2.10 Generate the Phase 2 migration (table, constraints, FKs) and snapshot; update the migration/schema/role/purger assertions and run `pnpm db:types` — `apps/server/migrations/`, `apps/server/tests/integration/{migrations,schema,roles}.spec.test.ts`, `apps/server/tests/integration/security/auth-boundary.spec.test.ts`
- [ ] 2.2.11 Run the Phase 2 spec and integration tests and confirm green

### Step 2.3: Implementation tests and hardening

**Reference**: ST-11..ST-22 · PAR-05, PAR-07
**Objective**: Prove the security and lifecycle edges.

- [ ] 2.3.1 Add webhook URL/HMAC/timeout/SSRF tests — `apps/server/tests/integration/secrets/rotation-webhook.impl.test.ts`
- [ ] 2.3.2 Add scheduler lease/retry/duplicate/background-job-gate tests — `apps/server/tests/integration/secrets/rotation-scheduler.impl.test.ts`
- [ ] 2.3.3 Add a purge test that asserts no orphan notification rows — `apps/server/tests/integration/secrets/rotation-purge.impl.test.ts`
- [ ] 2.3.4 Add a concurrent purge/claim and keyset-pagination test — `apps/server/tests/integration/secrets/rotation-scheduler.impl.test.ts`
- [ ] 2.3.5 Confirm the payload and audit event contain no value — notification tests

**Deliverables**:
- [ ] The scan, webhook, audit, purge, dump, and config pass their tests

**Verify**: `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm --filter @openvault/server test:integration && pnpm --filter @openvault/server test && pnpm --filter @openvault/server typecheck && pnpm db:types:check`

---

## Phase 3: CLI

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — a new command group reusing existing parser and file helpers.

### Step 3.1: Specification tests

**Reference**: [03-03](03-03-cli.md) · ST-23..ST-31 · AR-16, AR-17
**Objective**: Pin command parsing, API bodies, generator output, and file mode.

- [ ] 3.1.1 [spec-author] Write parser and command spec tests — `apps/cli/tests/rotation.spec.test.ts`
- [ ] 3.1.2 Run the tests and confirm red

### Step 3.2: Implementation

**Reference**: [03-03](03-03-cli.md) · AR-16, AR-17, PAR-08
**Objective**: Add the `ov rotation` group.

- [ ] 3.2.1 Implement `rotation set`, `clear`, `list`, and `status` — `apps/cli/src/commands/rotation.ts`
- [ ] 3.2.2 Implement `rotation rotate` with manual input, `--generate`, write-ahead `--out`/`--force` with cleanup on a failed write, expiry, and idempotency — `apps/cli/src/commands/rotation.ts`
- [ ] 3.2.3 Register the group in the root command list — `apps/cli/src/commands/index.ts`
- [ ] 3.2.4 Run the Phase 3 spec tests and confirm green

### Step 3.3: Implementation tests and hardening

**Reference**: ST-23..ST-31 · PAR-08
**Objective**: Cover the generator and secure output.

- [ ] 3.3.1 Add generator/output tests: 43 characters, mode `0600`, `--force`, failure cleanup, no value in metadata/errors — `apps/cli/tests/rotation-generator.impl.test.ts`
- [ ] 3.3.2 Confirm `--generate` conflicts with `--stdin`/`--from-file`, `--out` requires `--generate`, and `--due` conflicts with `--overdue`

**Deliverables**:
- [ ] All five commands and the generator pass; no value leaks

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

---

## Phase 4: Web Rotation page and navigation

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — a new page reusing the established list and filter patterns.

### Step 4.1: Specification tests

**Reference**: [03-04 §RotationPage](03-04-web-ui.md) · ST-32..ST-35, ST-41..ST-43 · AR-18, AR-19, AR-20
**Objective**: Pin the page, filters, empty states, badges, and navigation.

- [ ] 4.1.1 [spec-author] Write the Rotation page spec tests — `apps/web/tests/rotation-page.test.tsx`
- [ ] 4.1.2 [spec-author] Extend the shell and overview specs — `apps/web/tests/layout.test.tsx`, `apps/web/tests/projects.test.tsx`
- [ ] 4.1.3 Run the tests and confirm red

### Step 4.2: Implementation

**Reference**: [03-04 §RotationPage](03-04-web-ui.md) · AR-18, AR-19, PAR-09
**Objective**: Implement the page, route, navigation, docs mapping, list badge, and overview counts.

- [ ] 4.2.1 Implement the Rotation page with search, status filter, `?status=` initialization, table, pagination, and empty states — `apps/web/src/pages/rotation-page.tsx`
- [ ] 4.2.2 Add the route, section nav, launcher entry, and docs mapping — `apps/web/src/App.tsx`, `apps/web/src/projects/project-route.tsx`, `apps/web/src/layout/app-shell.tsx`, `apps/web/src/docs.ts`
- [ ] 4.2.3 Add the rotation status badge and Needs rotation link to the secrets list — `apps/web/src/pages/secrets-page.tsx`
- [ ] 4.2.4 Add due/overdue counts to the project overview — `apps/web/src/pages/project-overview-page.tsx`
- [ ] 4.2.5 Extend the web `FakeVault` with secret PATCH/PUT and rotation-query handling — `apps/web/tests/helpers/fake-vault.ts`
- [ ] 4.2.6 Run the Phase 4 spec tests and confirm green

### Step 4.3: Implementation tests and hardening

**Reference**: ST-32..ST-35, ST-41..ST-43 · PAR-11
**Objective**: Cover filters, pagination, and capability gating.

- [ ] 4.3.1 Add impl tests for filter reset, Load more, and a reader without `canWrite` — `apps/web/tests/rotation-page.impl.test.tsx`
- [ ] 4.3.2 Confirm the table scrolls at 768 px and the empty states are reachable

**Deliverables**:
- [ ] The page, nav, badge, and overview pass their tests

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 5: Web secret detail and rotate dialog

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Reasoning**: high — generated secrets and one-time reveal are security-sensitive.

### Step 5.1: Specification tests

**Reference**: [03-04 §Secret detail rotation card](03-04-web-ui.md) · ST-36..ST-40 · AR-5, AR-17, AR-6
**Objective**: Pin the card, policy dialog, rotate dialog, generator, and one-time reveal.

- [ ] 5.1.1 [spec-author] Write the detail card and policy dialog spec tests — `apps/web/tests/rotation-policy.test.tsx`
- [ ] 5.1.2 [spec-author] Write the rotate dialog and generator spec tests — `apps/web/tests/rotation-dialog.test.tsx`
- [ ] 5.1.3 Run the tests and confirm red

### Step 5.2: Implementation

**Reference**: [03-04 §Secret detail rotation card](03-04-web-ui.md) · AR-5, AR-17, PAR-10
**Objective**: Implement the card, dialogs, generator, and success state.

- [ ] 5.2.1 Add the rotation card with status, due, interval, last rotation, consumers (including state), null-current-version handling, and actions — `apps/web/src/pages/secret-detail-page.tsx`
- [ ] 5.2.2 Implement the policy dialog with set/clear and validation — `apps/web/src/components/rotation-policy-dialog.tsx`
- [ ] 5.2.3 Implement the rotate dialog with manual value, generator, copy, regenerate, expiry, success, and state clearing — `apps/web/src/components/rotation-dialog.tsx`
- [ ] 5.2.4 Add the base64url generator helper — `apps/web/src/validation.ts` or `apps/web/src/components/generated-value.ts`
- [ ] 5.2.5 Run the Phase 5 spec tests and confirm green

### Step 5.3: Implementation tests and hardening

**Reference**: ST-36..ST-40 · PAR-10
**Objective**: Prove the generated value never persists.

- [ ] 5.3.1 Add impl tests for close/unmount clearing, no storage, no URL, no console, and copy — `apps/web/tests/rotation-dialog.impl.test.tsx`
- [ ] 5.3.2 Confirm a failed write keeps the dialog open and the value in place

**Deliverables**:
- [ ] The card, policy dialog, rotate dialog, and generator pass their tests

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 6: Verification and accessibility

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — cross-cutting error and accessibility coverage.

### Step 6.1: Specification tests

**Reference**: [03-04 §Error handling](03-04-web-ui.md) · ST-44, ST-45 · AR-11, AR-12, AR-25
**Objective**: Pin error text and axe coverage.

- [ ] 6.1.1 [spec-author] Write error-mapping tests — `apps/web/tests/rotation-errors.test.tsx`
- [ ] 6.1.2 [spec-author] Add the Rotation page and dialog to the axe suite — `apps/web/tests/accessibility.test.tsx`
- [ ] 6.1.3 Run the tests and confirm red

### Step 6.2: Implementation and hardening

**Reference**: ST-44, ST-45 · PAR-15
**Objective**: Make the error and accessibility behavior pass.

- [ ] 6.2.1 Add the documented error mapping and fallbacks — `apps/web/src/pages/rotation-page.tsx`, dialogs
- [ ] 6.2.2 Fix labels, dialog focus, table caption, and status text issues found by axe
- [ ] 6.2.3 Run the web suite and confirm green

**Deliverables**:
- [ ] Error and axe tests pass

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 7: Documentation and release metadata

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — broad but mechanical docs and version alignment.

### Step 7.1: Documentation tests first

**Reference**: [03-05](03-05-docs-release.md) · ST-46..ST-51 · AR-26, PAR-13
**Objective**: Make the docs guard expect the new content and 1.2.0.

- [ ] 7.1.1 Update `tests/docs.spec.test.mjs` for 1.2.0 and rotation coverage — `tests/docs.spec.test.mjs`
- [ ] 7.1.2 Run the docs tests and confirm red

### Step 7.2: Documentation and version metadata

**Reference**: [03-05](03-05-docs-release.md) · AR-26, PAR-13, PAR-14
**Objective**: Make the reader docs and labels true.

- [ ] 7.2.1 Replace the short rotation section with the workflow — `docs/guide/rotation.md`
- [ ] 7.2.2 Add the rotation metadata and link to the secrets guide — `docs/guide/secrets.md`
- [ ] 7.2.3 Add the Rotation page/card, generated value, and restart note — `docs/guide/web-ui.md`
- [ ] 7.2.4 Add the CLI commands — `docs/guide/cli.md`, `docs/reference/cli.md`
- [ ] 7.2.5 Add the API fields/filter and the config env vars — `docs/reference/api.md`, `docs/reference/configuration.md`
- [ ] 7.2.6 Add the 1.2.0 changelog entry and versioning text — `docs/changelog.md`, `docs/guide/versioning.md`
- [ ] 7.2.7 Run the 1.2.0 release metadata checklist across packages, CLI, server, web, contract, Compose, examples, README, docs, GitHub templates, and tests; preserve historical release evidence — see [03-05 §Release metadata](03-05-docs-release.md)
- [ ] 7.2.8 Add the changeset and remove “Rotation wizards” from the web-ui out-of-scope list — `.changeset/secret-rotation.md`, `docs/guide/web-ui.md`
- [ ] 7.2.9 Run `pnpm api:generate` and `pnpm api:check`; review the generated diffs
- [ ] 7.2.10 Run the docs tests and confirm green

### Step 7.3: Final verification and handoff

**Reference**: [03-05 §Verification](03-05-docs-release.md) · PAR-17, PAR-18
**Objective**: Prove the full tree and hand off without publishing.

- [ ] 7.3.1 Run `pnpm verify` and the guarded integration suite; confirm both exit 0 — `pnpm verify && OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm test:integration && pnpm db:types:check`
- [ ] 7.3.2 Run the manual review-stack E2E sequence in [07-testing-strategy.md §End-to-end tests](07-testing-strategy.md)
- [ ] 7.3.3 Update the feature and portfolio roadmaps — `codeops/features/secret-rotation/00-roadmap.md`, `codeops/00-roadmap.md`
- [ ] 7.3.4 Confirm no tag, published image, GitHub release, or new dependency; remove temporary artifacts

**Deliverables**:
- [ ] Docs and labels state 1.2.0; `pnpm verify`, the integration suite, and `db:types:check` pass; the roadmap is current

**Verify**: `pnpm verify && OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm test:integration && pnpm db:types:check`

---

## Dependencies

```text
Phase 1 (data/API)
    ↓
Phase 2 (notifications)
    ↓
Phase 3 (CLI)
    ↓
Phase 4 (Rotation page)
    ↓
Phase 5 (detail/dialog)
    ↓
Phase 6 (verification)
    ↓
Phase 7 (docs/release)
```

## Success Criteria

1. ✅ All 85 tasks completed.
2. ✅ Every phase's spec tests were written before implementation and observed red.
3. ✅ `pnpm verify` passes and the guarded `pnpm test:integration` suite passes.
4. ✅ `pnpm api:check` and `pnpm db:types:check` report no drift.
5. ✅ The generated migration and snapshot are committed; the migration, schema, role, view, and purge assertions pass.
6. ✅ The Rotation page and rotate dialog pass the axe suite.
7. ✅ No generated value appears in storage, the URL, the console, logs, the webhook, or the audit event.
8. ✅ Purge and dump cover the notification table.
9. ✅ Consumer state is exposed through the extended summary and tested.
10. ✅ The reader docs describe the restart requirement and state 1.2.0.
11. ✅ No new dependency, service, queue, workflow engine, or generic notification framework exists.
12. ✅ No tag, image publication, or GitHub release was created by the plan.

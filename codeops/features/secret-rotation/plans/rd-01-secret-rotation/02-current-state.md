# Current State: Secret Rotation Workflow

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What exists

- Secrets are named objects with immutable encrypted versions and optional per-version `expiresAt`
  (`packages/api-contract/src/secrets.ts:1-180`).
- `PUT /v1/data/:project/secrets/:name` writes a new version; the previous version remains readable
  (`docs/guide/secrets.md`).
- The list route supports `q`, tag filters, limit, and cursor, and returns metadata with the current
  version (`apps/server/src/secrets/repository.ts`, `service.ts`).
- The web UI has a secret list and detail page; the detail page already has a **New version** panel
  (`apps/web/src/pages/secret-detail-page.tsx:475-500`).
- The CLI has `ov secret set`, `get`, `list`, `versions`, `delete`, `recover`, and `purge`
  (`apps/cli/src/commands/secret.ts`).
- The certificate-expiry feature has a durable notification table, a daily scheduler, and a signed
  metadata-only webhook (`apps/server/src/certificates/expiry/`). This is the pattern to mirror.
- Agent consumers expose Compose project/service, state, and `lastSeen` through
  `secretConsumerSummarySchema`; there is no per-secret version acknowledgement.

### Relevant files

| File | Purpose | Change |
|---|---|---|
| `packages/api-contract/src/secrets.ts` | Secret schemas | Add rotation metadata and list filter |
| `apps/server/src/database/schema.ts` | Desired schema | Add interval column and notification table |
| `apps/server/src/secrets/repository.ts` | Secret reads/writes | Map interval; list filters |
| `apps/server/src/secrets/service.ts` | Metadata and writes | Compute due/status; pass filter |
| `apps/server/src/secrets/rotation/*` | New notification service | Create |
| `apps/server/src/config/loader.ts` | Configuration | Add four env vars |
| `apps/server/src/config/types.ts` | Config type | Add rotation settings |
| `apps/server/src/app.ts` | Scheduler wiring | Start the rotation scan |
| `apps/server/src/audit/actions.ts` | Audit catalog | Add warning action and details |
| `apps/server/src/purge/vault-purger.ts` | Purge | Delete notification rows |
| `apps/server/src/ops/database-dump.ts` | Dump | Include the table |
| `deploy/postgres/grants.sql` | Role grants | Add the table |
| `apps/cli/src/commands/rotation.ts` | New CLI group | Create |
| `apps/cli/src/commands/index.ts` | Root groups | Register rotation |
| `apps/web/src/pages/rotation-page.tsx` | New page | Create |
| `apps/web/src/components/rotation-*.tsx` | New dialogs | Create |
| `apps/web/src/pages/secret-detail-page.tsx` | Detail card and rotate | Add card and dialog |
| `apps/web/src/pages/secrets-page.tsx` | List badge | Add status |
| `apps/web/src/pages/project-overview-page.tsx` | Counts | Add due/overdue |
| `apps/web/src/projects/project-route.tsx` | Section nav | Add Rotation |
| `apps/web/src/App.tsx` | Routes | Add Rotation |
| `apps/web/src/layout/app-shell.tsx` | Launcher | Add Rotation |
| `apps/web/src/docs.ts` | Docs link | Add Rotation |
| `apps/web/tests/*` | Tests | Extend FakeVault and add specs |
| `docs/*` | Reader docs | Update |
| `tests/docs.spec.test.mjs` | Docs guard | Update version/content |

### Code analysis

```text
Secret write path (today)
  PUT /v1/data/:project/secrets/:name
    → SecretService.writeValue
    → new secret_versions row
    → current_version_id moves
    → agent fetch returns the newest active version

Rotation policy (proposed)
  secrets.rotation_interval_days
    → dueAt = current_version.created_at + interval
    → status = ok | due_soon | overdue
    → a new PUT resets dueAt naturally
```

The current secret metadata does not include any rotation fields. The list query loads the current
version metadata, so the service can compute the due date without an additional query. The
certificate-expiry service already proves the notification pattern: a durable claim, a signed
webhook, an audit event, a one-hour lease, and a later retry.

The agent heartbeat currently sends only an aggregate `state` (`packages/api-contract/src/agents.ts`).
It does not report a version, which is why this plan limits consumer visibility to state and
`lastSeen`.

## Gaps Identified

### Gap 1: No policy or due date

**Current behavior:** a secret has no rotation interval; the UI shows only version creation and an
optional expiry.
**Required behavior:** an optional interval, a derived due date, and a live status.
**Fix required:** schema column, metadata fields, status computation.

### Gap 2: No due/overdue view or filters

**Current behavior:** every secret is listed the same; the operator must inspect dates manually.
**Required behavior:** a project Rotation page and `rotation=due|overdue` filters.
**Fix required:** list predicate, page, badges, overview counts.

### Gap 3: No guided rotate with a generated value

**Current behavior:** the secret detail has a bare "New version" panel; no generator.
**Required behavior:** a rotate action with manual or generated value and a one-time reveal.
**Fix required:** dialog, generator, CLI command.

### Gap 4: No reminders

**Current behavior:** no notification when a secret is due.
**Required behavior:** in-app status plus an optional signed webhook.
**Fix required:** notification table, scheduler, webhook, config, audit.

### Gap 5: No CLI policy commands

**Current behavior:** `ov secret set` writes a version but has no policy or due list.
**Required behavior:** `ov rotation set/clear/list/status/rotate`.
**Fix required:** new command group.

## Dependencies

### Internal dependencies

- Secret schema, repository, service, and audit.
- Web secret pages and generated client.
- CLI command framework and secure file writer.
- Certificate-expiry scheduler/webhook pattern.
- Purge and dump table lists.

### External dependencies

None. The feature adds no package.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The interval column changes the strict secret row mapping | Medium | Medium | Update all row columns and `toSecret` in one phase; integration tests |
| Due-date math crosses time zones or the clock | Medium | Medium | Use the server UTC clock and ISO timestamps; boundary tests |
| A webhook leaks a value | Low | High | Payload schema only has metadata; security tests assert no value |
| A duplicate scan sends repeated warnings | Medium | Medium | Unique `(secret, version, status)` plus a claim lease |
| Purge leaves orphan notification rows | Medium | Medium | Add the table to the purger allowlist and delete; purge test |
| The generated value is persisted or logged | Low | High | Component state only; copy button; tests assert no storage/console |
| Backups omit the new table | Low | Medium | Add it to the dump table list and dump test |
| The UI misstates application reload | Medium | Low | Explicit restart copy in the card, dialog, and docs |

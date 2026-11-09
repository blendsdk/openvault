# Secret Rotation Workflow Implementation Plan

> **Feature**: Per-secret rotation policy, due/overdue visibility, guided rotation, CLI parity, and optional signed reminders.
> **Status**: Planning Complete (preflight ready)
> **Created**: 2026-11-09 09:54
> **Implements**: secret-rotation/RD-01
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault already stores immutable secret versions and delivers the newest active version to agents.
This plan adds the missing operator workflow: a per-secret rotation interval, a derived due date,
live due-soon and overdue status, a project Rotation screen, a guided rotate action with an optional
generated value, `ov rotation` commands, and an optional signed webhook for reminders.

The server adds one nullable interval column, three metadata fields, a list filter, a dedicated
notification table, a daily scan that mirrors the certificate-expiry service, and a
`secret.rotation_warning` audit event. The web app adds a Rotation page, a secret-detail rotation
card, a list badge, and a rotate dialog with a local CSPRNG. The CLI adds a root `ov rotation` group.
The final phase updates the reader docs and the v1.2.0 release metadata. No new dependency, service,
queue, workflow engine, automatic rotation, external provider, or consumer version tracking is added.

## Minimum-Sufficient Baseline

**Original goal:** an operator can define a rotation policy, see what needs rotation, and rotate a
secret with a supplied or generated value from the UI or CLI.

**Smallest viable design:** one nullable interval column, derived due/status fields, a list filter,
a project Rotation page, a rotate dialog, an `ov rotation` group, and a focused daily notification
service that mirrors the existing certificate-expiry pattern.

**Excluded machinery:** no new dependency, workflow engine, queue, generic notification framework,
automatic rotation, external provider integration, version-level consumer tracking, or old-version
deletion.

**Approved complexity:** None. The Complexity Escalation Gate did not fire.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Plan Ambiguity Register](00-ambiguity-register.md) | Plan-local decisions; inherits the requirements register |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements Delta](01-requirements.md) | Thin view of RD-01 and plan-local scope |
| 02 | [Current State](02-current-state.md) | Existing secret model, UI, CLI, and expiry pattern |
| 03-01 | [Data and API](03-01-data-api.md) | Column, metadata, list filter, contract |
| 03-02 | [Notifications](03-02-notifications.md) | Table, scan, webhook, audit, purge/dump |
| 03-03 | [CLI](03-03-cli.md) | `ov rotation` commands and generator |
| 03-04 | [Web UI](03-04-web-ui.md) | Rotation page, card, dialogs, navigation |
| 03-05 | [Docs and Release](03-05-docs-release.md) | Reader docs and v1.2.0 metadata |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification tests and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, task checklist |

## Quick Reference

```text
/projects/payments/rotation
  Search: Name
  Status: All | Due | Overdue
  Rows: db-password | due_soon | 2026-12-09 | every 30 days | rotated 2026-11-09 | 2 consumers

/projects/payments/secrets/db-password
  Rotation: every 30 days | due 2026-12-09 | due soon | last rotated 2026-11-09
  [Set policy] [Rotate now]
```

```bash
ov rotation set db-password --every-days 30 --project payments
ov rotation list --due --project payments
ov rotation rotate db-password --generate --out /secure/db-password --project payments
```

### Key Decisions

| Decision | Outcome | Ref |
|---|---|---|
| Feature location | `codeops/features/secret-rotation/`, RD-01 | AR-1 |
| Rotation model | Policy + reminders + guided rotation | AR-2 |
| Consumer tracking | Visibility only | AR-3 |
| Notifications | In-app + optional signed webhook | AR-4 |
| New values | Manual + optional generator | AR-5 |
| Old versions | Keep history | AR-6 |
| Release | v1.2.0, UI + CLI | AR-7 |
| Due model | Interval from current version | AR-9 |
| Authorization | Reuse `secret.write` | AR-11 |
| Transport | Existing generated client | AR-12 |
| Notifications | Mirror certificate expiry | AR-13 |
| Complexity | Reuse only | AR-27 |

## Specialist Agents

**None** — the capability-gap check found no recurring project-specific invariant beyond the
existing secret, certificate-expiry, CLI, and web patterns. The repository has no specialist
briefs, and a dynamic packet covers this work.

_Detection evidence: `codeops/specialists/` is absent; the work reuses
`apps/server/src/certificates/expiry/`, `apps/server/src/secrets/`, and `apps/web/src/pages/`; no
isolated large-context migration or protocol invariant is present._

## Related Files

**Server and contract**

- `packages/api-contract/src/secrets.ts`
- `apps/server/src/database/schema.ts`
- `apps/server/migrations/*` (generated migration and snapshot)
- `apps/server/src/database/generated-types.ts`, `apps/server/src/database/ctypes.ts`
- `apps/server/src/secrets/repository.ts`
- `apps/server/src/secrets/service.ts`
- `apps/server/src/secrets/runtime.ts`
- `apps/server/src/secrets/rotation/*` (new)
- `apps/server/src/config/loader.ts`
- `apps/server/src/config/types.ts`
- `apps/server/src/app.ts`
- `apps/server/src/audit/actions.ts`
- `apps/server/src/purge/vault-purger.ts`
- `apps/server/src/ops/database-dump.ts`
- `deploy/postgres/grants.sql`
- `packages/api-contract/openapi.json`
- `apps/web/src/generated/*`

**CLI**

- `apps/cli/src/commands/rotation.ts` (new)
- `apps/cli/src/commands/index.ts`
- `docs/reference/cli.md`
- `docs/guide/cli.md`
- `docs/guide/rotation.md`

**Web**

- `apps/web/src/pages/rotation-page.tsx` (new)
- `apps/web/src/components/rotation-policy-dialog.tsx` (new)
- `apps/web/src/components/rotation-dialog.tsx` (new)
- `apps/web/src/pages/secret-detail-page.tsx`
- `apps/web/src/pages/secrets-page.tsx`
- `apps/web/src/pages/project-overview-page.tsx`
- `apps/web/src/projects/project-route.tsx`
- `apps/web/src/layout/app-shell.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/docs.ts`
- `apps/web/tests/*`
- `apps/server/tests/integration/secrets/*` (new)
- `apps/server/tests/integration/{migrations,schema,roles}.spec.test.ts`
- `apps/server/tests/integration/security/auth-boundary.spec.test.ts`
- `apps/server/tests/integration/helpers/purger.ts`
- `apps/cli/tests/*`

**Docs and release**

- `docs/guide/rotation.md`
- `docs/guide/secrets.md`
- `docs/guide/web-ui.md`
- `docs/reference/api.md`
- `docs/reference/configuration.md`
- `docs/changelog.md`
- `docs/guide/versioning.md`
- `docs/index.md`
- `README.md`
- `tests/docs.spec.test.mjs`
- `codeops/features/secret-rotation/00-roadmap.md`
- `codeops/00-roadmap.md`

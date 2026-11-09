# Data and API: Secret Rotation Workflow

> **Document**: 03-01-data-api.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the rotation policy data, metadata response, list filter, and status
computation. It does not own the notification scheduler or the web/CLI surfaces.

## Architecture

### Current architecture

- `secrets` has `id`, `project_id`, `name`, `tags`, `content_type`, `current_version_id`,
  `purge_protected`, timestamps, `deleted_at`, and `purge_after`
  (`apps/server/src/database/schema.ts:296-322`).
- `secret_versions` has `created_at` and optional `expires_at`.
- `SecretRepository.listActiveSecrets` joins the current version and returns metadata.
- `SecretService.list` authorizes `secret.list`, loads a page, computes capabilities, and builds
  metadata.
- `secretMetadataSchema` has tags, content type, current version, lifecycle, consumers, and
  capabilities (`packages/api-contract/src/secrets.ts:67-83`).

### Proposed changes

```text
database/schema.ts          + rotation_interval_days; consumer view state
migrations/*.up.sql         generated migration; schema.snapshot.json updated
secrets/repository.ts       + column mapping; rotation filter; consumer state
secrets/service.ts          + due/status computation; consumer state
secrets/runtime.ts          + warning-days option
api-contract/secrets.ts     + metadata fields; PATCH field; list filter; consumer state
api-contract/openapi.json   regenerated
database/generated-types.ts and ctypes.ts regenerated
```

The schema change is not complete when `schema.ts` changes. The applied DDL is generated into
`apps/server/migrations/` and recorded in `apps/server/migrations/schema.snapshot.json`; integration
databases are created from those migrations. The migration must be generated with the existing
`blendsdk/codegen` `generateMigration` API and the existing `apps/server/blendsdk.migrations.ts`
configuration. [PF-001, PF-013]

## Implementation Details

### Schema

```ts
secrets
  .integer("rotation_interval_days")
  .nullable()
  .check("rotation_interval_days BETWEEN 1 AND 3650");
secrets
  .index()
  .indexName("secrets_rotation_idx")
  .column("rotation_interval_days")
  .where("rotation_interval_days IS NOT NULL");
```

The due date is derived; no new date column. The partial index narrows the `policy` filter and the
scan's candidate set; it does not serve the computed `created_at + interval` range, which is evaluated
from the joined current version. [AR-9, PAR-02, PF-016]

Add `state` to the definer view `secret_consumer_summaries` after `compose_service`. The raw
`consumers.state` column already stores `ok | degraded | failed`; the view is the only missing piece.
[PF-002]

### Repository

Add `rotation_interval_days` to `SECRET_COLUMNS`, `SecretRow`, `SecretRecord`, and `toSecret`:

```ts
readonly rotationIntervalDays: number | null;
```

`SecretRepository.updateMetadata` also accepts `rotationIntervalDays` and writes it in the same
`UPDATE` as tags, content type, and purge protection. A `null` clears the policy. The service passes
the existing value when the field is omitted and the provided value, including `null`, when it is
supplied. [PAR-02]

`listActiveSecrets` filters gains `rotation?: "policy" | "due" | "overdue"`, `warningDays: number`, and
`now: Date`. The SQL adds:

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

The service passes one `now` value into the repository and uses the same value for the response
status. Do not use the database `now()` here; the injected service clock is the product clock and
the filter/status boundaries must agree. The cursor/name ordering and tag/name filters are
unchanged. [AR-12, AR-19, PAR-03, PF-006]

`SecretRepository.listConsumers` and the `ConsumerSummary` row type gain `state`, selected from the
view and mapped to the public summary. [PF-002]

### Metadata schema

`secretMetadataSchema` gains:

```ts
rotationIntervalDays: z.number().int().min(1).max(3650).nullable(),
rotationDueAt: z.iso.datetime().nullable(),
rotationStatus: z.enum(["ok", "due_soon", "overdue"]).nullable(),
```

`secretMetadataUpdateRequestSchema` gains:

```ts
rotationIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
```

The existing `refine` includes the new field. `secretCreateRequestSchema` is unchanged; a policy is
set through PATCH after creation. [AR-12, PAR-02]

`secretConsumerSummarySchema` gains:

```ts
state: z.enum(["ok", "degraded", "failed"]),
```

This is the existing `consumers.state` value exposed through the definer view. It is additive and
display-only. [AR-3, AR-20, PF-002]

### Status computation

Add a small pure helper, for example `rotationState(dueAt, now, warningDays)`:

```ts
if (dueAt === null) return null;
if (now >= dueAt) return "overdue";
if (now >= dueAt - warningDays * DAY_MS) return "due_soon";
return "ok";
```

`SecretService.#metadata` (or a shared helper) computes:

```ts
const dueAt =
  secret.rotationIntervalDays === null || currentVersion === null
    ? null
    : new Date(currentVersion.createdAt.getTime() + secret.rotationIntervalDays * DAY_MS);
const rotationStatus = rotationState(dueAt, this.#now(), this.#warningDays);
```

The null guard is required because `currentVersion` is typed as nullable even though normal writes
keep a current version. A policy secret without a current version has `rotationDueAt: null` and
`rotationStatus: null`.

The service receives `rotationWarningDays` from configuration. The value flows through
`createSecretRuntime` in `apps/server/src/secrets/runtime.ts`; `app.ts` passes it into the runtime.
The option is `rotationWarningDays?: number` with a default of 7 so existing direct `new SecretService`
test constructors keep working. The same value is used by the notification scan. The response fields
are included in list, create, write, recover, and detail metadata responses because they all use
`secretMetadataSchema`. [AR-9, AR-10, PAR-03, PF-009]

### List query

`secretListQuerySchema` gains one optional filter:

```ts
rotation: z.enum(["policy", "due", "overdue"]).optional(),
```

- `policy`: secrets with any policy.
- `due`: due-soon or overdue.
- `overdue`: overdue only.

The Rotation page defaults to `policy`; the "Needs attention" filter uses `due`; "Overdue" uses
`overdue`. The normal secrets list omits the filter. There is no `rotation=all`. [AR-19, PAR-03]

### Errors

| Case | Response | Ref |
|---|---|---|
| Interval 0, negative, >3650, or non-integer | 422 `validation_error` | AR-9 |
| Invalid `rotation` value | 422 `validation_error` | AR-12 |
| Caller lacks `secret.write` on PATCH | Existing 403/404 behavior | AR-11 |
| Caller lacks `secret.list` | Existing project-not-found behavior | AR-11 |

### Contract generation

Update the schemas and run `pnpm api:generate`. The list query and metadata types appear in the CLI
and browser generated clients. No new route is added. `pnpm api:check` must report no drift.
[AR-12, AR-24]

## Testing Requirements

- Schema tests for the interval bounds and the rotation filter enum.
- Repository integration tests for `policy`, `due`, and `overdue`, including the boundary at
  `now == dueAt` and `now == dueAt - warningDays` with a fixed injected clock.
- Metadata tests for a null policy, no current version, and each status.
- Consumer-summary tests for all three states through the view and through secret metadata.
- Migration and schema tests: the generated migration applies, the ledger count and table inventory
  are current, the foreign keys exist, and the role/view/purge grants are present. Update
  `apps/server/tests/integration/migrations.spec.test.ts`,
  `apps/server/tests/integration/schema.spec.test.ts`,
  `apps/server/tests/integration/roles.spec.test.ts`,
  `apps/server/tests/integration/security/auth-boundary.spec.test.ts`, and
  `apps/server/tests/integration/helpers/purger.ts`.
- `pnpm api:check` for generated types, `pnpm db:types:check` for generated database types, and the
  integration suite for the database behavior.
- No test requires a new service. [AR-25, PAR-11, PAR-03, PF-001, PF-002, PF-013]

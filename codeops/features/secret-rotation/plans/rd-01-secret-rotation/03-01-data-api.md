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
database/schema.ts          + rotation_interval_days
secrets/repository.ts       + column mapping; rotation filter
secrets/service.ts          + due/status computation
api-contract/secrets.ts     + metadata fields; PATCH field; list filter
api-contract/openapi.json   regenerated
```

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

The due date is derived; no new date column. [AR-9, PAR-02]

### Repository

Add `rotation_interval_days` to `SECRET_COLUMNS`, `SecretRow`, `SecretRecord`, and `toSecret`:

```ts
readonly rotationIntervalDays: number | null;
```

`SecretRepository.updateMetadata` also accepts `rotationIntervalDays` and writes it in the same
`UPDATE` as tags, content type, and purge protection. A `null` clears the policy. The service passes
the existing value when the field is omitted and the provided value, including `null`, when it is
supplied. [PAR-02]

`listActiveSecrets` filters gains `rotation?: "due" | "overdue"` and `warningDays: number`. The SQL
adds:

```sql
-- due
s.rotation_interval_days IS NOT NULL
AND v.created_at + make_interval(days => s.rotation_interval_days)
    <= now() + make_interval(days => :warningDays)

-- overdue
s.rotation_interval_days IS NOT NULL
AND v.created_at + make_interval(days => s.rotation_interval_days) <= now()
```

Use the database clock for the filter; the service uses the same injected clock for the response.
The cursor/name ordering and tag/name filters are unchanged. [AR-12, AR-19, PAR-03]

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
  secret.rotationIntervalDays === null
    ? null
    : new Date(currentVersion.createdAt.getTime() + secret.rotationIntervalDays * DAY_MS);
const rotationStatus = rotationState(dueAt, this.#now(), this.#warningDays);
```

The service receives `rotationWarningDays` from configuration; `app.ts` passes the validated value
into the service options. The same value is used by the notification scan. The response fields are
included in list, create, write, recover, and detail metadata responses because they all use
`secretMetadataSchema`. [AR-9, AR-10, PAR-03]

### List query

`secretListQuerySchema` gains:

```ts
rotation: z.enum(["due", "overdue"]).optional(),
```

No `rotation=all`; the Rotation page simply lists all policy secrets by requesting the normal list
and filtering client-side? **No:** the Rotation page should request `rotation=due` for the due view
and the normal list for all policy secrets. To list "all policy secrets" without a filter, the server
needs a way to exclude non-policy secrets. Add a third value:

```ts
rotation: z.enum(["policy", "due", "overdue"]).optional(),
```

- `policy`: secrets with any policy.
- `due`: due-soon or overdue.
- `overdue`: overdue only.

The Rotation page defaults to `policy`; the "Needs attention" filter uses `due`; "Overdue" uses
`overdue`. The normal secrets list omits the filter. [AR-19, PAR-03]

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
  `now == dueAt` and `now == dueAt - warningDays`.
- Metadata tests for null policy and each status.
- `pnpm api:check` for generated types.
- No test requires a new service. [AR-25, PAR-11, PAR-03]

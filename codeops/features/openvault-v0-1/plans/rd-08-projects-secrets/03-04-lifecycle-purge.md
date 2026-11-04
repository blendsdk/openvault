# Lifecycle and Purge: RD-08 Projects and Secrets

> **Document**: 03-04-lifecycle-purge.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns metadata updates, soft delete, recovery, purge protection, optional version
expiry, the controlled purge path, and the data-plane limiter. It also owns the
`OPENVAULT_PURGE_DB_URL` configuration and the release precondition for the one-way AAD change.

**Governing decisions:** AR-8, AR-9, AR-12, AR-13, AR-14, AR-17, AR-18, AR-19, AR-22, AR-25,
AR-26, AR-28, AR-29, AR-30, AR-32.

## Architecture

### Current Architecture

`secrets` has `deleted_at`, `purge_after`, and `purge_protected`. The database trigger rejects
version and parent deletes unless the session user is `openvault_purger`, the transaction sets
`openvault.allow_purge='on'`, the parent is deleted, `purge_after <= now()`, and protection is
off. The trigger also rejects disabling protection. Configuration has
`OPENVAULT_SOFT_DELETE_DAYS` (7–90, default 30) and `OPENVAULT_SECRET_MAX_BYTES`.

### Proposed Changes

```text
PATCH  /v1/data/:project/secrets/:name           secret.write
DELETE /v1/data/:project/secrets/:name           secret.delete
POST   /v1/data/:project/secrets/:name/recover   secret.recover
POST   /v1/data/:project/secrets/:name/purge     secret.purge
```

Add optional `OPENVAULT_PURGE_DB_URL`, a dedicated purge pool, and a `SecretPurger` guard. Set
the value-size cap to 65,536 in the loader. Raise the `express.json` hard parser limit to
`1mb` (it is currently `128kb`) and apply per-path limits in the content-length guard and the
`verify` callback: `/v1/secrets` 65,536, `/v1/data` 524,288, all other routes 131,072. Update
the `BODY_LIMIT` test if the WebAFX setting still advertises `128kb`. The decoded-byte check
remains authoritative (AR-25).

## Implementation Details

### Metadata Update (PATCH)

1. Resolve the active project and active secret; authorize `secret.write` with audit disabled.
2. In one transaction (chain lock, project share lock, name advisory lock, secret row lock):
   - if `purgeProtected === true`, set it;
   - if `purgeProtected === false`:
     - when the stored value is true, throw `purge_protection_locked` (409);
     - when it is already false, treat it as a no-op;
   - replace `tags` and/or `contentType` when supplied;
   - set `updated_at`;
   - write one joined allow outcome.
3. Return the metadata. No version row is created (RD-08).

A failure after authorization writes one independent error outcome and no allow event (AR-17,
AR-32).

### Soft Delete

1. Resolve the active project and active secret; authorize `secret.delete` with audit disabled.
2. In one transaction: chain lock, project share lock, name advisory lock, secret row lock,
   then `UPDATE secrets SET deleted_at = now(), purge_after =
   now() + make_interval(days => :retentionDays), updated_at = now() WHERE id = :id AND
   deleted_at IS NULL RETURNING ...`.
3. If no row is returned (concurrent delete), the transaction rolls back; the service writes
   one error outcome and returns 404 `secret_not_found`.
4. Write one joined allow outcome on success and return 204.

The retention value is `config.softDeleteDays`. Both stored timestamps use the database clock
(AR-13); the service clock is used only for the audit event.

### Recovery

1. Resolve the active project and the secret by name including deleted rows. A name is
   reserved until purge, so there is exactly one row (AR-19/AR-29).
2. Authorize `secret.recover` on the secret with audit disabled.
3. In one transaction: chain lock, project share lock, name advisory lock, then
   `UPDATE secrets SET deleted_at = NULL, purge_after = NULL, updated_at = now()
   WHERE id = :id AND deleted_at IS NOT NULL AND purge_after > now() RETURNING ...`.
4. If no row is returned, re-read the row, write one independent error outcome, and map:
   - not deleted -> 409 `secret_not_deleted`;
   - `purge_after <= now()` -> 409 `secret_not_recoverable`;
   - missing -> 404 `secret_not_found`.
5. Write one joined allow outcome only when the update succeeds and return the metadata with
   `status: "active"`.

### Purge Protection

Protection can be enabled only while the secret is active (AR-13). A `false` value when already
false is a no-op; a `false` value when true is 409 `purge_protection_locked`. There is no
protection path for a deleted secret; an operator must enable it before deleting. The database
trigger remains the final defense. A protected deleted secret can never be purged, so its name
stays reserved forever (AR-19); the operator can recover it within retention or use a new name.

### Version Expiry

A version is active when `expires_at IS NULL` or `expires_at > now()`. `GET` without a version
returns the newest active version, falling back past an expired current version (AR-8). If no
version is active, the read returns 410 `secret_expired` and writes an error outcome. A named
expired version also returns 410. The version list reports `active`/`expired` and
`isCurrent`. Active versions count toward the 1,000 limit (AR-12); expired versions do not.

### Purge

1. Resolve the active project and the secret by name including deleted rows.
2. Require `deleted_at IS NOT NULL` -> otherwise 409 `secret_not_deleted`.
3. Require `purge_protected = false` -> otherwise 409 `purge_protection_locked`.
4. Require `purge_after <= now()` -> otherwise 409 `secret_retention_active`.
5. Authorize `secret.purge` with audit disabled. A denial writes one deny and throws 403/404.
6. Call `SecretPurger.delete(secretId, projectId)`:
   - open the configured pool; absent -> 503;
   - on every call verify `current_database()` equals `config.database.database`;
   - verify `session_user = 'openvault_purger'`;
   - verify the role is not a superuser;
   - verify it is not a member of either table owner role and not a member of any superuser
     role;
   - take the same `(project_id,name)` advisory lock on the purger connection;
   - in the purger transaction, `SELECT 1 FROM projects WHERE id=:projectId AND
     deleted_at IS NULL FOR SHARE`, so a concurrent project delete serializes;
   - count the retained versions, then `SET LOCAL openvault.allow_purge='on'`, delete
     `secret_versions`, then delete `secrets`;
   - require the version count and parent row count to match expectations.
7. Write exactly one outcome event after the destructive transaction: allow on success, or
   error with `{ reason: "purge_failed" }` on failure. Return 204 on success. Map a failure to
   503 or the re-read state (409/404).

The outcome event and the destructive transaction cannot share a connection because the
trigger requires a different session user. A crash between the delete and the event leaves the
deletion without evidence; this is the recorded residual risk of the dedicated-session purge
(AR-17, AR-32). A concurrent recovery or protection change makes the purge transaction fail;
the service re-reads the row and maps to `secret_not_deleted` or
`purge_protection_locked`.

### Purge Configuration

`config.purgeDatabaseUrl` is read from `OPENVAULT_PURGE_DB_URL` when present and non-empty as a
raw string and is not included in the redacted config. It is parsed lazily when the purge pool
is first used, not at boot, so an invalid value leaves the server bootable and makes only purge
return 503. The pool uses `poolConfig: { max: 1, idleTimeoutMillis: 100 }` and
`enableGracefulShutdown: false`. The app registers it as a singleton for disposal. The guard is
re-evaluated on every purge; it is not cached (AR-28).

The test helper provisions `openvault_purger` with `SELECT` on `projects` and `SELECT, DELETE`
on `secrets` and `secret_versions`. It returns `undefined` when the maintenance user is not a
superuser, so the role-dependent tests can `skipIf`; CI is superuser and must run the success
case. It throws only for an unsafe database name.

### Data-Plane Rate Limit

One limiter at 600 requests per minute is mounted on `/v1/data` after authentication and before
the controllers. The key is `req.agent?.principalId ?? req.auth?.user.id`. A test-only override
changes the threshold. The limiter applies to the agent value read too (AR-18).

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Empty metadata update | 422 `validation_error` | AR-9 |
| Disable protection when true | 409 `purge_protection_locked` | AR-13 |
| Delete an already deleted secret | 404 `secret_not_found` | AR-2 |
| Recover an active secret | 409 `secret_not_deleted` | AR-13 |
| Recover after retention | 409 `secret_not_recoverable` | AR-13 |
| Purge before retention | 409 `secret_retention_active` | AR-13 |
| Purge a protected secret | 409 `purge_protection_locked` | AR-13 |
| Purge without a configured pool | 503 `service_unavailable` | AR-14 |
| Wrong database/session/privileged role | 503 `service_unavailable` | AR-28 |
| Delete count mismatch | 503 `service_unavailable` | AR-14 |
| No active version | 410 `secret_expired`; one error outcome | AR-8, AR-32 |
| Rate limit | 429 `RATE_LIMIT_EXCEEDED` | AR-18 |

## Integration Points

- `apps/server/src/config/{types,loader,redact}.ts` add the optional purge URL and clamp the
  value limit.
- `apps/server/src/transport/pre-stack.ts` adds the data body guard.
- `apps/server/src/app.ts` composes the purge pool, data runtime, services, controllers, and
  disposal.
- RD-13 provisions the production role and documents backup/recovery.
- The audit `secret.purge` action and policy details already exist in RD-07.

## Testing Requirements

- Specification tests for metadata update, delete, recovery, retention boundary, protection,
  purge, expiry, and purge configuration.
- Implementation tests for the purge role/database guards, transaction failure cleanup, name
  reservation, and a full purge followed by a new secret with the same name.
- A live test that the application role still cannot delete protected rows.

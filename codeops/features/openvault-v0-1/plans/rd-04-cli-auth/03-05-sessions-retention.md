# Sessions, Revocation, and Retention: RD-04 CLI Authentication

> **Document**: 03-05-sessions-retention.md
> **Parent**: [Index](00-index.md)
> **References**: [AR-7](00-ambiguity-register.md#ar-7--password-change-revocation), [AR-9](00-ambiguity-register.md#ar-9--family-management), [AR-11](00-ambiguity-register.md#ar-11--retention), [AR-19](00-ambiguity-register.md#ar-19--family-list-semantics), [AR-20](00-ambiguity-register.md#ar-20--cli-session-route-authentication), [AR-24](00-ambiguity-register.md#ar-24--cleanup-bounds), [AR-31](00-ambiguity-register.md#ar-31--malformed-family-id), [AR-33](00-ambiguity-register.md#ar-33--loginpassword-change-serialization), [AR-34](00-ambiguity-register.md#ar-34--family-delete-serialization)

## Overview

This component provides the management and lifecycle edges of a CLI family: list, revoke,
password-change revocation, and retention cleanup. The list is family-scoped and never exposes a
hash or row id. Password change revokes every CLI family in the same transaction as the password
update, under the same principal lock as refresh. Cleanup keeps rows for 30 days after the later
of expiry and revocation, then deletes a bounded batch.

## Architecture

### Current architecture

The browser controller lists and revokes browser sessions through `SessionService`
(`apps/server/src/controllers/auth.ts:285-314`). Password change updates the credential and then
revokes other browser sessions, but does not touch `cli_sessions`
(`apps/server/src/controllers/auth.ts:198-236`). `CredentialsRepository.changePassword` runs
outside a transaction (`apps/server/src/auth/credentials.ts:235-252`). There is no cleanup
timer or CLI family query.

### Proposed changes

1. Add family list/revoke queries to `CliSessionRepository`.
2. Add CLI family routes to `CliAuthController`.
3. Add transaction-aware password update and CLI-family revocation.
4. Add `CliSessionMaintenanceService` with startup and 24-hour cleanup.
5. Add `bootstrapAuthRuntime(app)` and call it from `main.ts`.
6. Register the maintenance service for disposal.

## Implementation Details

### Family list

`GET /v1/auth/cli/sessions` requires a CLI context and returns:

```json
{
  "sessions": [
    {
      "id": "01J...",
      "createdAt": "2026-10-31T12:00:00.000Z",
      "expiresAt": "2026-11-01T00:00:00.000Z",
      "current": true
    }
  ]
}
```

Query:

```sql
SELECT family_id,
       MIN(created_at) AS created_at,
       MIN(expires_at) AS expires_at
  FROM cli_sessions
 WHERE principal_id = :principalId
   AND revoked_at IS NULL
   AND expires_at > now()
 GROUP BY family_id
 ORDER BY MIN(created_at) DESC
```

`current` is true when `family_id` equals `req.auth.familyId`. The response never includes
`refresh_hash`, `id` row ids, IP, or user-agent. A family with only expired or revoked rows is
not listed.

### Family revoke

`DELETE /v1/auth/cli/sessions/:familyId` requires a CLI context.

- If `:familyId` is not a ULID, return `404 session_not_found` without a database query.
- Otherwise run one transaction:
  1. Lock the principal row (`SELECT id FROM principals WHERE id = :principalId FOR UPDATE`).
     This is the same first lock as refresh, logout, password change, and CLI login, so a
     replacement refresh row cannot be inserted after the delete's update.
  2. Update every live row in the family with the ownership predicate:

```sql
UPDATE cli_sessions
   SET revoked_at = now()
 WHERE family_id = :familyId
   AND principal_id = :principalId
   AND revoked_at IS NULL
   AND expires_at > now()
RETURNING id
```

- If no row is updated, return `404 session_not_found`. This covers an unknown family, another
  principal's family, an already-revoked family, and an expired family. Use
  `new ApiError(404, "session_not_found", "Session not found")`; the generic `NotFoundError`
  emits `NOT_FOUND`, which does not satisfy the contract.
- On success, return 204.
- The caller may revoke its own current family. Its next bearer request then fails the live-family
  check.

### Password-change transaction

The browser password-change handler becomes:

1. Verify the current password outside the transaction.
2. Validate the new password and hash it.
3. Run one transaction:

```ts
await database.withTransaction(async (tx) => {
  // Same first lock as CLI refresh.
  await tx.executeQuery("SELECT id FROM principals WHERE id = :principalId FOR UPDATE", {
    principalId,
  });

  const updated = await credentials.changePassword(
    principalId,
    passwordHash,
    expectedHash,
    tx,
  );
  if (!updated) {
    return false;
  }

  await cliSessions.revokeAllForPrincipal(tx, principalId);
  return true;
});
```

4. If `updated` is false, throw `401 invalid_credentials`; no session or CLI family was changed.
5. Revoke the other browser sessions and rotate the current browser session as before.

`CredentialsRepository.changePassword` accepts an optional query database:

```ts
changePassword(
  principalId: string,
  passwordHash: string,
  expectedHash: string,
  database: QueryDatabase = this.#database,
): Promise<boolean>;
```

`CliSessionRepository.revokeAllForPrincipal(database, principalId)` runs:

```sql
UPDATE cli_sessions
   SET revoked_at = now()
 WHERE principal_id = :principalId
   AND revoked_at IS NULL
```

The update is part of the password transaction, so it rolls back with a failed password update.
Because every bearer request checks a live family row, old access tokens fail immediately after
commit. A concurrent refresh either waits for the password lock and then sees revoked rows, or
commits first and is revoked by this update. CLI login takes the same principal lock through
family insertion (AR-33), so it either finishes before the password transaction and is revoked
by it, or waits and fails its hash recheck without creating a family.

### Retention and maintenance

`CliSessionRepository.cleanup(batchSize)` deletes one bounded batch:

```sql
DELETE FROM cli_sessions
 WHERE id IN (
   SELECT id
     FROM cli_sessions
    WHERE GREATEST(expires_at, COALESCE(revoked_at, expires_at)) < now() - interval '30 days'
    ORDER BY GREATEST(expires_at, COALESCE(revoked_at, expires_at))
    LIMIT :batchSize
 )
RETURNING id
```

- A row is retained for 30 days after the later of expiry and revocation.
- The predicate requires the row to be expired for more than 30 days, so a usable live row is
  never selected.
- The `cli_sessions_cleanup_idx` expression index supports the predicate.
- One batch of 1,000 rows is deleted per run.

`CliSessionMaintenanceService`:

```ts
export class CliSessionMaintenanceService {
  constructor(options: {
    repository: CliSessionRepository;
    logger: Logger;
    intervalMs?: number;
    batchSize?: number;
  });
  start(): Promise<void>; // runs once, then schedules every 24h
  runOnce(): Promise<number>; // returns deleted row count
  stop(): void; // idempotent
}
```

`start()` is idempotent. The timer is `unref()`ed. The service is registered with a dispose hook
that calls `stop()`. The initial cleanup failure is logged and does not prevent the server from
starting; a signing-key ensure failure still fails startup. This keeps a transient cleanup
problem from taking the auth service offline while preserving the startup attempt.

### Production bootstrap

`apps/server/src/auth/bootstrap.ts`:

```ts
export interface AuthBootstrapApplication {
  getService<T>(name: string): Promise<T>;
}

export async function bootstrapAuthRuntime(app: AuthBootstrapApplication): Promise<void> {
  const signingKeys = await app.getService<SigningKeyService>("signingKeys");
  await signingKeys.ensure();
  await signingKeys.retireDue();
  const maintenance = await app.getService<CliSessionMaintenanceService>("cliMaintenance");
  await maintenance.start();
}
```

`main.ts` calls it after `app.prepare()` and before `app.startTransport()`. CLI integration
tests call the same function after `createTestApplication`. Unit tests that never touch CLI auth
do not call it. First signing use still lazily ensures the key, so a forgotten bootstrap cannot
mint a token without a signing key.

### Plugin registration

The auth plugin registers these singleton services:

| Name | Type | Dispose |
|---|---|---|
| `localLogin` | `LocalLoginService` | none |
| `authRateLimits` | `AuthRateLimitService` | none |
| `cliSessions` | `CliSessionRepository` | none |
| `signingKeys` | `SigningKeyService` | clears cached key references |
| `cliAuth` | `CliAuthService` | none |
| `cliMaintenance` | `CliSessionMaintenanceService` | `stop()` |

The plugin installs `cliAuthMiddleware` before `sessionMiddleware`, then the forced-change gate,
origin guard, and CSRF guard. `app.ts` registers `CliAuthController` at `/v1/auth/cli`.

### Error handling

| Error case | Handling strategy | AR |
|---|---|---|
| Family list without CLI auth | `401 authentication_required` | AR-20 |
| Malformed family id | `404 session_not_found`, no query | AR-31 |
| Unknown/foreign/revoked/expired family delete | `404 session_not_found` | AR-19, AR-31 |
| Refresh races an owned-family delete | Principal lock serializes; no live row remains after a successful delete | AR-34 |
| Password update loses CAS | `401 invalid_credentials`; transaction rolls back CLI revocation | AR-7 |
| Cleanup failure at startup | Log and continue; retry at the next 24-hour run | AR-24 |
| Maintenance timer double start | Idempotent no-op | AR-16 |
| Bootstrap missing key | Ensure before serving; first use also lazily ensures | AR-16 |

> **Traceability:** This component is governed by AR-7, AR-9, AR-11, AR-19, AR-20, AR-24,
> AR-31, AR-33, and AR-34. The RD owns the family, password-change, and retention acceptance
> criteria.

## Testing Requirements

- Integration tests for list (live only, newest first, no hashes), current flag, delete owned,
  foreign 404, malformed 404, already-revoked 404, current-family revoke, and a concurrent
  refresh/delete interleaving.
- Password-change integration test: multiple CLI families, old refresh and access fail, fresh
  login with the new password succeeds, other browser sessions remain revoked.
- Cleanup test: 31-day-old expired row deleted, 29-day-old row kept, live row kept, batch bound
  respected, second run idempotent.
- Bootstrap test: ensure and maintenance start twice without duplicate keys or timers; a failed
  cleanup is logged and does not fail bootstrap.
- Existing browser session/password-change tests remain green.

# Lifecycle and Purge: RD-09 Certificates

> **Document**: 03-03-lifecycle-purge.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns metadata updates, soft delete, recovery, one-way purge protection,
retention, and the dedicated purge path for certificates. It generalizes the RD-08 purger so
both object families share one verified session and one lock order.

**Governing decisions:** AR-11, AR-12, AR-13, AR-14, AR-15, AR-21, AR-23, AR-25, AR-26,
AR-30.

## Architecture

### Current Architecture

`certificates` has `deleted_at`, `purge_after`, and `purge_protected`. The database trigger
rejects a certificate delete and a certificate-version delete unless the session user is
`openvault_purger`, the transaction sets `openvault.allow_purge='on'`, the parent is
soft-deleted, `purge_after <= now()`, and protection is off. The trigger also rejects
disabling protection. `SecretPurger` verifies `session_user`, `current_user`, the database,
superuser status, and ownership of `secrets`/`secret_versions`, then deletes versions and the
parent under the audit chain lock and the name advisory lock.

### Proposed Changes

```text
PATCH  /v1/data/:project/certificates/:name           certificate.write
DELETE /v1/data/:project/certificates/:name           certificate.delete
POST   /v1/data/:project/certificates/:name/recover   certificate.recover
POST   /v1/data/:project/certificates/:name/purge     certificate.purge
```

Move the purger to `apps/server/src/purge/vault-purger.ts` with `deleteSecret` and
`deleteCertificate`. Keep one lazy pool. Update the secret service/runtime/app wiring and the
RD-08 tests to the new names.

## Implementation Details

### Metadata Update (PATCH)

1. Resolve the active project.
2. Pre-authorize `certificate.write` at project scope with audit disabled; a denial writes one
   deny and returns 403/404 without revealing whether the name exists.
3. Resolve the active certificate and authorize `certificate.write` on the object with audit
   disabled for the final event; a denial writes one deny. A missing certificate is 404.
4. In one transaction: audit chain lock, project `FOR SHARE`, name advisory lock, row lock.
   Re-read the locked row and require `deleted_at IS NULL`; otherwise throw 404
   `certificate_not_found` so a concurrent delete cannot be followed by a protection change.
5. If `purgeProtected === false` and the stored value is true, throw 409
   `purge_protection_locked`. `false` when already false is a no-op. `true` sets it.
6. If `tags` is supplied, replace the tag object.
7. Set `updated_at`, write one joined allow, return the metadata. No version is created.

A failure after authorization writes one independent error outcome and no allow.

### Soft Delete

1. Resolve the active project. Pre-authorize `certificate.delete` at project scope with audit
   disabled; a denial writes one deny before the name is resolved. Resolve the active
   certificate and authorize on the object for the final event.
2. In one transaction: chain lock, project share lock, name advisory lock, row lock, then
   `UPDATE certificates SET deleted_at = now(), purge_after =
   now() + make_interval(days => :retentionDays), updated_at = now()
   WHERE id = :id AND deleted_at IS NULL RETURNING ...`.
3. A no-row result (concurrent delete) rolls back, writes one error outcome, and returns 404.
4. Write one joined allow and return 204.

The retention value is `config.softDeleteDays` (7–90, default 30). Stored timestamps use the
database clock; the audit event uses the service clock.

### Recovery

1. Resolve the active project. Pre-authorize `certificate.recover` at project scope with audit
   disabled before resolving the name; a denial writes one deny. Resolve the certificate by
   name including deleted rows and authorize on the object. A name is reserved until purge, so
   there is exactly one row.
2. In one transaction: chain lock, project share lock, name advisory lock, then
   `UPDATE certificates SET deleted_at = NULL, purge_after = NULL, updated_at = now()
   WHERE id = :id AND deleted_at IS NOT NULL AND purge_after > now() RETURNING ...`.
4. A no-row result re-reads the row and maps: not deleted -> 409 `certificate_not_deleted`;
   `purge_after <= now()` -> 409 `certificate_not_recoverable`; missing -> 404.
5. A failure writes one independent error outcome; success writes one joined allow and returns
   the metadata.

### Purge Protection

Protection is one-way. It can be enabled on an active certificate through PATCH. It cannot be
disabled. A protected deleted certificate can never be purged, so its name stays reserved
forever (AR-12/AR-14). The database trigger is the final defense.

### Purge

1. Resolve the active project. Pre-authorize `certificate.purge` at project scope with audit
   disabled before resolving the name; a denial writes one deny. Resolve the certificate by
   name including deleted rows and authorize on the object. Authorization happens **before**
   the deleted/protected/retention checks so an unauthorized caller cannot learn lifecycle
   state and every denial is audited.
2. Use one `fail(code, status)` helper that writes one independent error outcome for the
   lifecycle conflict before throwing. Require deleted -> 409 `certificate_not_deleted`.
3. Require protection off -> 409 `purge_protection_locked`.
4. Require `purge_after <= now()` -> 409 `certificate_retention_active`.
5. Call `VaultPurger.deleteCertificate(certificateId, projectId, name)`:
   - open the configured pool; absent -> 503;
   - verify `current_database()` equals the configured app database;
   - verify `session_user = 'openvault_purger'` and `current_user = 'openvault_purger'`;
   - verify the role is not a superuser and is not a member of any superuser role;
   - verify it is not a member of the owner role of `secrets`, `secret_versions`,
     `certificates`, `certificate_versions`, or `certificate_expiry_notifications`;
   - take the audit chain lock first, then the `(project_id,name)` advisory lock;
   - recheck the active project inside the transaction;
   - delete `certificate_expiry_notifications` for the certificate;
   - count the retained versions, `SET LOCAL openvault.allow_purge='on'`, delete
     `certificate_versions`, then delete `certificates`;
   - require the version count and parent row count to match.
6. Write exactly one outcome after the destructive transaction: allow on success, or error
   with `{ reason: "purge_failed" }` on failure. A missing purger or a `VaultPurgerError` also
   goes through one error outcome. Return 204 on success.
7. On failure, re-read the row and map a concurrent recovery/protection/delete state to
   409/404; otherwise return 503.

The decision and the destructive transaction cannot share a connection because the trigger
requires a different session user. A crash between the delete and the outcome event leaves the
deletion without evidence; this is the recorded residual risk of the dedicated-session purge.
Secret and certificate purge failures throw `VaultPurgerError`; the secret service maps
`project_not_found` to 404 and `service_unavailable` to 503, and the certificate lifecycle does
the same.

### Generalized Purger

`apps/server/src/purge/vault-purger.ts`:

```ts
export type VaultPurgerErrorCode = "project_not_found" | "service_unavailable";

export class VaultPurgerError extends Error {
  public readonly code: VaultPurgerErrorCode;
  public constructor(code: VaultPurgerErrorCode);
}

export class VaultPurger {
  public constructor(options: { readonly url?: string; readonly appDatabase: string });
  public async deleteSecret(secretId: string, projectId: string, name: string): Promise<number>;
  public async deleteCertificate(
    certificateId: string,
    projectId: string,
    name: string,
  ): Promise<number>;
  public async close(): Promise<void>;
}
```

The private `purge` helper accepts a discriminated target:

```ts
type PurgeTarget =
  | { readonly family: "secret"; readonly id: string; readonly parentTable: "secrets";
      readonly versionTable: "secret_versions"; readonly foreignKey: "secret_id" }
  | { readonly family: "certificate"; readonly id: string;
      readonly parentTable: "certificates"; readonly versionTable: "certificate_versions";
      readonly foreignKey: "certificate_id" };
```

The SQL identifiers come only from the fixed union, never from input. The guard checks all
five owned tables (including the notification table) plus superuser membership on every call;
it does not cache. The certificate
path also deletes notification rows before the versions.

The test helper `ensurePurgerRole` grants:

```sql
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificates TO openvault_purger;
GRANT SELECT, DELETE ON certificate_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificate_expiry_notifications TO openvault_purger;
```

### Configuration

`config.purgeDatabaseUrl` remains optional. The new `OPENVAULT_CERT_MAX_BYTES` bound is
131,072, and the certificate private-key PEM bound is 16,384. The webhook settings are owned by
03-04. The redacted configuration includes the expiry hour and a boolean for whether the webhook is
configured; it never includes the webhook URL or the webhook secret.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Empty metadata update | 422 `validation_error` | AR-15 |
| Disable protection when true | 409 `purge_protection_locked` | AR-14 |
| Delete an already deleted certificate | 404 `certificate_not_found` | AR-14 |
| Recover an active certificate | 409 `certificate_not_deleted` | AR-14 |
| Recover after retention | 409 `certificate_not_recoverable` | AR-14 |
| Purge before retention | 409 `certificate_retention_active` | AR-14 |
| Purge a protected certificate | 409 `purge_protection_locked` | AR-14 |
| Purge without a configured pool | 503 `service_unavailable` | AR-13 |
| Wrong database/session/privileged role | 503 `service_unavailable` | AR-13 |
| Delete count mismatch | 503 `service_unavailable` | AR-13 |

## Integration Points

- `apps/server/src/app.ts` builds one `VaultPurger` and registers it for disposal.
- `apps/server/src/secrets/{service,runtime}.ts` switches to `VaultPurger.deleteSecret`.
- RD-08 secret tests are updated for the class name, not for behavior.
- RD-13 provisions the production role and documents backup/recovery.
- The certificate notification table is deleted in the same purge transaction.

## Testing Requirements

- Specification tests for metadata update, delete, recovery, the retention boundary,
  protection, purge, hidden projects, and one audit outcome per success/denial/rollback.
- A route-by-principal denial matrix for PATCH/delete/recover/purge (reader, officer,
  object-scope reader, auditor, wrong project) with no state change and one deny event.
- Implementation tests for the purge role/database/session guards, a purger that is a member
  of an owner role, the certificate grant set (including DELETE on notifications), the explicit
  notification cleanup, name reservation, a project/name/id mismatch, and a full purge followed
  by a new certificate with the same name.
- A live test that the application role still cannot delete a protected certificate.
- RD-08 secret purge tests still pass against the generalized purger.

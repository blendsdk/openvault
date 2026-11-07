# App Role Least Privilege: Security Findings Wave 2

> **Document**: 03-04-app-role-least-privilege.md
> **Parent**: [Index](00-index.md)

## Overview

Replace the app role's blanket table grant with an explicit data-plane allowlist, remove default privileges, expose secret consumer summaries through a restricted view, and move backup to a dedicated `openvault_backup` role.

## App Role Allowlist

`openvault_app` receives:

| Table | Privileges |
|---|---|
| `projects` | `SELECT, INSERT, UPDATE` |
| `secrets` | `SELECT, INSERT, UPDATE` |
| `secret_versions` | `SELECT, INSERT` |
| `certificates` | `SELECT, INSERT, UPDATE` |
| `certificate_versions` | `SELECT, INSERT` |
| `certificate_expiry_notifications` | `SELECT, INSERT, UPDATE, DELETE` |
| `idempotency_keys` | `SELECT, INSERT, UPDATE` |
| `audit_events` | `SELECT, INSERT` |
| `audit_checkpoints` | `SELECT, INSERT` |
| `audit_keys` | `SELECT, INSERT` |
| `signing_keys` | `SELECT, INSERT, UPDATE` |
| `ca_keys` | `SELECT` |
| `audit_prune_authorizations` | `SELECT, INSERT` |
| `audit_prune_receipts` | `SELECT` |
| `secret_consumer_summaries` (view) | `SELECT` |

Sequences: `audit_events_id_seq`, `audit_checkpoints_id_seq`, `certificate_expiry_notifications_id_seq` with `USAGE, SELECT`.

Everything else is revoked. In particular, no `SELECT` on `principals`, `local_credentials`, `role_assignments`, `oidc_identities`, `cli_sessions`, `join_tokens`, `workload_certs`, `consumers`, `policy_state`, `org`, or `blendsdk_migrations`.

## Restricted Consumer View

Add the view to `apps/server/src/database/schema.ts` with `db.view("secret_consumer_summaries").as("...")` and let the codegen generate it, so `schema.snapshot.json` and the generated types stay consistent. The view body is:

```sql
CREATE VIEW public.secret_consumer_summaries AS
SELECT s.id AS secret_id,
       s.project_id,
       c.compose_project,
       c.compose_service,
       c.last_seen
  FROM public.secrets s
  JOIN public.consumers c ON c.project_id = s.project_id
  JOIN public.principals p ON p.id = c.principal_id AND p.status = 'active'
 WHERE EXISTS (
   SELECT 1
     FROM public.role_assignments r
    WHERE r.principal_id = c.principal_id
      AND r.role IN ('org.admin', 'project.admin', 'secrets.manager',
                     'secrets.officer', 'secrets.reader')
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND (
        r.scope_type = 'org'
        OR (r.scope_type = 'project' AND r.scope_id = s.project_id)
        OR (r.scope_type = 'object' AND r.scope_id = s.id AND r.role = 'secrets.reader')
      )
 );
```

The view is owned by `openvault_migrator` and runs with owner privileges (`security_invoker` false). It exposes no password, token, or identity-verifier columns. Revoke all from `PUBLIC`; grant `SELECT` to `openvault_app`. Assert `pg_views.viewowner = 'openvault_migrator'` and the default `security_invoker` setting in the grant test. The view is column-restricted, not row-restricted: the app role can read summaries for every project. That residual is acceptable because the app process must serve those summaries and no verifier material is exposed; document it in the limitations.

The repository query becomes:

```sql
SELECT secret_id, compose_project, compose_service, last_seen
  FROM secret_consumer_summaries
 WHERE project_id = :projectId AND secret_id = ANY(:secretIds)
 ORDER BY compose_project ASC, compose_service ASC
```

## Default Privileges

Remove the app grants from `roles.sql`. In `grants.sql`:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM openvault_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM openvault_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO openvault_backup;
```

New tables are therefore not automatically readable by the data plane. A migration that adds a runtime table must add its explicit grant.

## Backup Role

Add `openvault_backup`:

- `roles.sql`: create `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`.
- `init-roles.sh`: read `db_backup_password`.
- `ensure-backup-role.sql`: idempotent create/alter, revoke memberships, grant schema usage. Run from the `openvault-roles` job as the bootstrap superuser before `grants.sql`.
- `grants.sql`: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO openvault_backup;` and the default privilege above.
- `prepare.sh`: create `db_backup_password` and `db_backup_url`.
- `compose.yaml`: add the password secret to the roles job and the postgres service.

`ov backup` uses `OPENVAULT_BACKUP_DB_URL` / `_FILE` for the dump and `OPENVAULT_DB_URL` / `_FILE` for the `backup.create` audit event. `runBackup` takes `databaseUrl` (dump) and `auditDatabaseUrl` (app role), matching the existing restore split. Before dumping, it checks:

- `session_user` is not `openvault_app` or `openvault_auth`;
- `has_table_privilege(current_user, 'local_credentials', 'SELECT')` and the same on `audit_events`.

If any check fails, it throws `backup_role_required` with a message pointing at the dedicated role. The dump and audit URLs must also resolve to the same host, port, and database; a mismatch is rejected before the dump. The audit connection writes the chained event and is never used for the dump. This prevents a silent partial or wrong-database archive and prevents a read-only role from trying to write audit rows.

## Grant SQL Shape

`grants.sql` starts with:

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_pruner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_pruner;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_backup;
REVOKE SELECT (id) ON audit_keys FROM openvault_pruner;
```

Then grants the allowlist, the auth role privileges, the purger privileges, the pruner `EXECUTE`, and the backup `SELECT`. This is idempotent and removes stale table privileges on an existing database. Column-level grants are revoked explicitly because `REVOKE ALL ON ALL TABLES` does not remove them.

## Startup Assertion

Extend `assertControlPlaneSeparation` in `apps/server/src/db/privileges.ts`:

- App `has_table_privilege` is false for `SELECT` on every `CONTROL_PLANE_TABLES` entry, `policy_state`, `org`, and `blendsdk_migrations`.
- The existing write-denial checks remain.
- The check runs only in production, before `app.prepare()`.

## Dead Code

Remove `SecretRepository.touchConsumer` (`apps/server/src/secrets/repository.ts:749-757`). The production heartbeat uses `AgentConsumerService`/`ConsumerRepository` on the auth pool. Update the lifecycle test to exercise that path instead of calling the dead app-pool method.

## Schema Contract Tests

Adding two tables and one view changes the known schema inventory. Update, in the same phase that adds each object:

- `apps/server/tests/integration/migrations.spec.test.ts`: migration count and relation count.
- `apps/server/tests/integration/schema-identity.impl.test.ts`: ledger id list and count.
- `apps/server/tests/integration/schema.spec.test.ts`: table/view inventory.
- `apps/server/tests/integration/roles.spec.test.ts`: app allowlist and pruner `EXECUTE`-only contract.

These are schema-contract updates, not changes to the seven finding oracles. Record the exact new counts in the implementation commit.

## Generated Types

After the generated migrations, run `pnpm db:types` against a migrated database and commit `src/database/generated-types.ts` and `src/database/ctypes.ts`. Add `pnpm db:types:check` to the phase 8 verification list.

## Verification Query

The role test asserts:

- For every control-plane table, `has_table_privilege('openvault_app', table, 'SELECT')` is false.
- For every allowlisted table, the expected privilege is true.
- `openvault_app` can select `secret_consumer_summaries`; the view is owned by `openvault_migrator` and exposes only the five columns.
- `openvault_backup` can select every data table and has no `INSERT`, `UPDATE`, or `DELETE`.
- `openvault_pruner` has `EXECUTE` on the procedure and no table/sequence/column privileges.
- `openvault_app` has no default table privileges.

## Failure Behavior

- Missing explicit grant: runtime query fails closed with a permission error; the test suite catches it.
- Backup with the app role: `backup_role_required` before any dump.
- Existing database: `ensure-backup-role.sql` creates the role; grants are reapplied by the roles job.

## Acceptance

See `07-testing-strategy.md` ST-17…ST-27 and `01-requirements.md` R4.

# Database Auth Boundary: Security Findings Remediation

> **Document**: 03-01-database-auth-boundary.md
> **Parent**: [Index](00-index.md)

## Overview

Separate the PostgreSQL runtime credential from a control-plane credential. The data-plane `openvault_app` role keeps secrets, certificates, projects, audit, and read access needed by backup. A new `openvault_auth` role owns every authentication, authorization, and agent-identity table. A second pool uses the auth URL.

This is a full control-plane split, not a five-table patch. The preflight proved that revoking `principals` writes alone breaks `FOR UPDATE` row locks in agent join, renewal, token issuance, and password change, and that leaving `join_tokens`, `workload_certs`, and `consumers` app-writable still permits agent credential minting and revocation rollback.

## Owned Tables

`openvault_auth` owns DML on:

- `principals`
- `local_credentials`
- `role_assignments`
- `oidc_identities`
- `cli_sessions`
- `join_tokens`
- `workload_certs`
- `consumers`

`openvault_app` loses `INSERT`, `UPDATE`, and `DELETE` on all eight. It keeps `SELECT` for backup and read-only joins. Moving backup to the migrator URL is a separate hardening item and is not required to close the reported write-forgery path.

## Composition

### Configuration

Add `OPENVAULT_AUTH_DB_URL` / `_FILE` and `OpenVaultConfig.authDatabaseUrl` / `authDatabase`. Validate host, port, and database against `OPENVAULT_DB_URL`, matching `OPENVAULT_PURGE_DB_URL`.

### Pools

`apps/server/src/main.ts` creates the auth pool when the auth URL is configured, otherwise falls back to the app pool in development/test. Register it as the `authDatabase` singleton with a `disconnect()` disposer, resolve it before `app.prepare()`, and pass it to `createAgentRuntime` and `createApplication`.

`SecureApplicationDependencies` gains `authDatabase?: PostgreSQLDatabase`.

### Runtimes

| Runtime | Auth database use |
|---|---|
| `createPolicyRuntime` | `PolicyRepository`, `AssignmentService`, policy reads/writes |
| `createAuthPlugin` | `CredentialsRepository`, `CliSessionRepository`, `OidcIdentityService`; signing keys stay on the app database |
| `createIdentityRuntime` | `IdentityRepository`, `IdentityAuthorizer`, `IdentityService`, `AgentTokenService` |
| `createAgentRuntime` | policy/identity runtimes, `DatabaseAgentAuthenticator`, `DatabaseProjectResolver`, `ConsumerRepository`, `AgentJoinService`, `AgentRenewService`, `AgentMaintenanceService` |
| `AgentConsumerService` in `app.ts` | `ConsumerRepository` |
| `AuthController` password change | `authDatabase` service for the credentials/CLI transaction |

`AgentTokenService` is moved to the auth pool. `IdentityService.revoke` passes the auth transaction to `tokens.revokeUnused`, so principal, certificate, consumer, and join-token revocation remain atomic.

The audit writer stays on the app database, but RBAC assignment mutations and OIDC JIT audit run inside the auth transaction. The auth role therefore receives the audit read/insert grants below.

## PostgreSQL Grants

`roles.sql` creates `openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`. It is not added to default table privileges.

`grants.sql`:

```sql
GRANT USAGE ON SCHEMA public TO openvault_auth;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON principals, local_credentials, role_assignments, oidc_identities, cli_sessions,
     join_tokens, workload_certs, consumers
  TO openvault_auth;

GRANT SELECT, UPDATE ON projects TO openvault_auth;      -- row locks and project reads
GRANT SELECT ON secrets, certificates TO openvault_auth; -- policy live-assignment predicates
GRANT SELECT, UPDATE ON policy_state TO openvault_auth;  -- version bump

GRANT SELECT, INSERT ON audit_events, audit_checkpoints, audit_keys TO openvault_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openvault_auth;

REVOKE INSERT, UPDATE, DELETE
  ON principals, local_credentials, role_assignments, oidc_identities, cli_sessions,
     join_tokens, workload_certs, consumers
  FROM openvault_app;
```

`projects` remains app-writable because project create/rename/delete is a project-service concern; the auth role needs `UPDATE` only for `FOR UPDATE`/`FOR SHARE` locks. If PostgreSQL accepts `FOR SHARE` with `SELECT` alone, the narrower grant is preferred; test both on PostgreSQL 16 and 17.

## Role Upgrade

`roles.sql` runs only during first database initialisation. Add `deploy/postgres/ensure-auth-role.sql` and run it from the `openvault-roles` job on every deployment:

- Run as the bootstrap superuser using `postgres_password`; the migrator is intentionally
  `NOCREATEROLE` and cannot create or alter the role.
- Read `db_auth_password` from the Compose secret.
- Feed the SQL and the password through stdin, never `psql -v` on the command line.
- Create the role if absent, reset its attributes and password, revoke unexpected memberships,
  and leave DDL ownership unchanged.
- Run before `grants.sql`; `grants.sql` still runs as the migrator.

The fresh-install `init-roles.sh` also supplies `db_auth_password` to `roles.sql`.

## Startup Assertion

Add `apps/server/src/db/privileges.ts`:

- App connection: `has_table_privilege(current_user, table, verb)` is false for `INSERT`, `UPDATE`, and `DELETE` on all eight tables.
- Auth connection: the same checks are true.
- Auth `current_user` is not `rolsuper`, does not own any of the eight tables, and is not a member of `openvault_migrator`.
- Auth has the required `SELECT`/`UPDATE` on `projects`, `policy_state`, and `SELECT` on `secrets`/`certificates`, plus audit access.

Run only for `config.envMode === "production"`, after migrations and before `app.prepare()`. Throw a dedicated `AuthPrivilegeError` with a safe message naming the table and verb; `main.ts` prints that message for this error type. Never include a URL or password.

## Ordering

Implement the composition and auth-pool threading **before** applying the revokes. The intermediate state must keep auth writes working through the fallback pool. Apply the grants and the startup assertion in the same task as the first restricted deployment test, then run the role-based suite.

## Tests

`apps/server/tests/integration/security/auth-boundary.spec.test.ts`:

- Creates disposable `openvault_app`/`openvault_auth` roles in the test cluster, with unique passwords and cleanup.
- Applies migrations as a real `openvault_migrator` role so table ownership matches production.
- Applies the exact role/grant SQL through a psql-compatible executor (strip `\set` meta-commands or use `psql`).
- Checks all three verbs for both roles, superuser/ownership/membership, and the startup assertion.
- Exercises representative auth operations through restricted connections: local login, credential update, CLI family create/rotate, assignment insert/delete, OIDC identity insert, identity create/revoke, join-token issue/revoke, and agent join/renew.
- Refuses to run against a cluster that already has the production role names unless the database is disposable.

If the exact role SQL cannot run safely in the shared test cluster, use a dedicated PostgreSQL container in the integration job and document the reason. Hand-copied grants are not acceptable as the only test.

## Residual

The app role keeps `SELECT` on password hashes, refresh hashes, and OIDC links for backup. That is read exposure, not write forgery. Moving backup to the migrator/owner URL is recorded as a follow-up in the findings ledger, not part of this plan.

## Acceptance

See `07-testing-strategy.md` ST-1…ST-6 and `01-requirements.md` R1.

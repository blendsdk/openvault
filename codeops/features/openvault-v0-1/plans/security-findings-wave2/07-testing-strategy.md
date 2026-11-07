# Testing Strategy: Security Findings Wave 2

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Specification Test Cases

These cases are the immutable oracle for this plan. They are written before implementation. A failing case after implementation means the implementation is wrong, not the test.

### R1 — CLI origin binding (#46)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-1 | Credential for `https://localhost:A`; `doctor --url https://127.0.0.1:A` | TLS/readiness run; no `/v1/auth/cli/me` request with `Authorization`; credentials check fails with the origin message | AR-3, R1 |
| ST-2 | Credential for origin A; `doctor --url` equal to A | Authenticated credential check runs and succeeds | AR-3, R1 |
| ST-3 | `sameCredentialOrigin` with scheme, host, port, and default-port variations | Only equal origins return true | AR-3, R1 |
| ST-4 | Invalid stored credential document | No bearer request; safe credential failure, not “no server URL” | AR-3, R1 |
| ST-4b | `OPENVAULT_URL` override (no `--url`), different origin | No `/v1/auth/cli/me` bearer to the override | AR-3, R1 |
| ST-4c | Same origin success after a prior request | New request slice contains the authenticated check | AR-3, R1 |

### R2 — Audit prune procedure (#47)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-5 | `openvault_pruner` direct `DELETE FROM audit_events` | Permission denied | AR-4, R2 |
| ST-6 | `openvault_pruner` direct `INSERT INTO audit_checkpoints` | Permission denied | AR-4, R2 |
| ST-7 | Procedure with an absent authorization | Raises; no rows deleted | AR-4, AR-5, R2 |
| ST-8 | Procedure with an expired authorization | Raises; no rows deleted | AR-4, AR-5, R2 |
| ST-9 | Procedure with mismatched database, boundary hash, or count | Raises; no rows deleted | AR-4, AR-5, R2 |
| ST-9b | Export hash in authorization, receipt, and event | All three carry the app-computed value; a mismatch with the file is an operator check, not a procedure rejection | AR-14, R2 |
| ST-10 | Procedure with a consumed authorization | Raises; no rows deleted | AR-4, AR-5, R2 |
| ST-11 | Successful prune | Prefix deleted; authorization consumed; one receipt bound to the export hash | AR-4, AR-5, R2 |
| ST-12 | Chained `audit.prune` event | Contains the authorization id and export hash; verification still passes | AR-5, R2 |

### R3 — Secret read audit (#48)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-13 | Malformed newest version | 500/503; exactly one `secret.read` `error`; zero `allow` | AR-6, R3 |
| ST-14 | Valid read | 200; exactly one `allow` with the selected version | AR-6, R3 |
| ST-15 | Keyring failure | 503; one `error`; zero `allow` | AR-6, R3 |
| ST-16 | Certificate private-read integrity failure | Same event shape and ordering | AR-6, R3 |

### R4 — App role least privilege (#50)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-17 | `openvault_app` `SELECT` on every control-plane table | Permission denied for all | AR-7, R4 |
| ST-18 | `openvault_app` data-plane allowlist | Required selects and writes succeed | AR-7, R4 |
| ST-19 | `openvault_app` `SELECT` on `secret_consumer_summaries` | Succeeds; only the five exposed columns | AR-7, R4 |
| ST-20 | `openvault_app` default privileges | No default table privilege for future tables | AR-7, R4 |
| ST-21 | `openvault_backup` | `SELECT` on all tables; no write verbs | AR-8, R4 |
| ST-22 | Backup with the app/auth role | `backup_role_required` before any dump | AR-8, R4 |
| ST-23 | Backup with `OPENVAULT_BACKUP_DB_URL` + app audit URL | Archive includes control-plane tables; one `backup.create` event | AR-8, AR-13, R4 |
| ST-24 | Fresh install | `openvault_backup` exists with the right attributes | AR-8, R4 |
| ST-25 | Existing install | `ensure-backup-role.sql` creates the role idempotently | AR-8, R4 |
| ST-25b | Production startup assertion | App `SELECT` on a control-plane table fails closed | AR-7, R4 |
| ST-26 | Full runtime after grants | Secret, certificate, project, audit, scaffold, agent auth paths pass | AR-7, R4 |
| ST-27 | `ov backup` with a missing backup URL | Clear usage error | AR-8, R4 |
| ST-27b | Schema inventory and generated types | Migration/relation counts updated; `db:types:check` clean | AR-15, R4 |

### R5 — Join token clipboard (#49)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-28 | Copy join token; advance 30 seconds | `writeText("")` is called; focused and unfocused pages both attempt it | AR-9, AR-17, R5 |
| ST-29 | Copy then close the dialog; advance 30 seconds | Clear still runs; page-level status remains visible | AR-9, AR-16, R5 |
| ST-30 | Clear write rejects | Manual-clear message; previous timer is not lost when a new copy is denied | AR-9, R5 |
| ST-31 | Non-credential copy | No scheduled clear | AR-9, R5 |

### R6 — Scaffold visibility (#51)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-32 | Unassigned caller, existing hidden project vs missing | Identical 404 status, code, message | AR-10, R6 |
| ST-33 | Foreign project admin, existing vs missing | Identical 404 | AR-10, R6 |
| ST-34 | Reader/auditor with project read, existing vs missing | 403 vs 404 | AR-10, R6 |
| ST-35 | Org admin, missing with entries | 422 actionable | AR-10, R6 |
| ST-35b | Org admin, missing with no entries | Project created, 200 | AR-10, R6 |
| ST-36 | Org admin, existing project | Scaffold proceeds | AR-10, R6 |
| ST-37 | Hidden denial | Exactly one deny audit event with the real reason | AR-10, R6 |

### R7 — Session rotation proof (#52)

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-38 | Old cookie, no `x-csrf-token` | 401; no `Set-Cookie` | AR-11, R7 |
| ST-39 | Old cookie, wrong `x-csrf-token` | 401; no `Set-Cookie`; receipt retained for a correct retry | AR-11, R7 |
| ST-39b | In-flight rotation, old cookie, no proof | 401; no successor | AR-11, R7 |
| ST-40 | Old cookie, pre-rotation CSRF token | 200; same successor | AR-11, R7 |
| ST-41 | Repeat correct recovery | 401; receipt consumed | AR-11, R7 |
| ST-41b | Concurrent correct-proof recovery | One successor and one 401 | AR-11, R7 |
| ST-42 | Revocation | Receipt invalid | AR-11, R7 |
| ST-43 | Password change | Receipt invalid | AR-11, R7 |
| ST-44 | Expiry or supersession | Receipt invalid | AR-11, R7 |

## Implementation Test Files

- `apps/cli/tests/doctor.impl.test.ts`, `apps/cli/tests/commands.spec.test.ts` — ST-1…ST-4.
- `apps/server/tests/integration/audit-prune.spec.test.ts`, `audit-prune.impl.test.ts`, `security/auth-boundary.spec.test.ts`, `roles.spec.test.ts`, `ops.spec.test.ts` — ST-5…ST-12, ST-17…ST-27.
- `apps/server/tests/integration/secrets.spec.test.ts`, `secrets-crypto.spec.test.ts` — ST-13…ST-16.
- `apps/server/tests/integration/certificates-read.spec.test.ts` — ST-16.
- `apps/server/tests/integration/scaffold.spec.test.ts` — ST-32…ST-37.
- `apps/server/tests/integration/auth.sessions.test.ts`, `apps/server/tests/auth/sessions.impl.test.ts` — ST-38…ST-44.
- `apps/web/tests/identities-consumers.test.tsx`, `apps/web/tests/copy.test.tsx` — ST-28…ST-31.

## Verification

- `pnpm verify`.
- `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=postgres://.../openvault_test pnpm test:integration` on PostgreSQL 16 and 17.
- `pnpm db:types:check` against a migrated database (CI already runs it; add it to the local closeout).
- `sh -n deploy/compose/prepare.sh`.
- `pnpm check:compose`.
- `pnpm security:evidence:check`, `pnpm security:claims:check`, `pnpm docs:build`.

## Red Phase

Each phase’s specification test must fail before its implementation. Record the failure reason in the execution plan. Compatibility tests (same-origin doctor success, normal copy, valid reads, empty-entries scaffold create) do not need to fail on the old code; label them as compatibility coverage.

Schema inventory tests (`migrations.spec.test.ts`, `schema.spec.test.ts`, `schema-identity.impl.test.ts`) and role-contract tests (`roles.spec.test.ts`) are schema/contract tests, not finding oracles. They are updated in the same phase that changes the schema or grants, with the exact new counts recorded in the commit.

## Coverage Notes

The role test uses real PostgreSQL roles and a disposable database. The prune tests use the real trigger and procedure. The clipboard tests use fake timers and a clipboard mock. The session tests exercise the real HTTP middleware and controller.

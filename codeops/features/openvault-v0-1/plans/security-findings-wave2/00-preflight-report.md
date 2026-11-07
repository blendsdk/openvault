# Preflight Report: Security Findings Wave 2

> **Audit target**: `codeops/features/openvault-v0-1/plans/security-findings-wave2/` (all plan documents)
> **Git revision at scan**: `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a` (plan files uncommitted)
> **Reviewers**: three independent preflight subagents (DB/grants/prune, secret/scaffold/session, CLI/web/migration)
> **Same-session note**: ⚠️ The plan author and lead reviewer share a session. The three audit clusters were dispatched to fresh contexts to reduce same-session bias.
> **Verdict**: ✅ PASSED WITH NOTES — all Critical/Major findings resolved in the plan; remaining Minor/Observation items accepted or folded into the tasks.

## Codebase Context

Recon read the CLI doctor and test harness, the PostgreSQL roles/grants and migration mechanics, the audit prune/verifier/trigger flow, the secret and certificate read paths, the scaffold service and RBAC matrix, the session receipt/controller/CSRF paths, the web clipboard and test setup, the backup/restore operations, and the affected integration tests.

## Findings and Resolutions

| PF | Severity | Finding | Resolution |
|---|---|---|---|
| PF-001 | 🔴 Critical | A read-only `openvault_backup` cannot write the `backup.create` audit event, so every backup fails after writing the archive. | `runBackup` now takes `databaseUrl` (dump) and `auditDatabaseUrl` (app role), matching restore’s split. `03-04`, ST-23. |
| PF-002 | 🟠 Major | `audit.prune` detail allowlist rejects `authorizationId` and `exportSha256`, so the completion event fails after the delete. | Add both keys to `PRUNE_DETAIL_KEYS`; carry them in `AuditPruneResult`; add `apps/server/src/audit/actions.ts` to the plan. `03-02`, `03-03`. |
| PF-003 | 🟠 Major | The production privilege assertion checks writes only; a stale app role could still read control-plane material and start. | Extend `assertControlPlaneSeparation` with app `SELECT` denial on control-plane tables, `policy_state`, `org`, and `blendsdk_migrations`. `03-04`, ST-25b. |
| PF-004 | 🟠 Major | Schema inventory tests expect 11 migrations/23 relations; the plan adds tables and a view without updating them. | Add explicit schema-contract update tasks and counts; these are contract tests, not finding oracles. `03-04`, `03-02`, `99`. |
| PF-005 | 🟠 Major | `db:types:check` is missing from the plan and `pnpm verify`; generated types will drift. | Add `pnpm db:types` after each generated migration and `pnpm db:types:check` to phase 8. `03-04`, `07`, `99`. |
| PF-006 | 🟠 Major | Existing prune tests and `helpers/pruner.ts` still use the old delete signature and grant direct `DELETE`. | Update the helper to grant `EXECUTE` only, rewrite both test callbacks, and add negative tests. `03-02`, `99`. |
| PF-007 | 🟠 Major | ST-9’s “export hash mismatch” has no database implementation; the procedure cannot read the file. | Reclassify the hash as recorded evidence; assert authorization/receipt/event equality. ST-9b. `03-02`, `07`. |
| PF-008 | 🟠 Major | `roles.spec.test.ts` asserts the old app/pruner privileges and has no backup role. | Rewrite the role contract test and add the backup role/password. `03-04`, `99`. |
| PF-009 | 🟠 Major | The auth-boundary test creates five roles and migrates as the admin; `grants.sql` cannot grant on admin-owned tables or reference the missing backup role. | Add the backup role, transfer ownership of new objects (or migrate as migrator), and include the new clients. `03-04`, `99`. |
| PF-010 | 🟠 Major | Clipboard clear skipped when the page is unfocused, which is the normal copy-then-switch-apps workflow. | Always attempt the clear; report failure. `03-05`, AR-17. |
| PF-011 | 🟠 Major | The manual-clear message lives inside the unmounted dialog and is unobservable after close. | Page-level status outside the dialog; shared credential-copy module. `03-05`, AR-16. |
| PF-012 | 🟠 Major | A denied new copy cancels the old timer, leaving the previous token indefinitely. | Cancel the previous timer only after the new write resolves; keep it on denial. `03-05`. |
| PF-013 | 🟠 Major | Two independent timers (join token and secret value) can clear newer clipboard content. | One shared credential-copy module and timer. `03-05`. |
| PF-014 | 🟠 Major | jsdom `document.hasFocus()` is false by default; the proposed tests would fail or pass for the wrong reason. | Stub/focus explicitly; test focused and unfocused paths. `03-05`, `07`. |
| PF-015 | 🟠 Major | The doctor negative test would be polluted by earlier requests in the shared fake vault. | Use `vault.requests.slice(start)` and add the `OPENVAULT_URL` and malformed-credential cases. `03-01`, ST-4b/4c. |
| PF-016 | 🟠 Major | Scaffold plan dropped the empty-entries project-create path. | Preserve create when entries are empty; add ST-35b. `03-06`. |
| PF-017 | 🟠 Major | The session in-flight shortcut returns the successor without the CSRF proof. | Store the old CSRF hash with the in-flight entry and verify the proof. `03-07`, ST-39b. |
| PF-018 | 🟠 Major | `hashSecret` returns a hex string, not a `Buffer`; the planned `timingSafeEqual` would not typecheck. | Add `hashToken` returning a digest Buffer; keep `hashSecret` for cache keys. `03-07`. |
| PF-019 | 🟠 Major | The session test impact is incomplete; two `.impl` tests and the concurrency `.spec` test assume no proof. | List and update the exact tests; add in-flight and concurrent-recovery cases. `03-07`, `07`. |
| PF-020 | 🟡 Minor | `REVOKE ALL ON ALL TABLES` does not remove column grants; the pruner keeps `SELECT (id)` on `audit_keys`. | Remove the grant and add an explicit column revoke; add backup stale-privilege revokes. `03-04`. |
| PF-021 | 🟡 Minor | The backup preflight checks privileges, not the role; the old app grants would pass during a rolling upgrade. | Also reject `session_user` `openvault_app`/`openvault_auth`. `03-04`. |
| PF-022 | 🟡 Minor | `SecretRepository.touchConsumer` is dead app-pool code excluded by the new allowlist; its test uses the superuser. | Remove it and update the test to the auth-pool consumer service. `03-04`. |
| PF-023 | 🟡 Minor | Existing CLI/ops backup tests do not set the new URL. | Update them; add a real backup-role integration test. `03-04`, `99`. |
| PF-024 | 🟡 Minor | `resetAuditTables` does not clear the new prune tables. | Add them to the reset helper. `03-02`. |
| PF-025 | 🟡 Minor | The procedure’s claimed expired-authorization cleanup was missing from the SQL. | Add the cleanup before the target lookup. `03-02`. |
| PF-026 | 🟡 Minor | The view owner and `security_invoker` setting are not asserted. | Assert `pg_views.viewowner` and default `security_invoker`; add the view through `schema.ts`. `03-04`. |
| PF-027 | 🟡 Minor | The consumer view is column-restricted, not row-restricted. | Accepted residual; document in limitations. `03-04`, `05`. |
| PF-028 | 🟡 Minor | The app role still reads KEK-wrapped key material. | Accepted residual: the app process needs the reads; values are KEK-wrapped. `05`. |
| PF-029 | 🟡 Minor | The dedicated backup role is a standing broad-read credential. | Accepted residual: read-only, `NOINHERIT`, no memberships, documented rotation. `05`. |
| PF-030 | 🟡 Minor | Scaffold missing-project audit behavior and error type were unspecified. | `{ audit: false }` probes; one operation decision; use/extend `project_not_found`. `03-06`. |
| PF-031 | 🟡 Minor | Scaffold timing claim was wrong. | Document the real probe counts and test lookup-before-response with tolerance. `03-06`. |
| PF-032 | 🟡 Minor | Secret capability-outage was mislabeled as integrity failure. | Record `policy_unavailable` and preserve 503. `03-03`. |
| PF-033 | 🟡 Minor | The secret allow could be written before response construction. | Build the complete response before the allow write. `03-03`. |
| PF-034 | 🟡 Minor | Session receipt consumption was not specified as atomic; wrong-proof-then-correct was untested. | Consume synchronously; add sequential and concurrent tests. `03-07`. |
| PF-035 | 🔵 Observation | A lost recovery response cannot be retried after consumption. | Accepted trade-off; documented. `03-07`, `05`. |
| PF-036 | 🔵 Observation | The web scheduler still fails over to `/me` after a failed refresh. | Pre-existing availability gap; not changed. `03-07`. |
| PF-037 | 🔵 Observation | The plan index referenced a missing preflight report. | This report created. |
| PF-038 | 🔵 Observation | Helper naming and “two-vault” wording were inconsistent. | Standardized on `sameCredentialOrigin` and one fake vault with two origins. `03-01`. |

## Post-Implementation Review (Iteration 3)

Two independent reviewers audited the implemented branch diff. The following findings were resolved before closeout:

| PF | Severity | Finding | Resolution |
|---|---|---|---|
| PF-039 | 🔴 Critical | The prune migration did not remove legacy direct pruner grants; an existing database that applied migrations without `grants.sql` kept direct delete authority. | The procedure migration now self-contains the pruner revokes and app grants behind `pg_roles` guards; `createPruneConnection` also fails closed on direct table/role authority. |
| PF-040 | 🟠 Major | The authenticated CLI could reload a changed credential after building the transport, crossing origins. | `openAuthenticatedClient` passes the original `baseUrl` into `createAuthenticatedClient`; the origin check uses it. |
| PF-041 | 🟠 Major | Backup did not prove the dump and audit URLs target the same database. | `runBackup` compares host, port, and database identities and rejects a mismatch. |
| PF-042 | 🟠 Major | The prune cutoff was stored but not enforced; an out-of-order timestamp could be pruned early. | The boundary query excludes prefixes containing a newer timestamp; the procedure rejects a prefix whose maximum timestamp is at or after the cutoff. |
| PF-043 | 🟠 Major | Role ensure scripts did not remove reverse memberships, allowing `SET ROLE` escalation. | Ensure scripts revoke both membership directions and predefined broad roles; startup and prune checks reject memberships. |
| PF-044 | 🟠 Major | `ensure-backup-role.sql` did not reset `REPLICATION`, `BYPASSRLS`, or schema `CREATE`. | Both ensure scripts reset the full attribute set and revoke schema `CREATE`. |
| PF-045 | 🟠 Major | The scaffold 422 create path did not record the authorized attempt. | The create decision is recorded before the 422. |
| PF-046 | 🟠 Major | Audit, CLI, Compose, systemd, and init docs still described the old pruner grants, four roles, and app-role bootstrap. | Docs now describe `EXECUTE` only, six roles, five role URLs, the migrator bootstrap URL, and `0600` backup URL custody. |
| PF-047 | 🟠 Major | Regression coverage lacked view owner/columns, default ACL, backup auth refusal, real backup-role dump, database mismatch, and procedure mismatch tests. | Added those tests; see the updated testing strategy. |

## Iteration 2

The plan documents were revised after the three audits. The structural corrections are:

- the backup dump/audit connection split;
- the `audit.prune` detail allowlist and evidence fields;
- the startup app-read denial assertion;
- schema inventory and generated-type tasks;
- the pruner helper `EXECUTE`-only contract;
- the page-level clipboard status and always-attempt clear;
- the scaffold empty-entries create path;
- the session in-flight proof and binary token hash.

A second semantic re-scan of the revised documents is recorded as task 8.1.5; any new Critical/Major blocks completion.

## Pass Tier

✅ **PASSED WITH NOTES** — all 🔴/🟠 findings have a concrete resolution in the plan. Remaining notes are accepted residual read exposure, the column-restricted view, the standing backup role, lost-recovery reauthentication, and the pre-existing scheduler fallback.

# Preflight Report: Security Findings Remediation

> **Audit target**: `codeops/features/openvault-v0-1/plans/security-findings-remediation/` (all plan documents)
> **Git revision at scan**: `6ed6396ce613299707b149638515c7ab1c150992` (plan files uncommitted)
> **Reviewers**: three independent preflight subagents (grounding/feasibility, shell/OIDC, purge/enumeration)
> **Same-session note**: ⚠️ The plan author and lead reviewer share a session. The three audit clusters were dispatched to fresh contexts to reduce same-session bias.
> **Verdict**: ✅ PASSED WITH NOTES — all Critical/Major findings resolved in the plan; remaining Minor/Observation items accepted or deferred.

## Codebase Context

The plan targets a TypeScript/BlendSDK server with PostgreSQL, envelope encryption, audit chaining, RBAC, local/OIDC auth, CLI refresh families, and agent mTLS. Recon read `deploy/postgres/*`, `deploy/compose/*`, `apps/server/src/{config,auth,rbac,identity,agent,security,purge,secrets,certificates}`, the integration helpers, and the existing spec tests.

## Findings and Resolutions

| PF | Severity | Finding | Resolution |
|---|---|---|---|
| PF-001 | 🔴 Critical | Revoking `UPDATE` on `principals` breaks `FOR UPDATE`/`FOR SHARE` locks in agent join, renewal, token issuance, and password change. | Revised to a full control-plane split. Key locks now run on the auth pool; the startup/order tests cover the paths. `03-01`, AR-3. |
| PF-002 | 🔴 Critical | `IdentityService.revoke` updates `join_tokens` inside the auth transaction; initial grants omitted it. | Auth role now owns `join_tokens`; `AgentTokenService` moves to the auth pool; atomic revoke is preserved. `03-01`, ST-8. |
| PF-003 | 🔴 Critical | Identity create locks `projects` with `FOR SHARE`; initial auth grant was `SELECT` only. | Auth gets `SELECT, UPDATE` on `projects` for row locks; test both lock modes on PostgreSQL 16/17. `03-01`. |
| PF-004 | 🔴 Critical | Assignment mutations write audit rows inside the auth transaction; initial grants omitted `audit_keys`/event reads. | Auth gets `SELECT, INSERT` on `audit_events`, `audit_checkpoints`, `audit_keys`; startup assertion checks them. `03-01`. |
| PF-005 | 🔴 Critical | Existing databases never create `openvault_auth`; `roles.sql` only runs on first init. | Added idempotent `ensure-auth-role.sql` in the `openvault-roles` job on every deployment. AR-13, `03-01`. |
| PF-006 | 🟠 Major | Five-table split leaves agent credential minting and revocation rollback. | Extended the split to `join_tokens`, `workload_certs`, `consumers`, and `principals`. `03-01`, R1. |
| PF-007 | 🟠 Major | Startup assertion checked only `INSERT` and not auth over-privilege. | Checks all three verbs, auth required grants, and rejects superuser/owner/migrator membership. AR-14, ST-3/4. |
| PF-008 | 🟠 Major | App role retains `SELECT` on password/session/OIDC records. | Accepted residual read exposure for backup; documented in `03-01` and the findings ledger. Not a write-forgery path. |
| PF-009 | 🟠 Major | All behaviour tests run as a superuser, hiding role mistakes. | Added a role-based integration suite with real roles, real migrations, and representative auth/agent paths. ST-1…ST-8. |
| PF-010 | 🟠 Major | Applying `roles.sql`/`grants.sql` in a shared test cluster is unsafe/underspecified. | Test uses disposable roles/database, a real migrator owner, psql-compatible execution, cleanup, and a production-role-name guard. `03-01`. |
| PF-011 | 🟠 Major | Signing-key trigger allowed arbitrary status transitions. | Replaced with a strict `current→previous` / `previous→retired` matrix; retired→current and current→retired rejected. `03-02`, ST-12. |
| PF-012 | 🟠 Major | KEK rotation guard checks only `openvault_app`. | Guard now rejects `openvault_app` and `openvault_auth`; docs updated. `03-02`. |
| PF-013 | 🟠 Major | Phase ordering revoked app writes before the code used the auth pool. | Composition and auth-pool threading precede grants; grants + startup assertion land in the restricted-deployment task. `99`, Phase 1. |
| PF-014 | 🟠 Major | `policy_state` remained app-writable. | Revoked from app; auth gets `SELECT, UPDATE`; startup assertion includes it. `03-01`. |
| PF-015 | 🟠 Major | `prepare.sh` helper snippets had `set -e` and global-variable bugs; trailing slash bypass; `mv` follows symlink-to-directory; rerun overwrote secrets. | Rewrote helpers with `if` blocks, unique variables, `assert_safe_path` (rejects `..`, trailing slash, root, symlinked components), directory rejection, non-empty preservation, and expanded tests. `03-03`, ST-14…ST-20. |
| PF-016 | 🟠 Major | Prepare tests did not catch idempotency, subdirectories, root chown, or Phase 1 auth secrets. | Added rerun byte equality, path-shape, chown shim, subdirectory, auth-secret, and `--secrets-only` cases. `03-03`, ST-18…ST-20. |
| PF-017 | 🟠 Major | OIDC tests covered only the token endpoint; redirect test was not redirect-aware; redaction/origin parser missing. | Parameterized all four endpoints, added a redirect-aware stub, origin parser/redaction tasks, and moved ST-26 to the integration suite. `03-04`, ST-21…ST-26. |
| PF-018 | 🔴 Critical | Purge plan contradicted R5 by removing the completion event. | Restored `authorized` + `completed`; test completion failure and delete failure; updated limitation and exact-event-count test. `03-05`, ST-27…ST-31. |
| PF-019 | 🟠 Major | Purge failure/error-write behavior was not defined. | Event contract now defines authorized/completed/failed, including “unknown” when completion is missing. `03-05`. |
| PF-020 | 🔴 Critical | 404 still leaked through the error message. | Hidden and missing responses now use identical status, code, and message; tests assert the full body. `03-06`, ST-32…ST-44. |
| PF-021 | 🟠 Major | `consumers` route and missing-project code still leaked. | Added consumers and name-route missing-project mapping. `03-06`. |
| PF-022 | 🟠 Major | Certificate lifecycle pre-authorized project before name; `readPrivate` used `certificate.read`; duplicate deny events. | Lifecycle uses collection visibility at pre-auth; `readPrivate` keeps 403 for object readers; one deny event per request. `03-06`. |
| PF-023 | 🟠 Major | Existing tests/docs/CLI/web expectations were understated. | Enumerated affected tests and added docs, CLI, and web fake updates. `03-06`, `99` Phase 6. |
| PF-024 | 🟡 Minor | Startup assertion message was swallowed by `main.ts`. | Added `AuthPrivilegeError` with a safe printed message. `03-01`. |
| PF-025 | 🟡 Minor | Previous-key rejection had no operator signal. | Added `onPreviousKeyRejected` callback and warning path. `03-02`. |
| PF-026 | 🟡 Minor | Signing-key tests needed explicit seeding. | ST-9 seeds through `ensure()` and uses an independent keypair. `07`. |
| PF-027 | 🟡 Minor | Auth pool disposal and password-change service lookup were missing. | Registered `authDatabase` singleton with disposer; password-change controller uses it. `03-01`. |
| PF-028 | 🟡 Minor | OIDC warning text contradicted itself; redirect behavior needed a decision. | Documented all redirects rejected; removed the warning contradiction. `03-04`. |
| PF-029 | 🟡 Minor | R6 timing side channel remains. | Accepted/documented as residual; status/body oracle closed. `03-06`, `07`. |
| PF-030 | 🔵 Observation | Plan index links to preflight/findings files that did not exist. | Created this report and `05-findings.md`. |

## Iteration 2

The plan documents were revised after the three audits. The critical/major fixes are structural (full control-plane split, completion event, uniform 404 bodies, safe shell helpers). A second semantic re-scan of the revised documents is recorded in the execution plan task 7.1.4; any new Critical/Major blocks completion.

## Post-Implementation Review

A fourth independent reviewer audited the uncommitted implementation. The following findings were fixed before commit:

| PF | Severity | Finding | Resolution |
|---|---|---|---|
| PF-031 | 🔴 Critical | The role-upgrade job ran `ensure-auth-role.sql` as the non-`CREATEROLE` migrator, so `openvault_auth` was never created/altered on an existing database. | The `openvault-roles` job now runs the ensure script as the bootstrap superuser from `postgres_password`; `grants.sql` still runs as the migrator. |
| PF-032 | 🟠 Major | Startup assertion missed `CREATEROLE`, `CREATEDB`, `BYPASSRLS`, app/purger/pruner memberships, and public `CREATE`. | Added the missing attribute, membership, and schema checks; ensure script resets the role attributes. |
| PF-033 | 🟠 Major | Shared app/auth fallback pool was registered twice and disconnected twice on shutdown. | The auth disposer is registered only when the auth pool differs from the app pool. |
| PF-034 | 🟠 Major | `secret.create`/`secret.write` validated body size/expiry/idempotency before authorization, leaking hidden existence. | Authorization now runs before body validation; both paths use `secret_not_found` / `Resource not found`. |
| PF-035 | 🟠 Major | App role could still write `policy_state` and hard-delete/undelete `projects`, reviving inert assignments. | Revoked app writes on `policy_state` and `projects` DELETE; added a project-recovery trigger with an owner-only maintenance bypass. |
| PF-036 | 🟠 Major | `prepare.sh` could write empty secrets when entropy generation failed and read a symlinked password source. | Entropy output is captured and length-checked; empty files are rejected; password sources are checked as non-symlink regular files. |
| PF-037 | 🟠 Major | The role-boundary test reset cluster-wide production role passwords without a guard. | It refuses unless `OPENVAULT_TEST_DISPOSABLE_ROLES=1`; the guard is documented in the test. |
| PF-038 | 🟠 Major | Signing-key triggers did not guard INSERT, allowing an availability attack with a malformed current row. | Documented as limitation #77; it is not a key-forgery path because the KEK cannot be bypassed. |

The revised implementation passed `pnpm verify`, the full integration suite on PostgreSQL 16 (719 tests), and the full integration suite on PostgreSQL 17 (719 tests). The test-only role guard is set in the disposable integration environment.

## Pass Tier

✅ **PASSED WITH NOTES** — all 🔴/🟠 findings have a concrete resolution in the plan. Remaining notes are accepted residual read exposure, timing, and documentation follow-ups. The external review remains the production-release gate.

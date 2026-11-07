# Security Findings Wave 2 — Execution Plan

> **Type**: Feature plan · **Feature**: openvault-v0-1 · **CodeOps Artifact Schema**: 1
> **Progress**: 30/45 tasks (67%)
> **Last Updated**: 2026-11-07 02:05
> **Mode**: `--auto-design` · `--auto-commit`
> **Reasoning**: high — credential handling, database authority, audit integrity, and session security across seven findings

## Objective

Close issues #46–#52 with regression tests, production-safe configuration, and updated security documentation.

## Phase Table

| Phase | Scope | Sessions | Exit condition |
|---|---|---|---|
| 1 | CLI origin binding (#46) | 2 | Mismatched origin receives no bearer; same origin still checks credentials |
| 2 | Secret read audit (#48) | 2 | Allow only after decrypt; integrity failure writes error |
| 3 | Audit prune procedure (#47) | 3 | Pruner has `EXECUTE` only; authorization and receipt work |
| 4 | App role least privilege + backup (#50) | 4 | Explicit app allowlist; review view; dedicated backup role |
| 5 | Join token clipboard (#49) | 2 | 30-second clear survives dialog close and reports status |
| 6 | Scaffold visibility (#51) | 2 | Hidden/missing responses are identical; empty-entries create preserved |
| 7 | Session rotation proof (#52) | 2 | Old cookie needs CSRF proof; receipt and in-flight shortcut are guarded |
| 8 | Full verification and closeout | 1 | Verify + integration on PostgreSQL 16/17 + db types + docs + rescan |

## Execution Rules

- `[ ]` not started; `[~]` implemented, verification pending; `[x]` verified; `[!]` blocked.
- Mark `[~]` immediately after implementation and before verification. Promote to `[x]` only after the task’s verification passes.
- Update the Progress counter and Last Updated stamp after every task.
- Never edit a finding oracle to match an implementation. Schema inventory and role-contract tests are updated deliberately with the schema/grant change; record the exact new counts.
- Every phase runs spec tests → red verification → implementation → green verification → implementation tests → full verify.
- Commit after each verified phase with the active `--auto-commit` mode.
- Keep temporary logs under `$CODEOPS_TMPDIR`; remove them before closeout.

## Phase 1 — CLI origin binding (#46)

### Session 1.1 — Specification tests

- [x] 1.1.1 Add `sameCredentialOrigin` unit tests, the `--url` mismatch test, the `OPENVAULT_URL` mismatch test, the same-origin success test with a request slice, and the malformed-credential test (ST-1…ST-4c).
- [x] 1.1.2 Run the CLI doctor tests and record the red-phase failure: the override origin receives the stored bearer.

### Session 1.2 — Implementation and verification

- [x] 1.2.1 Extract the shared origin helper and apply it in `doctor.ts`; keep TLS/readiness unauthenticated on mismatch.
- [x] 1.2.2 Run the CLI suite and `pnpm verify`; mark phase verified.

## Phase 2 — Secret read audit (#48)

### Session 2.1 — Specification tests

- [x] 2.1.1 Add malformed-newest-version, valid-read, keyring-failure, policy-outage, and parity tests (ST-13…ST-16).
- [x] 2.1.2 Run the secret tests and record the red-phase failure: a failed decrypt still writes `allow`.

### Session 2.2 — Implementation and verification

- [x] 2.2.1 Move the allow write after decrypt, encode, capability lookup, and response construction; write the correct error event on every failure.
- [x] 2.2.2 Run the secret and certificate suites plus `pnpm verify`; mark phase verified.

## Phase 3 — Audit prune procedure (#47)

### Session 3.1 — Specification tests

- [x] 3.1.1 Add role, procedure, replay, success, receipt, and export-hash-record tests (ST-5…ST-12) against a disposable database.
- [x] 3.1.2 Run the new tests and record the red-phase failure: direct pruner delete succeeds.

### Session 3.2 — Schema and procedure

- [x] 3.2.1 Add `audit_prune_authorizations` and `audit_prune_receipts` to `schema.ts`; generate the migration and snapshot.
- [x] 3.2.2 Add the manual procedure migration with cleanup, fixed `search_path`, `session_user` check, and receipt insert.
- [x] 3.2.3 Update `grants.sql`: revoke pruner table/column rights; grant `EXECUTE` only; grant app authorization access.
- [x] 3.2.4 Update the schema inventory tests and counts (`migrations.spec`, `schema.spec`, `schema-identity.impl`).
- [x] 3.2.5 Regenerate `src/database/generated-types.ts` and `ctypes.ts` with `pnpm db:types`.

### Session 3.3 — Application wiring and verification

- [x] 3.3.1 Add `createPruneAuthorization`, hash the export, pass the authorization id, add `authorizationId`/`exportSha256` to the `audit.prune` allowlist and result, and record receipt details.
- [x] 3.3.2 Update the prune CLI wiring, helper (`EXECUTE` only), `resetAuditTables`, and existing prune tests; run the audit prune suites and `pnpm verify`; mark phase verified.

## Phase 4 — App role least privilege + backup (#50)

### Session 4.1 — Specification tests

- [x] 4.1.1 Extend the role test to assert the full app allowlist, every control-plane revocation, the view owner, and the startup read assertion (ST-17…ST-20, ST-25b).
- [x] 4.1.2 Add backup-role, audit-connection, app/auth-role refusal, and schema-inventory tests (ST-21…ST-27b).

### Session 4.2 — Grants and view

- [x] 4.2.1 Add the consumer view to `schema.ts`; generate the view migration; replace blanket grants with the explicit app allowlist; remove app default privileges; add backup default privileges.
- [x] 4.2.2 Add `openvault_backup` to `roles.sql`, `init-roles.sh`, `ensure-backup-role.sql`, `prepare.sh`, and Compose.
- [x] 4.2.3 Update the schema inventory tests and regenerate types for the view.

### Session 4.3 — Backup command

- [x] 4.3.1 Split `runBackup` into dump and audit connections; add `OPENVAULT_BACKUP_DB_URL` and the role/privilege preflight; remove dead `SecretRepository.touchConsumer`.
- [x] 4.3.2 Update backup, configuration, roles, and limitation docs.

### Session 4.4 — Verification

- [x] 4.4.1 Run the role, backup, secret, certificate, scaffold, agent, and audit-prune suites; fix any missed grant.
- [x] 4.4.2 Run `pnpm check:compose` and `pnpm verify`; mark phase verified.

## Phase 5 — Join token clipboard (#49)

### Session 5.1 — Specification tests

- [x] 5.1.1 Add focused/unfocused clear, dialog-close, denied-clear, previous-timer, and generic-copy tests (ST-28…ST-31).
- [x] 5.1.2 Run the web tests and record the red-phase failure: no clear is scheduled.

### Session 5.2 — Implementation and verification

- [x] 5.2.1 Add the shared credential-copy module, page-level status, credential mode on `CopyButton`, and reuse in the identities and secret-detail pages.
- [x] 5.2.2 Run the web suite and `pnpm verify`; mark phase verified.

## Phase 6 — Scaffold visibility (#51)

### Session 6.1 — Specification tests

- [ ] 6.1.1 Add the scaffold visibility matrix, empty-entries create, audit count, and lookup-order tests (ST-32…ST-37).
- [ ] 6.1.2 Run the scaffold tests and record the red-phase failure: 403 vs 422 reveals existence.

### Session 6.2 — Implementation and verification

- [ ] 6.2.1 Apply collection visibility in `scaffold/service.ts`; preserve the org-admin create path and the exact error type.
- [ ] 6.2.2 Run the scaffold and RBAC suites plus `pnpm verify`; mark phase verified.

## Phase 7 — Session rotation proof (#52)

### Session 7.1 — Specification tests

- [ ] 7.1.1 Add no-proof, wrong-proof, correct-proof, replay, in-flight, concurrent-recovery, revoke, password-change, and expiry tests (ST-38…ST-44).
- [ ] 7.1.2 Run the session tests and record the red-phase failure: the old cookie alone or the in-flight shortcut recovers the successor.

### Session 7.2 — Implementation and verification

- [ ] 7.2.1 Add `hashToken`, store the old CSRF hash in receipts and in-flight entries, require the proof, consume the receipt, and pass `x-csrf-token` from the controller.
- [ ] 7.2.2 Run the session and auth suites plus `pnpm verify`; mark phase verified.

## Phase 8 — Full verification and closeout

- [ ] 8.1.1 Run `pnpm verify` from a clean build; capture the PASS one-liner.
- [ ] 8.1.2 Run the full integration suite against PostgreSQL 16 and 17.
- [ ] 8.1.3 Run `pnpm db:types:check` against a migrated database.
- [ ] 8.1.4 Update `docs/security/limitations.md`, `docs/security/threat-model.md`, `docs/security/evidence-matrix.json`, and security claims; run the evidence/claims checks.
- [ ] 8.1.5 Re-run preflight on this plan; resolve any Critical/Major finding; update the preflight report.
- [ ] 8.1.6 Update the feature and portfolio roadmaps; record findings in `05-findings.md`.
- [ ] 8.1.7 Commit and push; close #46–#52 with the merge commit and verification evidence.

## Verify

`pnpm verify`, `pnpm db:types:check`, and `pnpm test:integration` against PostgreSQL 16 and 17.

# Security Findings Remediation — Execution Plan

> **Type**: Feature plan · **Feature**: openvault-v0-1 · **CodeOps Artifact Schema**: 1
> **Progress**: 49/49 tasks (100%)
> **Last Updated**: 2026-11-06 20:52
> **Mode**: `--auto-design` · `--auto-commit`
> **Reasoning**: high — database privilege boundary, authentication, and audit integrity across six security findings

## Objective

Close issues #39–#44 with regression tests, production-safe configuration, and updated security documentation.

## Phase Table

| Phase | Scope | Sessions | Exit condition |
|---|---|---|---|
| 1 | Control-plane database boundary (#41) | 4 | Eight tables split; auth pool wired; role upgrade works; production assertion passes |
| 2 | Signing-key integrity (#39) | 3 | Mismatched previous key rejected; transition matrix enforces lifecycle |
| 3 | Prepare symlink safety (#40) | 3 | Symlinked paths refused; rerun idempotent; normal run unchanged |
| 4 | OIDC endpoint trust (#42) | 3 | All four endpoint origins checked; redirects blocked |
| 5 | Purge evidence (#43) | 3 | Authorization before delete; completion after success; limitation updated |
| 6 | Name enumeration (#44) | 4 | Collection-visibility matrix passes; identical 404 bodies |
| 7 | Full verification and closeout | 1 | Verify + integration + preflight recheck + docs |

## Execution Rules

- `[ ]` not started; `[~]` implemented, verification pending; `[x]` verified; `[!]` blocked with a short reason.
- Mark `[~]` immediately after implementation and before verification. Promote to `[x]` only after the task’s verification passes.
- Update the Progress counter and Last Updated stamp after every task. The execution plan is the single source of truth.
- Never edit a spec test to match an implementation. If a spec test fails, fix the implementation or reopen the ambiguity register.
- Every phase runs spec tests → red verification → implementation → green verification → implementation tests → full verify.
- Commit after each verified task with the active `--auto-commit` mode.
- Keep temporary logs under `$CODEOPS_TMPDIR`; remove them before closeout.

## Phase 1 — Control-plane database boundary (#41)

### Session 1.1 — Specification tests

- [x] 1.1.1 Add `apps/server/tests/integration/security/auth-boundary.spec.test.ts` covering ST-1…ST-8 with disposable roles and migrations owned by a real migrator role.
- [x] 1.1.2 Run the new spec test and record the red-phase failure (roles/assertion/pool missing).

### Session 1.2 — Configuration and composition

- [x] 1.2.1 Add `OPENVAULT_AUTH_DB_URL` / `_FILE` to `apps/server/src/config/loader.ts` and `types.ts`; validate same database and update redaction (AR-4, ST-5).
- [x] 1.2.2 Add the auth pool in `apps/server/src/main.ts`, register it for disposal, and thread `authDatabase` through `SecureApplicationDependencies`, `createApplication`, `createAgentRuntime`, `createPolicyRuntime`, `createAuthPlugin`, and `createIdentityRuntime` (AR-2, AR-3).
- [x] 1.2.3 Move `AgentTokenService`, `DatabaseAgentAuthenticator`, `DatabaseProjectResolver`, `ConsumerRepository`, `AgentJoinService`, `AgentRenewService`, `AgentMaintenanceService`, `AgentConsumerService`, and the password-change transaction to the auth pool (AR-3, ST-7, ST-8).
- [x] 1.2.4 Add `apps/server/src/db/privileges.ts` and the production startup assertion for all verbs, auth superuser/ownership/membership, and required auth grants (AR-14, ST-3, ST-4).

### Session 1.3 — PostgreSQL roles and grants

- [x] 1.3.1 Add `deploy/postgres/ensure-auth-role.sql`, update `roles.sql` and `init-roles.sh`, and run the ensure script from the `openvault-roles` job on every deployment (AR-13).
- [x] 1.3.2 Update `grants.sql` for the eight tables, projects/policy/audit/auth grants, and app revokes; update `prepare.sh` and `compose.yaml` secrets (AR-2, ST-1, ST-2).
- [x] 1.3.3 Add auth role checks to `apps/server/src/ops/kek.ts` and update rotation docs (AR-12).

### Session 1.4 — Implementation tests and verification

- [x] 1.4.1 Add implementation tests for config fallback, auth pool shutdown, role upgrade on an existing database, and restricted auth operations (ST-6…ST-8).
- [x] 1.4.2 Update `docs/reference/configuration.md`, `docs/security/limitations.md`, and the threat model; run targeted tests, `pnpm check:compose`, and `pnpm verify`; mark phase verified.

## Phase 2 — Signing-key integrity (#39)

### Session 2.1 — Specification tests

- [x] 2.1.1 Add ST-9…ST-13 to `apps/server/tests/integration/auth/signing-keys.spec.test.ts` and a schema assertion for the trigger.
- [x] 2.1.2 Run the spec test and record the red-phase failure (mismatched previous key accepted; illegal transition allowed).

### Session 2.2 — Implementation

- [x] 2.2.1 Add `#importPreviousKey` and the rejection callback in `apps/server/src/security/signing-keys.ts`; unwrap, derive, compare, zero (AR-6, AR-7).
- [x] 2.2.2 Add the manual migration with immutable fields and the strict status transition matrix (AR-6, ST-11, ST-12).
- [x] 2.2.3 Pass a structured warning callback from `apps/server/src/auth/plugin.ts`; add an auth readiness detail if practical.

### Session 2.3 — Implementation tests and verification

- [x] 2.3.1 Add implementation tests for invalid tag, mismatch callback, rotation, retirement, and KEK trigger-disable compatibility; update limitation #21.
- [x] 2.3.2 Run signing-key tests and `pnpm verify`; mark phase verified.

## Phase 3 — Prepare symlink safety (#40)

### Session 3.1 — Specification tests

- [x] 3.1.1 Add `apps/server/tests/security/prepare-symlink.spec.test.ts` covering ST-14…ST-20.
- [x] 3.1.2 Run the spec test and record the red-phase failure (chmod/write follows symlinks; rerun overwrites).

### Session 3.2 — Implementation

- [x] 3.2.1 Rewrite `deploy/compose/prepare.sh`: safe path helper, atomic `mktemp`+`mv`, non-empty preservation, directory checks, trailing-slash/`..` rejection, and all Phase 1 auth secrets (AR-8, AR-13).

### Session 3.3 — Implementation tests and verification

- [x] 3.3.1 Add rerun idempotency, path-shape, chown/chmod shim, subdirectory, and `--secrets-only` tests; update `deploy/compose/README.md`.
- [x] 3.3.2 Run `sh -n`, the symlink test, `pnpm check:compose`, and `pnpm verify`; mark phase verified.

## Phase 4 — OIDC endpoint trust (#42)

### Session 4.1 — Specification tests

- [x] 4.1.1 Add ST-21…ST-26 to `apps/server/tests/auth/oidc.impl.test.ts`, `apps/server/tests/config.spec.test.ts`, and `apps/server/tests/integration/auth.oidc.test.ts`.
- [x] 4.1.2 Run the spec tests and record the red-phase failure (cross-origin endpoints accepted; redirects followed).

### Session 4.2 — Implementation

- [x] 4.2.1 Add `originListValue`, `OPENVAULT_OIDC_ENDPOINT_ORIGINS`, `OidcConfig.endpointOrigins`, and redaction output (AR-9, ST-23, ST-24).
- [x] 4.2.2 Validate authorization/token/JWKS/UserInfo endpoints and set `redirect: "error"` in `#timedFetch` (AR-9, ST-21, ST-22, ST-25).

### Session 4.3 — Implementation tests and verification

- [x] 4.3.1 Add per-endpoint tests, redirect-aware stub, config parser cases, and same-origin fixture compatibility; update `docs/reference/configuration.md`.
- [x] 4.3.2 Run OIDC and config tests plus `pnpm verify`; mark phase verified.

## Phase 5 — Purge evidence (#43)

### Session 5.1 — Specification tests

- [x] 5.1.1 Add `apps/server/tests/integration/purge.spec.test.ts` covering ST-27…ST-31.
- [x] 5.1.2 Run the spec test and record the red-phase failure (authorization event after delete; no completion).

### Session 5.2 — Implementation

- [x] 5.2.1 Reorder secret purge: authorization event before delete, completion event after success, error event on failure (AR-10, ST-27…ST-30).
- [x] 5.2.2 Apply the same order to certificate purge in `apps/server/src/certificates/lifecycle.ts` (AR-10, ST-31).

### Session 5.3 — Implementation tests and verification

- [x] 5.3.1 Add delete-failure and completion-failure tests; update limitation #28 and both guides; update the exact-one-allow test.
- [x] 5.3.2 Run purge tests and `pnpm verify`; mark phase verified.

## Phase 6 — Name enumeration (#44)

### Session 6.1 — Specification tests

- [x] 6.1.1 Add ST-32…ST-44 to the secret, consumer-state, certificate read/HTTP, and lifecycle tests; change the existing unassigned expectations deliberately.
- [x] 6.1.2 Run the spec tests and record the red-phase failure (403 for existing names; message mismatch).

### Session 6.2 — Implementation

- [x] 6.2.1 Add `apps/server/src/rbac/collection-visibility.ts` and the mandatory `hideExistence` denial mapping (AR-11).
- [x] 6.2.2 Apply the rule to all name-addressed secret routes, including consumers, and map missing project to `secret_not_found` / `Resource not found` (ST-32…ST-38).
- [x] 6.2.3 Apply the rule to certificate read, readPrivate, list, import/generate, and lifecycle pre-authorization; map missing project to `certificate_not_found` / `Resource not found` (ST-39…ST-44).
- [x] 6.2.4 Ensure exactly one deny audit event per request and preserve the real decision reason.

### Session 6.3 — Implementation tests and verification

- [x] 6.3.1 Add body-equality assertions, project-name hiding, object-scope private-key behavior, and combined-grant cases; update `docs/reference/api.md`, the guides, CLI notes, and the web fake.
- [x] 6.3.2 Run secrets/certificate tests and `pnpm verify`; mark phase verified.

## Phase 7 — Full verification and closeout

- [x] 7.1.1 Run `pnpm verify` from a clean build; capture the PASS one-liner.
- [x] 7.1.2 Run the full integration suite against PostgreSQL 16 and 17.
- [x] 7.1.3 Update `docs/security/limitations.md`, `docs/security/threat-model.md`, `docs/security/evidence-matrix.md`, and security claims; run the evidence/claims checks.
- [x] 7.1.4 Re-run preflight on this plan; resolve any Critical/Major finding; update the preflight report.
- [x] 7.1.5 Update the feature and portfolio roadmaps; record findings in `05-findings.md`.
- [x] 7.1.6 Final commit and push under `--auto-commit`; report cleanup and the six-issue verdict.

## Verify

`pnpm verify` plus `pnpm test:integration` against PostgreSQL 16 and 17.

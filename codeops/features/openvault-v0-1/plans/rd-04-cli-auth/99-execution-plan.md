# Execution Plan: RD-04 CLI Authentication

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-01 03:37
> **Progress**: 69/69 tasks (100%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement RD-04 in five phases: contracts/schema/signing keys, shared login and CLI login,
refresh/logout/bearer authentication, sessions/password-change/retention, and logging/docs/
release verification. Each feature phase follows the mandatory specification-first order:
spec tests, red result, implementation, green result, implementation tests, full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Contracts, schema, signing keys, and JWT | 18 |
| 2 | Shared local login and CLI login | 14 |
| 3 | Refresh, logout, and bearer authentication | 15 |
| 4 | Sessions, password change, and retention | 14 |
| 5 | Redaction, documentation, and release verification | 8 |

**Total: 69 tasks across 5 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the **single source of truth** for progress. Every task line
> appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp —
>    `- [~] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` —
>    `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** (`> **Progress**: X/Y tasks (Z%)`) and the Last Updated
>    stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning the phase sections top-to-bottom: the first `[~]` task is resumed
>    first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line.
>    The plan lifecycle is `Ready`, `Executing`, `Done`, or `Blocked`, derived from these markers.
>
> Timestamps come from `date '+%Y-%m-%d %H:%M'` — never invented.

---

## Phase 1: Contracts, schema, signing keys, and JWT

> **Phase baseline tree**: 40d0fa7d5504404fe0b77d2584327e49945b6920
> **Modification set**: `packages/api-contract/src/cli-auth.ts`, `packages/api-contract/src/index.ts`, `apps/server/src/database/schema.ts`, generated migration/snapshot/types, `apps/server/src/security/keyring.ts`, `apps/server/src/security/signing-keys.ts`, `apps/server/src/auth/cli-jwt.ts`, and the Phase 1 tests
> **Scope mode**: strict
> **Lenses**: security, api-surface, migration
> **Reasoning**: max — key wrapping, signing, and JWT verification are security-critical and
> the schema change is the foundation for every later phase

### Step 1.1: Specification Tests

**Reference**: [03-01](03-01-contracts-schema.md), [03-02](03-02-signing-keys-jwt.md) · [07](07-testing-strategy.md) ST-1–ST-15 · AR-2, AR-3, AR-8, AR-13, AR-17, AR-22, AR-28
**Objective**: Freeze the contracts, schema, key lifecycle, and JWT expectations before code.

- [x] 1.1.1 [spec-author] Write contract tests for ST-1–ST-5 — `packages/api-contract/tests/cli-auth.spec.test.ts` ✅ (completed: 2026-11-01 01:02)
- [x] 1.1.2 [spec-author] Write signing-key lifecycle tests for ST-9–ST-14 — `apps/server/tests/integration/auth/signing-keys.spec.test.ts` ✅ (completed: 2026-11-01 01:02)
- [x] 1.1.3 [spec-author] Write pure JWT verification tests for ST-12–ST-15 — `apps/server/tests/auth/cli-jwt.spec.test.ts` ✅ (completed: 2026-11-01 01:02)
- [x] 1.1.4 [spec-author] Extend schema and migration tests for ST-6–ST-8 — `apps/server/tests/integration/schema.spec.test.ts`, `apps/server/tests/integration/migrations.spec.test.ts` ✅ (completed: 2026-11-01 01:02)
- [x] 1.1.5 Run the Phase 1 spec tests and record the red result ✅ (completed: 2026-11-01 01:02)

### Step 1.2: Implementation

**Reference**: [03-01](03-01-contracts-schema.md) §New contracts, §Database model · [03-02](03-02-signing-keys-jwt.md) §Implementation Details · AR-3, AR-13, AR-17, AR-22, AR-28

- [x] 1.2.1 Add the strict CLI schemas, inferred types, and package exports — `packages/api-contract/src/cli-auth.ts`, `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-01 01:03)
- [x] 1.2.2 Add `signing_keys`, the live-family unique index, and the cleanup expression index to the desired schema — `apps/server/src/database/schema.ts` ✅ (completed: 2026-11-01 01:04)
- [x] 1.2.3 Generate and review the additive `cli-auth` migration and snapshot — `apps/server/migrations/` ✅ (completed: 2026-11-01 01:06)
- [x] 1.2.4 Regenerate and commit database row types and CType constants — `apps/server/src/database/generated-types.ts`, `apps/server/src/database/ctypes.ts` ✅ (completed: 2026-11-01 01:06)
- [x] 1.2.5 Add scoped current/named KEK callbacks to the server keyring provider — `apps/server/src/security/keyring.ts` ✅ (completed: 2026-11-01 01:07)
- [x] 1.2.6 Add Ed25519 key generation, AES-256-GCM seed wrap/unwrap, and the signing-key error types — `apps/server/src/security/signing-keys.ts` ✅ (completed: 2026-11-01 01:08)
- [x] 1.2.7 Add the signing-key repository primitives for advisory-locked ensure, rotate, and retire-due — `apps/server/src/security/signing-keys.ts` ✅ (completed: 2026-11-01 01:09)
- [x] 1.2.8 Add pure `jose` access-token sign/verify helpers matching the fixed claim set — `apps/server/src/auth/cli-jwt.ts` ✅ (completed: 2026-11-01 01:09)
- [x] 1.2.9 Add the signing-key service cache and access-token sign/verify methods — `apps/server/src/security/signing-keys.ts` ✅ (completed: 2026-11-01 01:10)
- [x] 1.2.10 Run the Phase 1 spec tests and verify green ✅ (completed: 2026-11-01 01:11)

### Step 1.3: Implementation Tests and Hardening

- [x] 1.3.1 Write implementation tests for keyring callbacks, wrap AAD/tamper, seed lengths, key-generation errors, cache reload, and due-previous rejection — `apps/server/tests/integration/auth/signing-keys.impl.test.ts` ✅ (completed: 2026-11-01 01:12)
- [x] 1.3.2 Write implementation tests for JWT claim edges and clock tolerance — `apps/server/tests/auth/cli-jwt.impl.test.ts` ✅ (completed: 2026-11-01 01:12)
- [x] 1.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-11-01 01:13)

**Deliverables**:
- Strict CLI contracts exported from `@openvault/api-contract`.
- Reviewed additive migration and regenerated types.
- KEK-wrapped Ed25519 key lifecycle with current/previous/retired states.
- Pure JWT sign/verify helpers with pinned algorithm and claims.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 2: Shared local login and CLI login

> **Phase baseline tree**: e6f6cb56ecb8ee7d1a4e783470c3e407c7c8c5f8
> **Modification set**: `apps/server/src/auth/local-login.ts`, `apps/server/src/auth/login-rate-limits.ts`, `apps/server/src/auth/cli-sessions.ts`, `apps/server/src/auth/cli-auth-service.ts`, `apps/server/src/controllers/cli-auth.ts`, `apps/server/src/auth/plugin.ts`, `apps/server/src/app.ts`, `apps/server/src/controllers/auth.ts`, `apps/server/src/auth/bootstrap.ts`, `apps/server/src/main.ts`, request typing, and the Phase 2 tests/helpers
> **Scope mode**: strict
> **Lenses**: security, api-surface
> **Reasoning**: max — shared lockout and rate-limit buckets are security-critical and the
> login path issues the first credential

### Step 2.1: Specification Tests

**Reference**: [03-03](03-03-local-login-rate-limits.md) · [07](07-testing-strategy.md) ST-16–ST-23 · AR-5, AR-8, AR-15, AR-33
**Objective**: Define CLI login, generic failure, shared lockout, shared buckets, and forced-change login.

- [x] 2.1.1 [spec-author] Write the CLI login and shared-limit integration tests for ST-16–ST-23 — `apps/server/tests/integration/auth.cli-login.spec.test.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.1.2 Run the Phase 2 spec tests and record the red result ✅ (completed: 2026-11-01 01:48)

### Step 2.2: Implementation

**Reference**: [03-03](03-03-local-login-rate-limits.md) §Local login service, §Shared rate limits, §CLI login route · AR-5, AR-8, AR-15, AR-33

- [x] 2.2.1 Extract `LocalLoginService`, normalization, generic failure, and the post-success recheck — `apps/server/src/auth/local-login.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.2 Add the per-app limiter service, account hash, async route wrappers, and refresh-family request field — `apps/server/src/auth/login-rate-limits.ts`, `apps/server/src/types/express.d.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.3 Refactor browser login to use the shared service and limiter wrappers — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.4 Add raw-token generation, hashing, and lock-through-insert family creation with the hash recheck — `apps/server/src/auth/cli-sessions.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.5 Add CLI login token assembly, family issuance, revalidation, and signing — `apps/server/src/auth/cli-auth-service.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.6 Add the CLI login route and controller shell — `apps/server/src/controllers/cli-auth.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.7 Register the login, limiter, CLI-session, signing, and CLI-auth services; register the controller — `apps/server/src/auth/plugin.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.8 Add the idempotent auth bootstrap for signing-key ensure; call it from `main.ts` and CLI integration setup — `apps/server/src/auth/bootstrap.ts`, `apps/server/src/main.ts` ✅ (completed: 2026-11-01 01:48)
- [x] 2.2.9 Run the Phase 2 spec tests and verify green ✅ (completed: 2026-11-01 01:48)

### Step 2.3: Implementation Tests and Hardening

- [x] 2.3.1 Write implementation tests for local-login branches, CAS loss, revalidation, and account keying — `apps/server/tests/auth/local-login.impl.test.ts`, `apps/server/tests/auth/login-rate-limits.impl.test.ts` ✅ (completed: 2026-11-01 01:49)
- [x] 2.3.2 Run the browser login regression integration tests against PostgreSQL — `apps/server/tests/integration/auth.local.test.ts` ✅ (completed: 2026-11-01 01:49)
- [x] 2.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-11-01 01:49)

**Deliverables**:
- One local-login service shared by browser and CLI.
- One per-app set of login limiter buckets.
- CLI login issues a refresh family and access token with no cookie.
- Generic failures, lockout, and forced-change login verified.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 3: Refresh, logout, and bearer authentication

> **Phase baseline tree**: 88301a2028a88ce3f4f915786750e737bc670bb1
> **Modification set**: `apps/server/src/auth/types.ts`, `middleware.ts`, `csrf.ts`, `plugin.ts`, `cli-sessions.ts`, `cli-auth-service.ts`, `controllers/cli-auth.ts`, request typing, and the Phase 3 tests/helpers
> **Scope mode**: strict
> **Lenses**: security, concurrency, api-surface
> **Reasoning**: max — rotation locking, reuse detection, bearer precedence, and the auth
> context split are security- and concurrency-critical

### Step 3.1: Specification Tests

**Reference**: [03-04](03-04-refresh-bearer.md) · [07](07-testing-strategy.md) ST-25–ST-37, ST-49–ST-50 · AR-2, AR-4, AR-6, AR-18, AR-21, AR-22, AR-23, AR-35
**Objective**: Define rotation, reuse, logout, bearer precedence, browser rejection, and refresh limits.

- [x] 3.1.1 [spec-author] Write the refresh, logout, and bearer integration tests for ST-25–ST-37 and ST-49–ST-50 — `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.1.2 Run the Phase 3 spec tests and record the red result ✅ (completed: 2026-11-01 02:15)

### Step 3.2: Implementation

**Reference**: [03-04](03-04-refresh-bearer.md) §Implementation Details · AR-4, AR-6, AR-18, AR-21, AR-22, AR-23

- [x] 3.2.1 Split `AuthContext` into browser/CLI variants, add `requireSession`/`requireCli`/`requirePrincipal`, and narrow existing `req.auth` callers — `apps/server/src/auth/types.ts`, `apps/server/src/auth/middleware.ts`, `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.2 Add the bearer middleware and the no-cookie-fallback rule — `apps/server/src/auth/middleware.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.3 Make Origin and CSRF guards browser-only — `apps/server/src/auth/csrf.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.4 Extend the forced-change gate with the CLI `/cli/me` and logout allowlist — `apps/server/src/auth/middleware.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.5 Add refresh lookup and the one-query active principal/family check — `apps/server/src/auth/cli-sessions.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.6 Add the locked rotation and logout transactions, including reuse and unique-race handling — `apps/server/src/auth/cli-sessions.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.7 Add CLI refresh/logout orchestration and token assembly — `apps/server/src/auth/cli-auth-service.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.8 Add refresh, logout, and `/cli/me` routes — `apps/server/src/controllers/cli-auth.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.9 Install the CLI middleware before the session middleware and update request typing — `apps/server/src/auth/plugin.ts`, `apps/server/src/types/express.d.ts` ✅ (completed: 2026-11-01 02:15)
- [x] 3.2.10 Run the Phase 3 spec tests and verify green ✅ (completed: 2026-11-01 02:15)

### Step 3.3: Implementation Tests and Hardening

- [x] 3.3.1 Write implementation tests for the context union, bearer parsing, no-fallback rule, and browser-only guards; update existing contexts (CSRF spec fixture-only discriminator, assertions unchanged) — `apps/server/tests/auth/middleware.impl.test.ts`, `apps/server/tests/auth/csrf.impl.test.ts`, `apps/server/tests/auth/csrf.spec.test.ts` ✅ (completed: 2026-11-01 02:17)
- [x] 3.3.2 Run the CLI refresh integration suite against PostgreSQL 16 and 17 — `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` ✅ (completed: 2026-11-01 02:17)
- [x] 3.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-11-01 02:17)

**Deliverables**:
- Atomic refresh rotation with absolute family expiry and reuse detection.
- Idempotent logout and immediate family revocation.
- Bearer authentication with principal/family checks and no cookie fallback.
- Browser-only CSRF/Origin and a CLI forced-change gate.
- Refresh IP/family limits.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 4: Sessions, password change, and retention

> **Phase baseline tree**: 38fa2a1464d2de90edb30fd049c8a16edb972f3a
> **Modification set**: `apps/server/src/auth/cli-sessions.ts`, `auth/cli-maintenance.ts`, `auth/bootstrap.ts`, `auth/plugin.ts`, `auth/csrf.ts` (CLI-path guard exemption), `controllers/cli-auth.ts`, `controllers/auth.ts`, `auth/credentials.ts`, `main.ts`, and the Phase 4 tests
> **Scope mode**: strict
> **Lenses**: security, concurrency, migration
> **Reasoning**: max — password-change locking, family revocation, and cleanup can corrupt
> authentication state if ordered incorrectly

### Step 4.1: Specification Tests

**Reference**: [03-05](03-05-sessions-retention.md) · [07](07-testing-strategy.md) ST-24, ST-38–ST-44, ST-51 · AR-7, AR-9, AR-11, AR-16, AR-19, AR-20, AR-24, AR-31, AR-32, AR-33, AR-34
**Objective**: Define family management, password-change revocation, cleanup, and bootstrap.

- [x] 4.1.1 [spec-author] Write the session, password-change, login-race, cleanup, and bootstrap integration tests for ST-24, ST-38–ST-44, and ST-51 — `apps/server/tests/integration/auth.cli-sessions.spec.test.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.1.2 Run the Phase 4 spec tests and record the red result ✅ (completed: 2026-11-01 02:55)

### Step 4.2: Implementation

**Reference**: [03-05](03-05-sessions-retention.md) §Implementation Details · AR-7, AR-9, AR-11, AR-16, AR-19, AR-20, AR-24, AR-31, AR-32

- [x] 4.2.1 Add the family list query and principal-locked owned-family revoke transaction — `apps/server/src/auth/cli-sessions.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.2 Add the bounded 30-day cleanup delete — `apps/server/src/auth/cli-sessions.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.3 Add the CLI session list and delete routes — `apps/server/src/controllers/cli-auth.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.4 Allow the credential password update to run on a transaction handle — `apps/server/src/auth/credentials.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.5 Lock the principal row first, then revoke every CLI family inside the browser password-change transaction — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.6 Add the idempotent maintenance service for startup and 24-hour cleanup — `apps/server/src/auth/cli-maintenance.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.7 Extend the auth bootstrap to retire due keys and start maintenance — `apps/server/src/auth/bootstrap.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.8 Register the maintenance service with its disposal hook — `apps/server/src/auth/plugin.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.2.9 Run the Phase 4 spec tests and verify green ✅ (completed: 2026-11-01 02:55)

### Step 4.3: Implementation Tests and Hardening

- [x] 4.3.1 Write implementation tests for repository result mapping, cleanup bounds, timer idempotence, and bootstrap failure handling — `apps/server/tests/auth/cli-sessions.impl.test.ts`, `apps/server/tests/auth/cli-maintenance.impl.test.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.3.2 Run the CLI session integration suite against PostgreSQL 16 and 17 — `apps/server/tests/integration/auth.cli-sessions.spec.test.ts` ✅ (completed: 2026-11-01 02:55)
- [x] 4.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-11-01 02:55)

**Deliverables**:
- CLI family list and revoke with stable 404 behavior.
- Password change revokes every CLI family in the same transaction.
- 30-day bounded cleanup at startup and every 24 hours.
- Production bootstrap for key ensure and maintenance.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 5: Redaction, documentation, and release verification

> **Phase baseline tree**: 310e23d4689a89ca630affcd4265e58b0c624567
> **Modification set**: `apps/server/src/observability/logger.ts`, `docs/guide/authentication.md`, `docs/security/limitations.md`, reference-doc drift only if found, and the Phase 5 tests
> **Scope mode**: strict
> **Lenses**: security, maintainability
> **Reasoning**: high — the final log and documentation checks are security-facing release gates

### Step 5.1: Specification Tests

**Reference**: [03-02](03-02-signing-keys-jwt.md) §Error handling · [07](07-testing-strategy.md) ST-45–ST-46 · AR-12, AR-28, AR-29
**Objective**: Define nested redaction and captured-log behavior before the final hardening.

- [x] 5.1.1 [spec-author] Write the captured-log and nested-redaction tests for ST-45–ST-46 — `apps/server/tests/integration/auth.cli-logging.spec.test.ts` ✅ (completed: 2026-11-01 03:21)
- [x] 5.1.2 Run the Phase 5 spec tests and record the red result ✅ (completed: 2026-11-01 03:21)

### Step 5.2: Implementation

**Reference**: [03-02](03-02-signing-keys-jwt.md) §Error handling · AR-12, AR-29

- [x] 5.2.1 Add nested access/refresh token redaction paths — `apps/server/src/observability/logger.ts` ✅ (completed: 2026-11-01 03:21)
- [x] 5.2.2 Update the authentication guide and known limitations, including the one-hour account bucket — `docs/guide/authentication.md`, `docs/security/limitations.md` ✅ (completed: 2026-11-01 03:21)
- [x] 5.2.3 Run the Phase 5 spec tests and verify green ✅ (completed: 2026-11-01 03:21)

### Step 5.3: Implementation Tests and Hardening

- [x] 5.3.1 Write implementation tests for redaction path boundaries and stable error bodies — `apps/server/tests/logging.impl.test.ts` ✅ (completed: 2026-11-01 03:21)
- [x] 5.3.2 Run the full release verification and generated-type check — `pnpm verify`, `pnpm db:types:check` ✅ (completed: 2026-11-01 03:21)
- [x] 5.3.3 Cross-check the public API, identity, and crypto docs against the implemented fields and update drift only — `docs/reference/api.md`, `docs/architecture/identity.md`, `docs/architecture/crypto.md` ✅ (completed: 2026-11-01 03:21)

**Deliverables**:
- Nested token redaction with a captured-log proof.
- Authentication guide and limitations aligned with the server behavior.
- Full verification and generated-type checks passing.
- All verification passing.

**Verify**: `pnpm verify`

---

## Dependencies

```
Phase 1: contracts, schema, signing keys, JWT
    ↓
Phase 2: shared login, CLI login, limiter buckets
    ↓
Phase 3: refresh, logout, bearer auth, /cli/me
    ↓
Phase 4: sessions, password change, retention, bootstrap
    ↓
Phase 5: redaction, docs, release verification
```

Phase 1 has no dependency on later phases. Phase 2 needs the signing service from Phase 1.
Phase 3 needs the family-creation and login service from Phase 2. Phase 4 needs the repository
and bearer context from Phase 3. Phase 5 needs the complete request surface and error behavior
from Phases 1–4.

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed.
2. ✅ All verification passing under Node 24.21.0.
3. ✅ No warnings or errors.
4. ✅ No dead code — no unused parameters, functions, classes, or modules.
5. ✅ Security hardened — token validation, key wrapping, auth, rate limits, CSRF scoping, no
   token leakage, and fail-closed key errors.
6. ✅ Documentation updated.
7. ✅ Code reviewed by the assigned correctness, security, and concurrency roles.
8. ✅ Post-completion project re-analysis handled by the exec-plan skill.

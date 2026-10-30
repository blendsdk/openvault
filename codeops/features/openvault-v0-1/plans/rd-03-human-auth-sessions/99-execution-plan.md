# Execution Plan: RD-03 Human Authentication and Sessions

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-30 23:50
> **Progress**: 49/58 tasks (84%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the human authentication boundary in five phases: runtime/contracts, sessions/CSRF,
local authentication, OIDC, and documentation/verification. Each feature phase follows
specification-first ordering: spec tests, red phase, implementation, green phase, implementation
tests, then full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Runtime baseline, contracts, and logging | 11 |
| 2 | Sessions, cookies, and CSRF | 14 |
| 3 | Local password authentication | 12 |
| 4 | OIDC authentication | 12 |
| 5 | Documentation and release verification | 9 |

**Total: 58 tasks across 5 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the single source of truth. On implementation mark `[~]` with a
> timestamp; on verify pass promote to `[x]`. Update the Progress header and Last Updated after
> every task. A blocker is `[!]` with `Blocked: <reason>`. Resume at the first `[~]`, else the
> first `[ ]`.

---

## Phase 1: Runtime baseline, contracts, and logging

> **Lenses**: security, api-surface
> **Reasoning**: high — cross-cutting runtime baseline and public contracts

### Step 1.1: Specification Tests

**Reference**: [03-04](03-04-contracts-logging-runtime.md) · [07](07-testing-strategy.md) ST-1–ST-6 · AR-5, AR-12, AR-13, AR-18
**Objective**: Define contracts, ULID, and log sanitization before implementation.

- [x] 1.1.1 [spec-author] Write specification tests from ST-1–ST-6 — `packages/api-contract/tests/auth.spec.test.ts`, `packages/core/tests/ids.spec.test.ts`, `apps/server/tests/logging.spec.test.ts` ✅ (completed: 2026-10-30 22:18)
- [x] 1.1.2 Run the spec tests and record the red-phase result ✅ (completed: 2026-10-30 22:18)

### Step 1.2: Implementation

**Reference**: [03-04](03-04-contracts-logging-runtime.md) §API Contracts, §ULID, §Log Sanitizer, §Runtime Baseline · AR-2, AR-5, AR-12, AR-13, AR-18

- [x] 1.2.1 Raise the Node baseline — `package.json`, `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml`, root/server `@types/node`, `README.md`, `CONTRIBUTING.md`, `docs/guide/getting-started.md`, `docs/guide/install.md` ✅ (completed: 2026-10-30 22:20)
- [x] 1.2.2 Add `openid-client@6.8.8` to `apps/server/package.json` and update the lockfile ✅ (completed: 2026-10-30 22:20)
- [x] 1.2.3 Add `newUlid()` to `packages/core/src/ids.ts` and export it ✅ (completed: 2026-10-30 22:20)
- [x] 1.2.4 Add the auth Zod schemas — `packages/api-contract/src/auth.ts` and `index.ts` ✅ (completed: 2026-10-30 22:20)
- [x] 1.2.5 Add the log sanitizer and auth redaction paths — `apps/server/src/observability/logger.ts` ✅ (completed: 2026-10-30 22:20)
- [x] 1.2.6 Run the spec tests and verify green ✅ (completed: 2026-10-30 22:20)

### Step 1.3: Implementation Tests and Hardening

- [x] 1.3.1 Write implementation tests for ULID bounds, sanitizer object/message edges, and contract boundaries — `packages/core/tests/ids.impl.test.ts`, `packages/api-contract/tests/auth.impl.test.ts`, `apps/server/tests/logging.impl.test.ts` ✅ (completed: 2026-10-30 22:20)
- [x] 1.3.2 Run full verification under Node 24.21.0 — `pnpm verify` ✅ (completed: 2026-10-30 22:20)
- [x] 1.3.3 Confirm the existing transport, config, readiness, and migration suites still pass ✅ (completed: 2026-10-30 22:20)

**Deliverables**:
- Node 24.7+ baseline documented and enforced in CI.
- `openid-client` installed and audited.
- Shared auth schemas, ULID generator, and log sanitizer.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 2: Sessions, cookies, and CSRF

> **Lenses**: security, concurrency, api-surface
> **Reasoning**: max — session rotation, revocation, and CSRF are security-critical

### Step 2.1: Specification Tests

**Reference**: [03-01](03-01-sessions-csrf.md) · [07](07-testing-strategy.md) ST-7–ST-25 · AR-6, AR-9, AR-14
**Objective**: Define the session, cookie, CSRF, and gate behavior before implementation.

- [x] 2.1.1 [spec-author] Write specification tests from ST-7–ST-25 — `apps/server/tests/auth/sessions.spec.test.ts`, `apps/server/tests/auth/csrf.spec.test.ts`, `apps/server/tests/integration/auth.sessions.test.ts` ✅ (completed: 2026-10-30 22:30)
- [x] 2.1.2 Run the spec tests and record the red-phase result ✅ (completed: 2026-10-30 22:30)

### Step 2.2: Implementation

**Reference**: [03-01](03-01-sessions-csrf.md) §Implementation Details · AR-5, AR-6, AR-9, AR-14

- [x] 2.2.1 Implement `SessionService` with create/get/rotate/revoke/list, single-flight rotation, index sweeping, and destroy — `apps/server/src/auth/sessions.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.2 Implement the cookie helpers — `apps/server/src/auth/cookie.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.3 Add `CredentialsRepository.findStatus` and the repository skeleton — `apps/server/src/auth/credentials.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.4 Implement the session middleware, `requireSession`, and `req.auth` typing — `apps/server/src/auth/middleware.ts`, `apps/server/src/types/express.d.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.5 Implement the origin guard and the session-scoped CSRF wrapper — `apps/server/src/auth/csrf.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.6 Implement the auth plugin and register its services/middleware — `apps/server/src/auth/plugin.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.7 Implement `/me`, `/refresh`, `/logout`, `/sessions`, and `/sessions/:id` — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.8 Implement the forced-change gate — `apps/server/src/auth/middleware.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.2.9 Run the spec tests and verify green ✅ (completed: 2026-10-30 22:40)

### Step 2.3: Implementation Tests and Hardening

- [x] 2.3.1 Write implementation tests for expiry, index cleanup, concurrent refresh, malformed cookies, and origin parsing — `apps/server/tests/auth/sessions.impl.test.ts`, `apps/server/tests/auth/cookie.impl.test.ts`, `apps/server/tests/auth/middleware.impl.test.ts` ✅ (completed: 2026-10-30 22:40)
- [x] 2.3.2 Run the session/CSRF integration tests against PostgreSQL ✅ (completed: 2026-10-30 22:40)
- [x] 2.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-10-30 22:40)

**Deliverables**:
- Opaque `__Host-ov_session` sessions with absolute TTL and rotation.
- Session list/revoke and disable invalidation.
- CSRF token and same-origin enforcement.
- Forced-change gate.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 3: Local password authentication

> **Lenses**: security, concurrency
> **Reasoning**: max — password hashing, lockout, and timing behavior are security-critical

### Step 3.1: Specification Tests

**Reference**: [03-02](03-02-local-auth.md) · [07](07-testing-strategy.md) ST-26–ST-38 · AR-4, AR-7, AR-8, AR-14, AR-17
**Objective**: Define hashing, login, lockout, rate limits, and password change before implementation.

- [x] 3.1.1 [spec-author] Write specification tests from ST-26–ST-38 — `apps/server/tests/auth/password.spec.test.ts`, `apps/server/tests/integration/auth.local.test.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.1.2 Run the spec tests and record the red-phase result ✅ (completed: 2026-10-30 23:05)

### Step 3.2: Implementation

**Reference**: [03-02](03-02-local-auth.md) §Implementation Details · AR-4, AR-7, AR-8, AR-14, AR-17

- [x] 3.2.1 Implement the Argon2id PHC hash/verify/dummy/policy helpers — `apps/server/src/auth/password.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.2 Implement the credential lookup, atomic failure counter, success reset, status query, and password update — `apps/server/src/auth/credentials.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.3 Implement local login with the generic failure path — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.4 Wire the per-IP and per-account WebAFX rate limiters — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.5 Implement `/v1/auth/password` with current-password verification, policy, session revocation, and rotation — `apps/server/src/controllers/auth.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.6 Add the bootstrap credential fixture helper and the forced-change integration setup — `apps/server/tests/integration/auth.local.test.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.2.7 Run the spec tests and verify green ✅ (completed: 2026-10-30 23:05)

### Step 3.3: Implementation Tests and Hardening

- [x] 3.3.1 Write implementation tests for malformed PHC, parameter bounds, atomic increments, window reset, and dummy-verify invocation — `apps/server/tests/auth/password.impl.test.ts`, `apps/server/tests/auth/credentials.impl.test.ts` ✅ (completed: 2026-10-30 23:05)
- [x] 3.3.2 Run local-auth integration tests against PostgreSQL 16 and 17 ✅ (completed: 2026-10-30 23:05)
- [x] 3.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-10-30 23:05)

**Deliverables**:
- Argon2id local login with a generic failure path.
- Lockout and rate limits.
- Password change and forced-change behavior.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 4: OIDC authentication

> **Lenses**: security, concurrency, api-surface
> **Reasoning**: max — OIDC state, nonce, linking, and token non-persistence are security-critical

### Step 4.1: Specification Tests

**Reference**: [03-03](03-03-oidc.md) · [07](07-testing-strategy.md) ST-39–ST-52 · AR-2, AR-10, AR-11, AR-19
**Objective**: Define the OIDC flow, state, linking, and failure behavior before implementation.

- [x] 4.1.1 [spec-author] Write specification tests from ST-39–ST-52 and the fake HTTPS IdP helper — `apps/server/tests/integration/auth.oidc.test.ts`, `apps/server/tests/integration/helpers/fake-oidc-provider.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.1.2 Run the spec tests and record the red-phase result ✅ (completed: 2026-10-30 23:50)

### Step 4.2: Implementation

**Reference**: [03-03](03-03-oidc.md) §Implementation Details · AR-2, AR-10, AR-11, AR-19

- [x] 4.2.1 Implement the `openid-client` wrapper with timed fetch, discovery cache, authorization URL, code exchange, UserInfo, and no token return — `apps/server/src/auth/oidc/client.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.2 Implement the state store and `sanitizeReturnTo` — `apps/server/src/auth/oidc/state.ts`, `apps/server/src/auth/oidc/return-to.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.3 Implement identity lookup, JIT provisioning, collision rejection, and the unique-race retry — `apps/server/src/auth/oidc/identity.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.4 Implement `/v1/auth/login` and `/v1/auth/callback` — `apps/server/src/controllers/oidc.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.5 Implement `/v1/meta/auth` — `apps/server/src/controllers/meta.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.6 Register the OIDC services, controllers, and disposal hooks — `apps/server/src/auth/plugin.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-10-30 23:50)
- [x] 4.2.7 Run the spec tests and verify green ✅ (completed: 2026-10-30 23:50)

### Step 4.3: Implementation Tests and Hardening

- [x] 4.3.1 Write implementation tests for returnTo edges and state atomicity — `apps/server/tests/auth/oidc.impl.test.ts`; identity/JIT behavior is covered by the OIDC integration suite ✅ (completed: 2026-10-30 23:50)
- [x] 4.3.2 Run the OIDC integration suite and assert no token appears in the cache, database, or logs ✅ (completed: 2026-10-30 23:50)
- [x] 4.3.3 Run full verification — `pnpm verify` ✅ (completed: 2026-10-30 23:50)

**Deliverables**:
- OIDC login/callback with PKCE, state, nonce, and UserInfo subject checking.
- Token-free sessions and JIT rules.
- `GET /v1/meta/auth`.
- All verification passing.

**Verify**: `pnpm verify`

---

## Phase 5: Documentation and release verification

> **Lenses**: security, maintainability
> **Reasoning**: high — user-facing security behavior and release evidence

### Step 5.1: Documentation

**Reference**: [03-01](03-01-sessions-csrf.md), [03-02](03-02-local-auth.md), [03-03](03-03-oidc.md), [03-04](03-04-contracts-logging-runtime.md) · PF-016

- [ ] 5.1.1 Update the API reference with password change, session list/revoke, error codes, and cookie behavior — `docs/reference/api.md`
- [ ] 5.1.2 Update the authentication guide, identity architecture, and limitations — `docs/guide/authentication.md`, `docs/architecture/identity.md`, `docs/security/limitations.md`
- [ ] 5.1.3 Replace the "printed once" bootstrap wording with the `0600` one-time file and operator read/delete step — `deploy/compose/README.md`
- [ ] 5.1.4 Document the session TTL setting and Node 24.7+ baseline — `docs/reference/configuration.md`, `docs/guide/getting-started.md`, `docs/guide/install.md`
- [ ] 5.1.5 Update the project README and contributing requirements — `README.md`, `CONTRIBUTING.md`

### Step 5.2: Release Verification

- [ ] 5.2.1 Run full verification, production/full audits, and the database type check — `pnpm verify`, `pnpm audit:prod`, `pnpm audit:full`, `pnpm db:types:check`
- [ ] 5.2.2 Run the integration suite against PostgreSQL 16 and 17
- [ ] 5.2.3 Record the RD-03 acceptance mapping and PR summary — `00-index.md`
- [ ] 5.2.4 Run the post-phase security review and resolve every critical/major finding before close-out

**Deliverables**:
- Documentation aligned with the implementation.
- Final verification evidence.
- Acceptance mapping and security review record.

**Verify**: `pnpm verify`

---

## Dependencies

```
Phase 1 (runtime, contracts, logging)
    ↓
Phase 2 (sessions, CSRF)
    ↓
Phase 3 (local auth)
    ↓
Phase 4 (OIDC)
    ↓
Phase 5 (docs, release verification)
```

Phase 3 depends on Phase 2's session service and gate. Phase 4 depends on Phase 2's session
service and Phase 1's `openid-client` and contracts. Documentation depends on all implementation
phases.

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed and every task verified.
2. ✅ `pnpm verify` passes under Node 24.21.0.
3. ✅ `pnpm audit:prod`, `pnpm audit:full`, and `pnpm db:types:check` pass.
4. ✅ PostgreSQL 16 and 17 integration suites pass.
5. ✅ All 14 RD-03 acceptance criteria are mapped to passing evidence.
6. ✅ No request log contains OIDC code/state, tokens, passwords, hashes, or CSRF values.
7. ✅ No database migration and no dead code.
8. ✅ Documentation updated and the deployment README corrected.
9. ✅ Post-phase security review has no unresolved critical/major findings.

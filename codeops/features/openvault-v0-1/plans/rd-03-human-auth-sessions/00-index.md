# RD-03 Human Authentication and Sessions Implementation Plan

> **Feature**: Local password login, OIDC authorization-code login, opaque browser sessions, CSRF protection, lockout, and session management.
> **Status**: Planning Complete
> **Created**: 2026-10-30 21:55
> **Preflight**: [00-preflight-report-RD-03.md](../../requirements/00-preflight-report-RD-03.md) — 17 findings resolved
> **Implements**: openvault-v0-1/RD-03
> **CodeOps Artifact Schema**: 1
> **Execution commit mode**: auto-commit (requested for the execution run)

## Overview

RD-03 adds the human authentication boundary to the OpenVault server. A user can sign in with a
local password or through an OIDC authorization-code flow with PKCE. Both paths end in one opaque
browser session identified by the `__Host-ov_session` cookie. The browser never receives an OIDC
access, refresh, or ID token. Sessions live in the in-memory cache, use an absolute lifetime, and
rotate their secret and CSRF token on refresh. The server protects unsafe browser requests with a
session-bound CSRF token and a same-origin check.

The plan reuses the RD-02 transport, configuration, PostgreSQL adapter, WebAFX routing, WebAFX
rate limiter, WebAFX CSRF middleware, and the memory cache package. It adds the approved
`openid-client` dependency for the OIDC protocol and raises the Node.js baseline to 24.7+ so
password hashing uses the built-in `crypto.argon2` instead of a native package. It adds no database
migration: the existing `principals`, `local_credentials`, and `oidc_identities` tables cover the
model.

## Minimum-Sufficient Baseline

**Original goal:** Humans can sign in locally or through OIDC and obtain a secure browser session
that the rest of OpenVault can trust.

**Smallest viable design:** One auth plugin that installs a session service, credentials
repository, password hasher, OIDC client, session/CSRF middleware, and three small controllers
(auth, OIDC, meta). The session store is the existing memory cache. Rate limiting and CSRF use the
existing WebAFX middleware. OIDC uses the approved `openid-client` library with a timed fetch.
Password hashing uses the Node 24.7+ built-in `crypto.argon2`. No schema migration is needed.

**Excluded machinery:** A Postgres session table, Redis, a custom rate limiter, a custom Argon2
implementation, the WebAFX OIDC controller (it stores tokens), a second web framework, a policy
engine, and an external IdP in tests.

**Approved complexity:** `openid-client` (PF-001 / CE-1, user approved). Node 24.7+ baseline
(PF-002 / CE-2, user chose the built-in API). No other new production dependency.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and delegated provenance |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Delta view of RD-03 and plan-local decisions |
| 02 | [Current State](02-current-state.md) | Existing auth-related code and gaps |
| 03-01 | [Sessions, Cookies, and CSRF](03-01-sessions-csrf.md) | Session service, cookie attributes, rotation, CSRF, origin guard |
| 03-02 | [Local Authentication](03-02-local-auth.md) | Argon2id, login, lockout, rate limits, password change |
| 03-03 | [OIDC Authentication](03-03-oidc.md) | Discovery, state, callback, linking/JIT, failure handling |
| 03-04 | [Contracts, Logging, and Runtime](03-04-contracts-logging-runtime.md) | Shared schemas, log sanitizer, Node baseline |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases ST-1…ST-42 and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Usage Examples

```bash
# Local login (HTTPS admin listener; the cookie is Secure and HttpOnly)
curl -i -c jar -X POST https://vault.example.com/v1/auth/local/login \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://vault.example.com' \
  -d '{"identifier":"admin@example.com","password":"..."}'

# Read the session and CSRF token
curl -b jar https://vault.example.com/v1/auth/me

# Change the bootstrap password
curl -i -b jar -X POST https://vault.example.com/v1/auth/password \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"currentPassword":"...","newPassword":"..."}'

# Rotate the session
curl -i -b jar -c jar -X POST https://vault.example.com/v1/auth/refresh \
  -H "X-CSRF-Token: $CSRF"
```

### Key Decisions

| Decision | Outcome |
|---|---|
| Password hashing | Node 24.7+ built-in `crypto.argon2`, PHC `$argon2id$` string |
| OIDC implementation | `openid-client` 6.8.8 direct, timed fetch, no token storage |
| OIDC linking | `(issuer, subject)` only; `email_verified`; JIT only for unused emails |
| Session lifetime | `OPENVAULT_SESSION_TTL_HOURS` (default 8), absolute |
| Session rotation | New secret and CSRF token; stable public ULID; same expiry |
| CSRF | WebAFX token middleware scoped to sessions + separate origin guard |
| Lockout | Five failures in a rolling 15-minute window for 15 minutes |
| Rate limits | WebAFX per-IP 5/min, then per-account 10/hour |
| API contracts | Shared Zod schemas in `@openvault/api-contract` |
| Logging | Pino sanitizer strips query strings and auth fields |

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| security-auditor | reviewer | Every phase that touches auth, crypto, sessions, or CSRF | AR-18 (feature set) |
| design-challenger | reviewer | OIDC, session, and password-change decisions | AR-18 (feature set) |
| correctness-reviewer | reviewer | Every executed phase | quality profile |
| concurrency-auditor | reviewer | Session rotation and lockout updates | AR-6, AR-7 |

_Detection evidence: RD-03 is an authentication and session feature; the feature-set register AR-18 requires one `security-auditor` gate per security-sensitive phase and a `design-challenger` on auth/crypto. The repo's quality profile enables independent review and stops on major findings (`codeops/codeops.json`)._

## Related Files

**New server files**
- `apps/server/src/auth/password.ts`
- `apps/server/src/auth/credentials.ts`
- `apps/server/src/auth/sessions.ts`
- `apps/server/src/auth/cookie.ts`
- `apps/server/src/auth/csrf.ts`
- `apps/server/src/auth/middleware.ts`
- `apps/server/src/auth/plugin.ts`
- `apps/server/src/auth/types.ts`
- `apps/server/src/auth/oidc/client.ts`
- `apps/server/src/auth/oidc/state.ts`
- `apps/server/src/auth/oidc/identity.ts`
- `apps/server/src/auth/oidc/return-to.ts`
- `apps/server/src/auth/oidc/binding.ts`
- `apps/server/src/auth/oidc/errors.ts`
- `apps/server/src/controllers/auth.ts`
- `apps/server/src/controllers/oidc.ts`
- `apps/server/src/controllers/meta.ts`

**New contract and core files**
- `packages/api-contract/src/auth.ts`
- `packages/core/src/ids.ts` (add `newUlid`)
- `packages/core/tests/ids.spec.test.ts` (extend)

**Modified server files**
- `apps/server/src/app.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/src/types/express.d.ts`
- `apps/server/package.json`

**Modified workspace and docs**
- `package.json`, `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml`
- `README.md`, `CONTRIBUTING.md`, `docs/guide/getting-started.md`, `docs/guide/install.md`
- `docs/reference/api.md`, `docs/reference/configuration.md`
- `docs/guide/authentication.md`, `docs/architecture/identity.md`
- `docs/security/limitations.md`, `deploy/compose/README.md`

**Tests**
- `packages/api-contract/tests/auth.spec.test.ts`
- `apps/server/tests/auth/password.spec.test.ts`
- `apps/server/tests/auth/sessions.spec.test.ts`
- `apps/server/tests/auth/csrf.spec.test.ts`
- `apps/server/tests/auth/*.impl.test.ts`
- `apps/server/tests/integration/auth.local.test.ts`
- `apps/server/tests/integration/auth.sessions.test.ts`
- `apps/server/tests/integration/auth.oidc.test.ts`
- `apps/server/tests/integration/helpers/fake-oidc-provider.ts`

## Acceptance Mapping

| RD-03 criterion | Evidence |
|---|---|
| 1. Local login returns a hardened cookie | `auth.local.test.ts` — valid login and cookie attributes |
| 2. Generic 401 and comparable timing | `auth.local.test.ts` — unknown, wrong, disabled, locked; each generic path spends one Argon2 derivation (the 50 ms p95 difference is not separately measured) |
| 3. Five failures lock the account | `auth.local.test.ts` — lockout and lock-expiry tests |
| 4. Bootstrap password handling and forced change | RD-03 portion: `auth.local.test.ts` forced-change test and logger non-persistence. Provisioning/`0600` file lifecycle is RD-11/RD-13 |
| 5. OIDC valid callback and rejection paths | `auth.oidc.test.ts` — valid, bad nonce, bad/replayed state, UserInfo `sub`, binding |
| 6. Tokens absent from cache/database/logs | `auth.oidc.test.ts` — token non-persistence test |
| 7. Refresh rotates the session | `auth.sessions.test.ts`; the old secret no longer authenticates, while a concurrent/retried refresh within 10s receives the same new secret |
| 8. CSRF token enforcement | `csrf.spec.test.ts` and session integration tests |
| 9. Cross-origin mutation rejected | `csrf.spec.test.ts` — evil Origin, `same-site`, missing headers |
| 10. Disabled principal invalidated | `auth.sessions.test.ts` — `/me` 401 and session deletion |
| 11. `/v1/meta/auth` only booleans | `auth.oidc.test.ts` — configured and unconfigured |
| 12. Session list/revoke | `auth.sessions.test.ts` — list, owner revoke, foreign 404 |
| 13. Password change | `auth.local.test.ts` — current password, policy, revocation, rotation, concurrent CAS |
| 14. Security requirements verified | Phase security audits (no unresolved critical/major) plus the tests above |

## PR Summary

**Title:** `feat: human authentication and sessions`

**Summary:**
- Local Argon2id login with generic failures, rolling lockout, per-IP/per-account limits, and password change.
- OIDC authorization-code login with PKCE S256, state, nonce, browser binding, UserInfo subject checking, and token discard.
- Opaque `__Host-ov_session` sessions with absolute expiry, refresh rotation, list/revoke, and disable invalidation.
- Per-session CSRF plus same-origin enforcement, and a forced-change gate.
- Shared auth contracts, request-log sanitization, Node 24.7+, and the approved `openid-client` dependency.

**Evidence:** `pnpm verify`; `pnpm audit:prod`; `pnpm audit:full`; `pnpm db:types:check`; PostgreSQL 16 and 17 integration suites (115 tests each); 143 unit tests.

**Known limitations:** sessions, OIDC state, lockout, and rate limits are process-local; `ov init` provisioning lands in RD-11/RD-13; JIT users have no roles until RD-06; lockout can be used for targeted denial of service; the forced-change flow does not require a different password.

**Deferred owners:** `ov init`/bootstrap file → RD-11/RD-13; RBAC role assignment and admin OIDC linking → RD-06; audit persistence → RD-07; OIDC identity rows for CLI/agent → RD-04/RD-05; UI → RD-12; release image hardening → RD-14.

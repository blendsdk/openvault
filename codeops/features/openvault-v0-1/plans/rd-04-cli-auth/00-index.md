# RD-04 CLI Authentication Implementation Plan

> **Feature**: Server-side CLI authentication with Ed25519 access tokens, rotating refresh families, signing-key lifecycle, shared lockout, and revocation.
> **Status**: Planning Complete
> **Created**: 2026-11-01 00:38
> **Preflight**: [00-preflight-report-RD-04.md](../../requirements/00-preflight-report-RD-04.md) — 12 findings resolved
> **Implements**: openvault-v0-1/RD-04
> **CodeOps Artifact Schema**: 1
> **Execution commit mode**: auto-commit (requested for the execution run)

## Overview

RD-04 adds the server half of CLI authentication. A human signs in with the same local
credential that the browser uses, but receives an Ed25519 JWT and an opaque rotating refresh
token instead of a cookie. Access tokens live for 15 minutes. A refresh family lives for 12
hours absolute from login and is revoked by reuse, logout, password change, or principal
disable. Every bearer request checks both the principal status and a live family row, so
revocation takes effect on the next request.

The plan also adds the signing-key lifecycle. The Ed25519 seed is generated once, wrapped by
the current KEK, and stored in a dedicated `signing_keys` table. The current key signs;
current and previous keys verify during one access-token lifetime plus clock skew. The plan
extends the existing browser authentication context into a discriminated browser/CLI model so
cookie CSRF and Origin checks never apply to bearer requests.

The CLI binary, credential file, argv handling, and client logs remain RD-11 work. This plan
stops at the server contract and its tests.

## Minimum-Sufficient Baseline

**Original goal:** A human can authenticate to the OpenVault server from the `ov` CLI and use a
short-lived, revocable credential.

**Smallest viable design:** Extend the existing auth plugin with a small CLI service layer: a
`signing_keys` table, a KEK-wrapped Ed25519 signer, a `cli_sessions` repository built on the
table that already exists, a shared `LocalLoginService`, one CLI controller, and a discriminated
auth context. Reuse `jose`, the existing PostgreSQL adapter and transaction helper, the existing
WebAFX rate limiter, the existing password verifier, and the existing lockout state. No new
production dependency.

**Excluded machinery:** A JWKS endpoint, CLI-side JWT verification, a new auth provider, a
separate cache or Redis, a new test runner, a CLI package, a credential-file store, a public key
rotation API, and a generalized rate-limit store.

**Approved complexity:** None beyond the preflighted RD-04 design. The new table, migration,
and service are ordinary feature code required by the accepted requirement. No new dependency
or framework is added.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and delegated provenance |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Delta view of RD-04 and plan-local decisions |
| 02 | [Current State](02-current-state.md) | Existing auth, schema, keyring, and test boundaries |
| 03-01 | [Contracts and Schema](03-01-contracts-schema.md) | Zod CLI contracts, `signing_keys`, indexes, migration |
| 03-02 | [Signing Keys and JWT](03-02-signing-keys-jwt.md) | KEK wrapping, ensure/rotate/retire, sign/verify |
| 03-03 | [Local Login and Rate Limits](03-03-local-login-rate-limits.md) | Shared verifier, lockout, shared limiter instances, CLI login |
| 03-04 | [Refresh, Logout, and Bearer Authentication](03-04-refresh-bearer.md) | Rotation transaction, reuse detection, auth context, `/cli/me` |
| 03-05 | [Sessions, Revocation, and Retention](03-05-sessions-retention.md) | Family list/revoke, password-change revocation, cleanup |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Usage Examples

```bash
# Log in and receive an access token plus a refresh token
curl -sS -X POST https://vault.example.com/v1/auth/cli/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"alice@example.com","password":"..."}'

# Read the current CLI user
curl -sS https://vault.example.com/v1/auth/cli/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Rotate the refresh token
curl -sS -X POST https://vault.example.com/v1/auth/cli/refresh \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"

# List and revoke CLI families
curl -sS https://vault.example.com/v1/auth/cli/sessions \
  -H "Authorization: Bearer $ACCESS_TOKEN"
curl -sS -X DELETE https://vault.example.com/v1/auth/cli/sessions/$FAMILY_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Key Decisions

| Decision | Outcome | AR |
|---|---|---|
| Scope | Server API only; client file and argv behavior remain RD-11 | AR-1 |
| Access token | Ed25519 JWT, 15 minutes, minimal claims, `sid = family_id` | AR-2 |
| Refresh token | 32 random bytes as 43-character base64url; SHA-256 at rest; 12-hour absolute family | AR-2, AR-6 |
| Signing key | Dedicated table; KEK-wrapped seed; current/previous/retired; 30-second warm-cache refresh | AR-3, AR-17, AR-37 |
| Auth context | Discriminated browser/CLI union; browser-only CSRF and Origin; forced-change logout stays available | AR-4, AR-18, AR-35 |
| Login | Shared verifier, lockout, generic failure, and limiter buckets; principal lock through CLI family insert | AR-5, AR-15, AR-33 |
| Refresh concurrency | Principal lock, row lock, partial unique index, family revoke on reuse | AR-6, AR-23 |
| Password change | Revoke every CLI family in the same transaction | AR-7 |
| Contracts | Strict Zod schemas with distinct access/refresh expiries | AR-8 |
| Sessions | CLI-bearer-only family list/revoke; `createdAt` is family creation; delete takes the principal lock | AR-9, AR-19, AR-20, AR-34 |
| Retention | 30 days after the later of expiry/revocation; bounded daily cleanup; initial failure is logged | AR-11, AR-24, AR-32 |
| Redaction | Nested token body paths plus captured-log test | AR-12 |
| Malformed family id | `404 session_not_found`, same as an unknown or foreign family | AR-31 |
| Bootstrap | Production entry point ensures the key and starts maintenance; lazy ensure on first use | AR-16 |
| Testing | Real PostgreSQL, real crypto, pure JWT unit tests, no new harness | AR-26 |

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| correctness-reviewer | reviewer | Every executed phase | AR-30 |
| security-auditor | reviewer | Phases 1–4: token signing, wrapping, login, refresh, bearer, revocation | AR-30 |
| concurrency-auditor | reviewer | Phases 2–4: shared counters, refresh rotation, password-change locking, key lifecycle | AR-30 |

**No project-specific specialist is proposed.** The capability-gap check found no durable
project invariant that a new role would carry better than the catalog roles plus a dynamic
packet.

_Detection evidence: RD-04 is an authentication-protocol feature with database concurrency
(`apps/server/src/auth/credentials.ts:170-251`, `apps/server/src/auth/sessions.ts:493-511`) and
key-wrapping code (`apps/server/src/security/keyring.ts:23-112`). The existing
`security-auditor`, `concurrency-auditor`, and `correctness-reviewer` roles cover those risks;
no repeated CLI-auth finding pattern exists yet._

## Related Files

**New server files**
- `apps/server/src/auth/local-login.ts`
- `apps/server/src/auth/login-rate-limits.ts`
- `apps/server/src/auth/cli-sessions.ts`
- `apps/server/src/auth/cli-jwt.ts`
- `apps/server/src/auth/cli-auth-service.ts`
- `apps/server/src/auth/cli-maintenance.ts`
- `apps/server/src/auth/bootstrap.ts`
- `apps/server/src/controllers/cli-auth.ts`
- `apps/server/src/security/signing-keys.ts`

**New contract files**
- `packages/api-contract/src/cli-auth.ts`

**Modified server files**
- `apps/server/src/auth/types.ts`
- `apps/server/src/auth/middleware.ts`
- `apps/server/src/auth/csrf.ts`
- `apps/server/src/auth/plugin.ts`
- `apps/server/src/auth/credentials.ts`
- `apps/server/src/controllers/auth.ts`
- `apps/server/src/security/keyring.ts`
- `apps/server/src/database/schema.ts`
- `apps/server/src/database/generated-types.ts`
- `apps/server/src/database/ctypes.ts`
- `apps/server/src/types/express.d.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/src/app.ts`
- `apps/server/src/main.ts`

**New database artifacts**
- One generated `apps/server/migrations/*_cli-auth.up.sql`
- Updated `apps/server/migrations/schema.snapshot.json`

**Modified contracts and docs**
- `packages/api-contract/src/index.ts`
- `docs/guide/authentication.md`
- `docs/security/limitations.md`
- `docs/reference/api.md` and architecture docs only if implementation reveals drift

**Tests**
- `packages/api-contract/tests/cli-auth.spec.test.ts`
- `apps/server/tests/integration/auth/signing-keys.spec.test.ts`
- `apps/server/tests/auth/cli-jwt.spec.test.ts`
- `apps/server/tests/auth/local-login.spec.test.ts`
- `apps/server/tests/auth/login-rate-limits.spec.test.ts`
- `apps/server/tests/integration/auth.cli-login.spec.test.ts`
- `apps/server/tests/integration/auth.cli-refresh.spec.test.ts`
- `apps/server/tests/integration/auth.cli-sessions.spec.test.ts`
- `apps/server/tests/integration/auth.cli-logging.spec.test.ts`
- Implementation tests under `apps/server/tests/auth/*.impl.test.ts`
- Existing schema, migration, CSRF, middleware, session, and logging tests updated

## Acceptance Mapping

| RD-04 criterion | Evidence |
|---|---|
| 1. Valid login returns JWT and refresh token | `auth.cli-login.spec.test.ts`; `cli-auth.spec.test.ts`; ST-12, ST-16 |
| 2. Only the refresh hash is stored | `auth.cli-login.spec.test.ts`; database and captured-log checks; ST-17 |
| 3. Refresh rotates and keeps family expiry | `auth.cli-refresh.spec.test.ts`; ST-25 |
| 4. Reuse and concurrent refresh revoke the family | `auth.cli-refresh.spec.test.ts`; ST-26–ST-27 |
| 5. Logout revokes the family and is idempotent | `auth.cli-refresh.spec.test.ts`; ST-28–ST-29 |
| 6. Disable invalidates refresh and access | `auth.cli-refresh.spec.test.ts`; ST-30 |
| 7. Password change revokes every CLI family | `auth.cli-sessions.spec.test.ts`; ST-41–ST-42 |
| 8. Bearer verification and browser rejection | `auth.cli-refresh.spec.test.ts`; `cli-jwt.spec.test.ts`; ST-15, ST-31–ST-34 |
| 9. First key, rotation, previous, retired, no raw seed | `signing-keys.spec.test.ts`; ST-9–ST-14 |
| 10. Shared lockout and rate-limit buckets | `auth.cli-login.spec.test.ts`; ST-18–ST-22 |
| 11. Strict contracts, distinct expiries, logout validation | `cli-auth.spec.test.ts`; ST-1–ST-5, ST-16, ST-29 |
| 12. CLI family list and revoke | `auth.cli-sessions.spec.test.ts`; ST-38–ST-40, ST-51 |
| 13. Refresh limits | `auth.cli-refresh.spec.test.ts`; ST-49–ST-50 |
| 14. Retention cleanup | `auth.cli-sessions.spec.test.ts`; ST-43 |
| 15. No tokens in logs or error bodies | `auth.cli-logging.spec.test.ts`; ST-45–ST-46 |
| 16. Security requirements verified | Phase audits plus all tests above |

## PR Summary

**Title:** `feat: CLI authentication`

**Summary:**
- Ed25519 JWT access tokens with KEK-wrapped signing keys and current/previous verification.
- Rotating refresh families with absolute expiry, reuse detection, logout, and password-change revocation.
- Shared local login, lockout, generic failure, and per-IP/per-account limiter buckets.
- Discriminated browser/CLI auth context, bearer-only CLI routes, and browser-only CSRF.
- Shared CLI contracts, CLI family list/revoke, retention cleanup, and nested log redaction.

**Evidence:** `pnpm verify`; PostgreSQL integration suites; captured-log assertions; generated
database types and migration validation.

**Known limitations:** refresh rate-limit buckets are process-local; signing-key rotation is an
internal method with no operator route in this release; CLI credential-file behavior is RD-11.

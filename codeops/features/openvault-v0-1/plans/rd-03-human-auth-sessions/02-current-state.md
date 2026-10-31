# Current State: RD-03 Human Authentication and Sessions

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The server has a hardened transport and configuration boundary but no authentication routes. RD-02
created `SecureWebApplication`, the two HTTPS listeners, proxy trust, request limits, security
headers, readiness probes, and redacted logging. The WebAFX application owns routing, dependency
injection, response envelopes, error handling, `/health`, and graceful shutdown.

The database already models the auth domain:

| Table | Relevant columns | Status |
|---|---|---|
| `principals` | `id`, `kind`, `name`, `email`, `status`, `disabled_at` | Present; ULID id; unique lower(email) for users |
| `local_credentials` | `principal_id`, `password_hash`, `must_change`, `failed_count`, `locked_until`, `updated_at` | Present; `password_hash` requires `^\$argon2id\$` |
| `oidc_identities` | `principal_id`, `issuer`, `subject` | Present; primary key `(issuer, subject)` |

The config loader already reads `OPENVAULT_OIDC_ISSUER`, `OPENVAULT_OIDC_CLIENT_ID`,
`OPENVAULT_OIDC_CLIENT_SECRET`, `OPENVAULT_OIDC_REDIRECT_URL`,
`OPENVAULT_OIDC_ALLOWED_DOMAINS`, and `OPENVAULT_SESSION_TTL_HOURS` (default 8, range 1–24).

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/app.ts` | Application assembly | Register the auth plugin and controllers |
| `apps/server/src/transport/pre-stack.ts` | Pre-routing boundary | No change; WebAFX already installs cookie and JSON parsing |
| `apps/server/src/observability/logger.ts` | Pino provider and redaction | Add the log sanitizer and auth redaction paths |
| `apps/server/src/types/express.d.ts` | Request type augmentation | Add `req.auth` |
| `apps/server/src/database/schema.ts` | Desired schema | No change |
| `packages/api-contract/src/index.ts` | Shared contracts | Export auth schemas |
| `packages/core/src/ids.ts` | ULID helpers | Add `newUlid()` |
| `docs/reference/api.md` | Route reference | Add password, sessions, and meta routes |
| `docs/guide/authentication.md` | Auth guide | Update bootstrap, forced change, session, and OIDC behavior |
| `deploy/compose/README.md` | Reference deployment | Replace "printed once" with the `0600` one-time file |

### Code Analysis

- WebAFX `initialize()` installs `cookieParser()`, `express.json()`, request IDs, request
  logging, and Helmet before plugins and controllers (`web-application.js:180-215`). An auth
  plugin therefore sees parsed cookies and bodies and runs before controller routes.
- WebAFX exposes `rateLimitMiddleware` (in-memory, throws `RateLimitError` 429) and
  `csrfMiddleware` (constant-time session token check, fails closed without an expected token).
- `blendsdk/webafx-cache/memory` exports `MemoryCacheProvider` with TTL, delete, and shutdown but
  no enumeration or atomic take.
- `blendsdk/webafx-auth` cannot load without `openid-client`, and its controller stores OIDC
  tokens. It is not used.
- Node 22.23 is the current baseline; the installed Node 24.21 provides `crypto.argon2`.
- WebAFX logs `req.originalUrl` at info level, which would expose OIDC callback `code`/`state`.

## Gaps Identified

### Gap 1: No authentication routes or services
**Current Behavior:** `/v1/auth/*` and `/v1/meta/auth` return 404.
**Required Behavior:** Local login, OIDC login/callback, me, refresh, logout, password change,
session list/revoke, and meta auth.
**Fix Required:** Auth plugin, services, controllers, and session middleware.

### Gap 2: No password hashing
**Current Behavior:** No Argon2 implementation and no credential repository.
**Required Behavior:** Argon2id PHC hashing at 64 MiB/3/1 via Node 24.7+ `crypto.argon2`.
**Fix Required:** Password helper, credentials repository, and Node baseline update.

### Gap 3: No session or CSRF boundary
**Current Behavior:** No cookie session, no CSRF token, no origin guard.
**Required Behavior:** `__Host-ov_session`, absolute TTL, rotation, per-session CSRF, and
same-origin checks.
**Fix Required:** Session service, cookie helper, middleware, and WebAFX CSRF wrapper.

### Gap 4: No OIDC client
**Current Behavior:** Config exists, but no authorization-code flow.
**Required Behavior:** PKCE S256, state/nonce, ID-token verification, UserInfo `sub` check,
token discard, and JIT rules.
**Fix Required:** `openid-client` dependency, OIDC client, state store, and identity linking.

### Gap 5: Callback secrets in access logs
**Current Behavior:** WebAFX logs the full `req.originalUrl`, including query strings.
**Required Behavior:** Access logs never contain `code`, `state`, tokens, passwords, hashes, or
CSRF values.
**Fix Required:** Pino `hooks.logMethod` sanitizer and redaction paths.

## Dependencies

### Internal Dependencies
- RD-02 configuration, transport, database, and logging.
- RD-01 schema and generated types.
- `@openvault/api-contract` and `@openvault/core`.
- WebAFX cache, rate limiter, and CSRF middleware.

### External Dependencies
- `openid-client` 6.8.8 (approved).
- Node.js 24.7+ built-in `crypto.argon2`.
- Existing `jose` for the fake IdP test helper.
- PostgreSQL 16/17 for integration tests.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Native Argon2 timing causes flaky p95 tests | Medium | Medium | Warm up, use 15–20 samples, and test the dummy path directly; keep the absolute threshold documented |
| `openid-client` provider differences | Medium | Medium | Fake IdP covers discovery, PKCE, nonce, token exchange, and UserInfo; use standards-compliant basic auth |
| Session index memory growth | Low | Medium | TTL sweeper every 60s; delete on get/refresh/revoke; shutdown clears |
| Rate-limit and lockout interaction | Medium | Medium | Per-IP first; lockout tests use a second IP or wait for the window |
| Node 24 upgrade breaks existing tests | Medium | High | Run full `pnpm verify` under Node 24 before auth work |
| Log sanitizer misses a path | Low | High | Unit tests for message/object paths and an integration callback log assertion |

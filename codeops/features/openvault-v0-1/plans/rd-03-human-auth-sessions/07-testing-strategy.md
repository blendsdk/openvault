# Testing Strategy: RD-03 Human Authentication and Sessions

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Auth services (password, sessions, OIDC, identity) | 90% |
| Controllers and middleware | 85% |
| Contracts and utilities | 90% |
| Documentation and configuration | 60% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL 16/17 and the existing disposable-database helper.
- The fake OIDC provider is a real HTTPS server, not a library mock.

## 🚨 Specification Test Cases

> These cases derive from RD-03 and the resolved preflight decisions. The in-code traceability
> comment quotes the behavior in plain language; it never includes an `ST-` id, an RD id, or a
> `requirements/` path.

### Contracts, Runtime, and Logging

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Parse a valid login request `{identifier:" Alice@Example.com ",password:"x"}` | Schema accepts; surrounding whitespace is trimmed by the schema; letter case is preserved for the controller to lowercase | RD-03 local login; AR-12 |
| ST-2 | Parse a login request with an unknown field | Strict schema rejects | RD-03 line 73; AR-12 |
| ST-3 | Parse an auth user with a 321-character email | Schema rejects; 320 is accepted | AR-12 |
| ST-4 | `newUlid()` twice | 26 Crockford characters, same timestamp prefix, different values | AR-5 |
| ST-5 | Log the WebAFX message `GET /v1/auth/callback?code=abc&state=xyz 200 4ms` | Captured log has no `abc` or `xyz`; path is preserved | RD-03 logging; AR-13 |
| ST-6 | Log an object `{url:"/v1/auth/callback?code=abc"}` | Captured log has no `abc`; path is preserved | RD-03 logging; AR-13 |

### Sessions and CSRF

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-7 | Create a session for principal P | Returns a 32-byte secret and a record with a public ULID, CSRF token, createdAt, expiresAt, authMethod | RD-03 session store; AR-6 |
| ST-8 | `get` with the secret | Returns the record; the cache key is `session:<sha256(secret)>` and contains no raw secret | RD-03 line 44; AR-6 |
| ST-9 | `get` with a malformed secret | Returns undefined; no cache lookup with a non-hash key | AR-6 |
| ST-10 | Advance past `expiresAt`, then `get` | Returns undefined and deletes the entry | RD-03 line 45; AR-6 |
| ST-11 | `rotate` an active session | New secret and CSRF; same public ID, createdAt, expiresAt; old secret no longer resolves | RD-03 line 45; AR-6 |
| ST-12 | Two concurrent `rotate` calls with the same old secret | Both receive the same rotated session; exactly one new cache entry | AR-6 |
| ST-13 | `list(P)` with two live sessions and one expired | Returns two entries; no secret or CSRF values; current flag is correct | RD-03 lines 54–55; AR-6 |
| ST-14 | `revoke(publicId, P)` for P's session | Returns true; the secret no longer resolves; the index entry is gone | RD-03 line 55; AR-6 |
| ST-15 | `revoke(publicId, otherPrincipal)` | Returns false; the session still resolves | RD-03 line 55; AR-6 |
| ST-16 | Disable principal P, then call `/v1/auth/me` with P's cookie | 401; the session is deleted; the cookie is cleared | RD-03 line 50; AR-6 |
| ST-17 | `POST /v1/auth/logout` with a valid session and CSRF | 204; cookie cleared; old cookie no longer resolves | RD-03 line 29; AR-9 |
| ST-18 | Unsafe request with a valid cookie and missing/wrong `X-CSRF-Token` | 403 `csrf_invalid`; handler not called | RD-03 lines 46–47; AR-9 |
| ST-19 | Unsafe request with a valid cookie and token but `Origin: https://evil.example` | 403 `csrf_invalid` | RD-03 line 47; AR-9 |
| ST-20 | Unsafe request with a valid cookie, token, and `Origin` equal to the configured origin | Handler runs | RD-03 line 47; AR-9 |
| ST-21 | Unsafe request with a valid cookie, token, and `Sec-Fetch-Site: same-origin` but no Origin | Handler runs | AR-9 |
| ST-22 | Unsafe request with a valid cookie, token, and `Sec-Fetch-Site: same-site` | 403 `csrf_invalid` | AR-9 |
| ST-23 | Unsafe request with a bearer header and no session cookie | CSRF wrapper passes through; route authentication decides | RD-03 lines 111–113; AR-9 |
| ST-24 | Forced-change session calls `/v1/auth/sessions` | 403 `password_change_required` | RD-03 lines 79–80; AR-17 |
| ST-25 | Forced-change session calls `/v1/auth/me` and `/v1/auth/password` | Both are allowed; `/me` returns `mustChangePassword: true` | RD-03 lines 79–80; AR-17 |

### Local Authentication

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-26 | Hash a password, then verify the same password | true; PHC starts with `$argon2id$v=19$m=65536,t=3,p=1$`; salt and tag are 16/32 bytes | RD-03 line 31; AR-4 |
| ST-27 | Verify a wrong password | false | RD-03 line 33; AR-4 |
| ST-28 | Verify against a PHC with `m=32768` or `p=2` | false; no derivation with out-of-policy parameters | AR-4 |
| ST-29 | Valid local login | 200; `__Host-ov_session` cookie is HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; body has user, expiresAt, csrfToken, mustChangePassword, lastLoginAt | RD-03 AC1; AR-6 |
| ST-30 | Unknown identifier, wrong password, disabled principal, and locked principal | Identical 401 body/code; each path performs the dummy Argon2 verify | RD-03 AC2; AR-4, AR-14 |
| ST-31 | Five failed logins within 15 minutes from distinct trusted IPs | The 6th attempt returns 401 without a real password verification; the credential is locked for 15 minutes | RD-03 AC3; AR-7 |
| ST-32 | Successful login after four failures | Counter resets to 0; no lock | AR-7 |
| ST-33 | Six rapid local logins from one IP | 6th returns 429 `RATE_LIMIT_EXCEEDED` | RD-03 line 49; AR-8 |
| ST-34 | Eleven attempts for one identifier from distinct IPs within an hour | 11th returns 429; the account limiter key is a hash, not the raw email | RD-03 line 49; AR-8 |
| ST-35 | `POST /v1/auth/password` with a wrong current password | 401; password unchanged; no login-lockout increment | RD-03 forced change; AR-17 |
| ST-36 | `POST /v1/auth/password` with a new password shorter than 12 characters | 400 validation error; password unchanged | AR-17 |
| ST-37 | Valid password change | 200 with new expiresAt/csrfToken and Set-Cookie; `must_change=false`; other sessions revoked; old session secret no longer resolves | RD-03 forced change; AR-17 |
| ST-38 | Bootstrap fixture with `must_change=true` calls a non-allowed route | 403 `password_change_required` | RD-03 AC4 (RD-03 portion); AR-17 |

### OIDC

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-39 | `GET /v1/auth/login` with OIDC unconfigured | 404 `oidc_not_configured` | AR-14 |
| ST-40 | `GET /v1/auth/login` with OIDC configured | 302 to the provider; URL has `response_type=code`, `code_challenge_method=S256`, `scope=openid profile email`, state, nonce | RD-03 line 26; AR-2 |
| ST-41 | Valid callback from the fake IdP | 302 to `/` (or sanitized `returnTo`); `__Host-ov_session` set; `/me` returns the OIDC user | RD-03 AC5; AR-2 |
| ST-42 | Callback with a mismatched nonce | 400 `oidc_callback_failed`; no session | RD-03 AC5; AR-10 |
| ST-43 | Callback with a bad state or a replayed state | 400 `oidc_callback_failed`; no session; state consumed | RD-03 AC5; AR-10 |
| ST-44 | Callback where UserInfo `sub` differs from the ID-token `sub` | 400 `oidc_callback_failed`; no session | RD-03 line 28; AR-2 |
| ST-45 | Valid OIDC login | No `access_token`, `refresh_token`, or `id_token` in cache values, database rows, or captured logs | RD-03 AC6; AR-2 |
| ST-46 | JIT login with `email_verified=true` and an allowed domain, unused email | Principal created with no roles; session created | RD-03 line 39; AR-11 |
| ST-47 | JIT login with `email_verified=false` or absent | 403 `access_denied`; no principal | RD-03 line 39; AR-11 |
| ST-48 | JIT login with a disallowed domain | 403 `access_denied`; no principal | RD-03 line 39; AR-11 |
| ST-49 | JIT login with an email already used by another principal | 403 `access_denied`; no auto-link; no second principal | RD-03 line 38; AR-11 |
| ST-50 | Known `(issuer, subject)` login for a disabled principal | 403 `access_denied`; no session | RD-03 line 39; AR-11 |
| ST-51 | `GET /v1/meta/auth` with and without OIDC config | `{local:true,oidc:true}` and `{local:true,oidc:false}`; no secrets | RD-03 AC11; AR-12 |
| ST-52 | Callback `returnTo` values `//evil.example`, `/.//evil.example`, `/..//evil.example`, `/%2e%2e//evil.example`, `/a/../..//evil.example`, `https://evil.example`, `/ok?x=1` | Every unsafe value resolves to `/` with the configured origin; `/ok?x=1` is preserved | RD-03 line 92; AR-10; security review |

> **Security review additions to ST-52:** `GET /v1/auth/login` sets a short-lived
> `__Host-ov_oidc` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain) containing a random
> browser binding; the transient state stores only its SHA-256. A callback with a valid code and
> state but a missing or mismatched binding cookie returns `400 oidc_callback_failed` with no
> session and no identity. A provider discovery failure during login returns
> `503 oidc_unavailable`, not `500`.

### Runtime and Documentation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-53 | `pnpm verify` under Node 24.21.0 | Build, typecheck, lint, unit/root tests, artifact checks, and docs build pass | Plan-local AC; AR-18 |
| ST-54 | `pnpm audit:prod` and `pnpm audit:full` after adding `openid-client` | No high-severity findings | Plan-local AC; AR-2 |
| ST-55 | `pnpm db:types:check` | No generated-type drift; no migration added | Plan-local AC; AR-6 |
| ST-56 | API reference and auth guide | List `/v1/auth/password`, `/v1/auth/sessions`, `/v1/auth/sessions/:id`, and the `0600` bootstrap file behavior | Plan-local AC; PF-016 |

## Test Categories

### Specification Tests

| Test File | ST Cases Covered | Component |
|---|---|---|
| `packages/api-contract/tests/auth.spec.test.ts` | ST-1–ST-3 | Contracts |
| `packages/core/tests/ids.spec.test.ts` | ST-4 | Core IDs |
| `apps/server/tests/logging.spec.test.ts` | ST-5–ST-6 | Logging |
| `apps/server/tests/auth/sessions.spec.test.ts` | ST-7–ST-15 | Sessions |
| `apps/server/tests/auth/csrf.spec.test.ts` | ST-18–ST-23 | CSRF/Origin |
| `apps/server/tests/integration/auth.sessions.test.ts` | ST-16–ST-17, ST-24–ST-25 | Session routes and gate |
| `apps/server/tests/auth/password.spec.test.ts` | ST-26–ST-28 | Password hashing |
| `apps/server/tests/integration/auth.local.test.ts` | ST-29–ST-38 | Local login, lockout, rate limits, password change |
| `apps/server/tests/integration/auth.oidc.test.ts` | ST-39–ST-52 | OIDC |
| `apps/server/tests/integration/auth.runtime.test.ts` | ST-53–ST-56 | Runtime/docs checks where automatable |

### Implementation Tests

| Test File | Description | Priority |
|---|---|---|
| `apps/server/tests/auth/password.impl.test.ts` | Malformed PHC, parameter bounds, salt/tag lengths, dummy verify, PHC parser edges | High |
| `apps/server/tests/auth/sessions.impl.test.ts` | Index sweeper, concurrent refresh, expiry cleanup, shutdown | High |
| `apps/server/tests/auth/csrf.impl.test.ts` | Header parsing, missing headers, `Origin: null`, malformed URLs | High |
| `apps/server/tests/auth/oidc.impl.test.ts` | ReturnTo sanitizer, state atomicity, discovery cache, timed fetch abort | High |
| `apps/server/tests/auth/credentials.impl.test.ts` | Atomic failure SQL, window reset, success reset, change password | High |
| `apps/server/tests/auth/identity.impl.test.ts` | JIT transaction, unique-race retry, claim normalization, no roles | High |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Local login + session | AuthController, SessionService, PostgreSQL | Real credential row and real cookie flow |
| Lockout + rate limits | CredentialsRepository, WebAFX limiters | Five failures, lock, 429 boundaries |
| Password change + gate | AuthController, SessionService, PostgreSQL | Forced change, revocation, rotation |
| OIDC full flow | OidcClient, fake IdP, OidcIdentityService, SessionService | PKCE, nonce, state, UserInfo, JIT, token non-persistence |
| Disable invalidation | SessionService, PostgreSQL | Status change invalidates `/me` |
| CSRF + origin | Middleware, AuthController | Token and origin combinations |

### End-to-End Tests

| Scenario | Steps | Expected Result |
|---|---|---|
| First admin login | Seed `must_change=true`, log in, call a blocked route, change password, call `/me` | 403 gate, then 200 with `mustChangePassword:false` |
| OIDC first login | Start login, fake IdP callback, `/me` | Session created, JIT principal, no tokens stored |
| Session refresh | Log in, refresh, use the old cookie | New cookie works; old cookie 401 |

## Test Data

### Fixtures Needed

- A principal + local credential with a known Argon2id hash and `must_change` true/false.
- A disabled principal.
- An OIDC identity and a principal for the known-identity path.
- A fake HTTPS IdP with discovery, JWKS, token, and UserInfo endpoints.
- A recording cache provider that captures every `set` value for token-leak assertions.
- A memory log destination for sanitizer assertions.

### Mock Requirements

- Fake IdP: a true external boundary; use a real HTTPS server and `jose`-signed tokens.
- Clock: inject `now` into `SessionService`, `OidcStateStore`, and the lockout tests; do not mock
  PostgreSQL.
- No mocking of `openid-client` or `crypto.argon2`; the tests exercise the real libraries.

## Verification Checklist

- [ ] All specification test cases (ST-*) are defined with concrete input/output pairs.
- [ ] Every ST case traces to RD-03, a component spec, or an AR entry.
- [ ] Specification tests are written before implementation.
- [ ] Specification tests are verified to fail before implementation (red phase).
- [ ] All specification tests pass after implementation (green phase).
- [ ] Implementation tests cover edge cases and internals.
- [ ] All unit, integration, and root tests pass.
- [ ] `pnpm verify`, `pnpm audit:prod`, `pnpm audit:full`, and `pnpm db:types:check` pass.
- [ ] PostgreSQL 16 and 17 integration suites pass.
- [ ] No regressions in existing tests.

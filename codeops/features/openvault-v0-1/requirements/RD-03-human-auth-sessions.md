# RD-03: Human Authentication and Sessions

> **Document**: RD-03-human-auth-sessions.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-02
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines how humans sign in to the web UI and obtain a browser session:
local password authentication and OIDC authorization-code flow with PKCE, unified behind an
opaque backend-for-frontend session. It also defines CSRF protection, session rotation,
bootstrap-admin handling, and the rate limits that protect the login surface.

The browser never receives an OIDC access token or refresh token. The server exchanges the
code, fetches UserInfo, creates a session, and discards the tokens.

## Functional Requirements

### Must Have

- [ ] `POST /v1/auth/local/login` authenticates a local user with identifier and password.
- [ ] `GET /v1/auth/login` starts OIDC authorization-code flow with PKCE `S256`, state, and
  nonce when OIDC is configured.
- [ ] `GET /v1/auth/callback` validates state and nonce, exchanges the code, verifies the
  UserInfo `sub` matches the ID token, and creates a session.
- [ ] `GET /v1/auth/me`, `POST /v1/auth/refresh`, and `POST /v1/auth/logout` manage the
  browser session.
- [ ] Passwords are hashed with Argon2id using 64 MiB memory, 3 iterations, 1 lane.
- [ ] Five failed local logins in 15 minutes lock the account for 15 minutes.
- [ ] Unknown user, wrong password, and locked account return the same generic response and
  comparable timing.
- [ ] The bootstrap administrator password is delivered through a one-time file with mode
  `0600` or an operator-supplied file; it is never printed to logs.
- [ ] The bootstrap administrator must change the password before any other action.
- [ ] OIDC identities are linked by `(issuer, subject)`.
- [ ] JIT provisioning is disabled unless `OPENVAULT_OIDC_ALLOWED_DOMAINS` is configured.
- [ ] OIDC access, refresh, and ID tokens are discarded after login; no token is written to
  the cache or database.
- [ ] The session cookie is `__Host-ov_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no
  Domain.
- [ ] Session id is 32 random bytes, stored only as a SHA-256 hash in the memory cache.
- [ ] Session lifetime is 8 hours; `POST /v1/auth/refresh` rotates the session id and cookie.
- [ ] A per-session CSRF token is returned by `/v1/auth/me`; all unsafe browser requests must
  send `X-CSRF-Token` and pass Origin/Sec-Fetch-Site checks.
- [ ] `GET /v1/meta/auth` returns `{ local: boolean, oidc: boolean }` without secrets.
- [ ] Login routes are rate limited: 5/min per IP and 10/hour per account.
- [ ] Disabling a principal invalidates its browser sessions within 5 seconds.

### Should Have

- [ ] `GET /v1/auth/sessions` lists the current principal's sessions without token values.
- [ ] `DELETE /v1/auth/sessions/:id` revokes a session.
- [ ] A visible last-login timestamp and method in the UI.

### Won't Have (Out of Scope)

- Local MFA, password reset by email, or security questions.
- OIDC device flow or CLI OIDC login (v0.2).
- SCIM, group-to-role sync, or conditional access.

## Technical Requirements

### Local login

```text
POST /v1/auth/local/login
{ "identifier": "alice@example.com", "password": "..." }
```

- Validate with Zod; reject unknown fields.
- Normalize the identifier (trim, lowercase email).
- Verify Argon2id hash in constant time through the library.
- On failure, increment the lockout counter; return 401 with a generic message.
- On success, reset the counter, create a session, set the cookie, return `{ user, expiresAt,
  csrfToken }`.
- If `must_change_password`, return `{ mustChangePassword: true }` and allow only the change
  endpoint until completed.

### OIDC flow

1. `GET /v1/auth/login` generates verifier, state, and nonce; stores them in the memory cache
   for 10 minutes, single use.
2. Redirect to the provider authorization endpoint with `response_type=code`,
   `code_challenge_method=S256`, `scope=openid profile email`.
3. Callback validates state, exchanges the code, verifies the ID token, fetches UserInfo, and
   checks `sub`.
4. Link to an existing principal or provision one only when the domain is allowed.
5. Create a session; discard tokens.
6. Redirect to a sanitized same-origin `returnTo` or `/`.

### Session store

| Field | Value |
|---|---|
| Key | `session:<sha256(id)>` |
| Value | principal id, csrf token, created, expires, auth method |
| Store | `blendsdk/webafx-cache/memory` in v0.1 |
| TTL | 8 hours |
| Rotation | delete old key, create new id, set new cookie |
| Revocation | delete key; principal disable clears all sessions in memory |

### CSRF

- Token is 32 random bytes, stored in the session, returned by `/me`.
- Unsafe methods require `X-CSRF-Token` and a same-origin `Origin` or `Sec-Fetch-Site`.
- Missing or mismatched token returns 403 `csrf_invalid`.
- Login and callback are exempt because they establish the session; they are rate limited and
  state-validated.
- Agent and CLI routes use bearer or mTLS, not cookies, and must not accept a browser cookie
  as a substitute.

## Integration Points

- RD-02 supplies the admin listener, TLS, config, and rate-limit primitives.
- RD-04 reuses the local credential and Argon2id verifier for CLI tokens.
- RD-06 uses the session principal and roles for policy.
- RD-07 audits login success/failure, lockout, and session revocation.
- RD-12 consumes `/v1/auth/me` and the CSRF token.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Browser auth | OIDC only / local + OIDC / local only | Unified local + OIDC BFF | Local users can use the UI; no tokens in JS | AR-6 |
| Session store | Memory / Postgres / Redis | Memory in v0.1 | No Redis; no token at rest | AR-12 |
| Session lifetime | 1h / 8h / 24h | 8 hours | Balance security and usability | AR-12 |
| Bootstrap password | Log / one-time file / interactive | One-time file, no logs | Prevent credential persistence | AR-29 |
| CSRF | SameSite only / token + origin | Token + origin + SameSite | Defense in depth | AR-21 |
| Argon2id | 32/2 / 64/3 / 128/4 | 64 MiB / 3 / 1 | Current recommended baseline | AR-15 |

## Security Considerations

- **Data sensitivity:** passwords, session ids, CSRF tokens, OIDC claims.
- **Input validation:** identifier, password length, OIDC state/nonce, `returnTo` sanitized.
- **Authentication & authorization:** login is public and rate limited; all other auth routes
  require a session except refresh/logout with a valid cookie.
- **Injection risks:** no HTML rendering of claims; no SQL string concatenation.
- **Encryption needs:** TLS on the admin listener; HttpOnly Secure cookie.
- **Rate limiting:** per-IP and per-account login limits; join limits in RD-05.
- **Infrastructure:** no tokens in logs; no password in query strings; no credentials in
  browser storage.

## Acceptance Criteria

1. [ ] A correct local login returns 200 and a `__Host-ov_session` cookie with HttpOnly,
   Secure, SameSite=Lax, Path=/, and no Domain.
2. [ ] An unknown user, wrong password, or locked account returns the same 401 body and a
   response-time difference under 50 ms at p95.
3. [ ] Five failed logins in 15 minutes lock the account; the sixth attempt returns 401
   without a password check.
4. [ ] The bootstrap password is absent from stdout, stderr, container logs, and the database;
   the first login requires a password change before any other route succeeds.
5. [ ] OIDC login with a valid provider creates a session; a mismatched `sub`, bad state, or
   bad nonce is rejected.
6. [ ] OIDC access, refresh, and ID tokens are absent from the cache and database after login.
7. [ ] `POST /v1/auth/refresh` changes the cookie value; the old cookie no longer resolves.
8. [ ] A mutation with a missing or wrong `X-CSRF-Token` returns 403; a same-origin token
   succeeds.
9. [ ] A cross-origin POST with a valid cookie but no token is rejected.
10. [ ] Disabling a principal causes its next `/me` request to return 401 within 5 seconds.
11. [ ] `GET /v1/meta/auth` returns only booleans and no secrets.
12. [ ] Security requirements verified: password hashing, rate limits, CSRF, cookie flags,
    token non-persistence.

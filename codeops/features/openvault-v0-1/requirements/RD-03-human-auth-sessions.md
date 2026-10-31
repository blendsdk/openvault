# RD-03: Human Authentication and Sessions

> **Document**: RD-03-human-auth-sessions.md
> **Status**: Preflighted
> **Created**: 2026-10-29
> **Preflight**: [00-preflight-report-RD-03.md](00-preflight-report-RD-03.md) — 17 findings resolved
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
- [ ] `POST /v1/auth/password` changes the current user's password; the bootstrap
  administrator cannot use any other authenticated route until the change succeeds.
- [ ] Passwords are hashed with Argon2id using 64 MiB memory, 3 iterations, 1 lane, through
  the Node.js 24.7+ built-in `crypto.argon2`.
- [ ] Five failed local logins in 15 minutes lock the account for 15 minutes.
- [ ] Unknown user, wrong password, and locked account return the same generic response and
  comparable timing.
- [ ] The bootstrap administrator password is delivered through a one-time file with mode
  `0600` or an operator-supplied file; it is never printed to logs.
- [ ] The bootstrap administrator must change the password before any other action.
- [ ] OIDC identities are linked by `(issuer, subject)`.
- [ ] JIT provisioning is disabled unless `OPENVAULT_OIDC_ALLOWED_DOMAINS` is configured.
  JIT requires `email_verified: true`, creates a principal only when the normalized email is
  unused, and rejects a collision for an existing account; it never links an existing
  principal by email alone.
- [ ] OIDC access, refresh, and ID tokens are discarded after login; no token is written to
  the cache or database.
- [ ] The session cookie is `__Host-ov_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no
  Domain.
- [ ] Session id is 32 random bytes, stored only as a SHA-256 hash in the memory cache.
- [ ] Session lifetime is `OPENVAULT_SESSION_TTL_HOURS` (default 8 hours, range 1–24), measured
  from creation; `POST /v1/auth/refresh` rotates the session id and CSRF token and preserves
  the original expiry.
- [ ] A per-session CSRF token is returned by `/v1/auth/me`; all unsafe browser requests must
  send `X-CSRF-Token` and pass Origin/Sec-Fetch-Site checks.
- [ ] `GET /v1/meta/auth` returns `{ local: boolean, oidc: boolean }` without secrets.
- [ ] Login routes are rate limited: 5/min per IP and 10/hour per account.
- [ ] Request logs never contain OIDC callback `code`/`state`, tokens, passwords, or CSRF
  values; WebAFX's request log strips query strings.
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

- Validate with Zod; reject unknown fields. Normalize the identifier (trim, lowercase email).
  The identifier is at most 320 characters and the password at most 1024 characters.
- Verify the Argon2id PHC hash with the Node.js 24.7+ `crypto.argon2` API and compare the
  derived key with `timingSafeEqual`. The stored value is a standard PHC string with salt and
  parameters, so a future parameter change remains verifiable.
- On failure, increment the lockout counter atomically; return 401 with a generic message.
  Unknown, wrong-password, disabled, and locked accounts perform a dummy Argon2 verification
  so the response time stays comparable and the response is identical.
- Lockout is five failures in a rolling 15-minute window (anchored on `updated_at`) for 15
  minutes. While locked, do not verify the real password and do not extend the lock. Reset the
  counter after a successful login or after the lock expires.
- On success, reset the counter, create a session, set the cookie, and return
  `{ user, expiresAt, csrfToken, mustChangePassword }`.
- If `must_change_password` is true, the login and `/me` responses still include the full
  session fields plus `mustChangePassword: true`. Only `/v1/auth/me`, `/v1/auth/password`,
  `/v1/auth/logout`, and `/v1/meta/*` are allowed until the change succeeds; every other
  authenticated route returns 403 `password_change_required`.

### Password change

```text
POST /v1/auth/password
{ "currentPassword": "...", "newPassword": "..." }
```

- Require a valid session and a valid CSRF token.
- Verify the current password with the same Argon2id verifier.
- Require the new password to be 12–1024 characters. Do not trim it and do not add composition
  rules.
- Hash with a fresh 16-byte salt, set `must_change = false`, reset the failure counter, revoke
  every other session for the principal, and rotate the current session id and CSRF token.
- Return the new `{ expiresAt, csrfToken }` and a new `Set-Cookie`.
- Rate limit this route per session and per IP; do not reuse the login lockout counter.

### OIDC flow

1. `GET /v1/auth/login` generates verifier, state, and nonce; stores
   `{ codeVerifier, nonce, returnTo }` under `oidc:state:<sha256(state)>` in the memory cache for
   10 minutes, single use. Return 404 `oidc_not_configured` when OIDC is not configured.
2. Redirect to the provider authorization endpoint with `response_type=code`,
   `code_challenge_method=S256`, `scope=openid profile email`. Discovery, token exchange, and
   UserInfo requests use a 5-second abort timeout. Discovery is cached for one hour and the
   configured issuer must exactly match the discovered issuer.
3. Callback looks up and consumes the state atomically (a concurrent second callback for the
   same state is rejected). It exchanges the code, verifies the ID token signature, `iss`,
   `aud`, `exp`, and nonce, fetches UserInfo, and checks that UserInfo `sub` equals the ID
   token `sub`.
4. Link to an existing `(issuer, subject)` identity. Otherwise, when JIT is enabled, require
   `email_verified === true`, use only a normalized unused email, and create the principal and
   identity in one transaction. A collision with an existing principal is rejected; never
   link by email alone. JIT users receive no roles. Treat JIT as an audited system action,
   not an admin `identity.create` call; RD-06 owns the admin linking path for collisions.
5. Create a session; discard the access, refresh, and ID tokens and every verifier/nonce.
6. Redirect to a sanitized same-origin `returnTo` or `/`. Accept only a path that starts with
   `/`, contains no `//`, backslash, control character, or CRLF, resolves to the configured
   origin, and is at most 2048 characters.
7. On state, nonce, or code failure, return a generic 400 `oidc_callback_failed`. On provider
   unavailability or timeout, return a generic 503 `oidc_unavailable`. Consume the state on
   failure and log only an error class, never state, code, nonce, verifier, or tokens.

### Session store

| Field | Value |
|---|---|
| Key | `session:<sha256(id)>` |
| Value | public session id (ULID), principal id, csrf token, created, expires, auth method |
| Store | `blendsdk/webafx-cache/memory` in v0.1 |
| TTL | `OPENVAULT_SESSION_TTL_HOURS` (default 8), absolute from `created` |
| Rotation | delete old key, create a new secret id and CSRF token, keep the public id and expiry, set a new cookie with the remaining `Max-Age` |
| Listing | `GET /v1/auth/sessions` returns public id, created, expires, auth method, and current flag; never returns the secret id or CSRF token |
| Revocation | `DELETE /v1/auth/sessions/:id` deletes by public id after an ownership check; principal disable clears every session for that principal |
| Index | a small in-process `principalId → publicIds` and `publicId → secretHash` index; entries are removed on delete, expiry, and shutdown |

### CSRF

- Token is 32 random bytes, stored in the session, returned by `/me`.
- Unsafe methods require `X-CSRF-Token` and a same-origin `Origin` or `Sec-Fetch-Site`.
  If `Origin` is present it must equal the configured origin; otherwise `Sec-Fetch-Site` must
  be `same-origin`. If both are absent, reject.
- Missing or mismatched token returns 403 `csrf_invalid`.
- Apply the token check only when a valid session is attached, so future bearer and mTLS
  routes are not broken. Resolve the session before the CSRF check so an invalid cookie
  returns 401, not 403.
- Login and callback are exempt because they establish the session; they are rate limited and
  state-validated. Apply the origin guard to the local login POST as defense in depth.
- Agent and CLI routes use bearer or mTLS, not cookies, and must not accept a browser cookie
  as a substitute.

### Logging

- WebAFX logs `req.originalUrl` at info level for every request. The logger provider must strip
  the query string from both the message and the `url` field so OIDC `code` and `state` never
  reach the access log.
- Add explicit redaction paths for `currentPassword`, `newPassword`, `csrfToken`, `code`,
  `codeVerifier`, `nonce`, `state`, `idToken`, `accessToken`, and `refreshToken`.
- Never log request bodies, token responses, password hashes, or OIDC claims.

### Runtime

- Password hashing and PHC verification use the Node.js 24.7+ built-in `crypto.argon2` API.
  The workspace baseline, `.nvmrc`, CI workflows, `@types/node`, and setup documentation must
  match. No external Argon2 dependency is added.

## Integration Points

- RD-02 supplies the admin listener, TLS, config, and WebAFX rate-limit and CSRF primitives.
- RD-04 reuses the local credential and Argon2id verifier for CLI tokens.
- RD-06 uses the session principal and roles for policy. Its admin `identity.create` path also
  owns linking an OIDC identity when JIT provisioning rejects an email collision.
- RD-07 audits login success/failure, lockout, password change, JIT provisioning, and session
  revocation.
- RD-11/RD-13 own `ov init` and the one-time `0600` bootstrap password file. RD-03 owns only the
  forced-change gate and the password-change endpoint; acceptance is split accordingly.
- RD-12 consumes `/v1/auth/me`, the CSRF token, and the session list.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Browser auth | OIDC only / local + OIDC / local only | Unified local + OIDC BFF | Local users can use the UI; no tokens in JS | AR-6 |
| Session store | Memory / Postgres / Redis | Memory in v0.1 | No Redis; no token at rest | AR-12 |
| Session lifetime | 1h / 8h / 24h | `OPENVAULT_SESSION_TTL_HOURS`, default 8 | Configurable within the accepted 1–24 hour range; absolute from creation | AR-12 |
| Bootstrap password | Log / one-time file / interactive | One-time file, no logs | Prevent credential persistence | AR-29 |
| CSRF | SameSite only / token + origin | Token + origin + SameSite | Defense in depth | AR-21 |
| Argon2id | 32/2 / 64/3 / 128/4 | 64 MiB / 3 / 1 | Current recommended baseline | AR-15 |
| Argon2 implementation | Native package / Node built-in / pure JS | Node.js 24.7+ built-in `crypto.argon2` | No new production dependency; ~260 ms at the required parameters | PF-002 |
| OIDC implementation | Native fetch + jose / `openid-client` low-level / WebAFX controller | `openid-client` low-level methods | Reuses vetted PKCE/nonce/ID-token code without the token-storing controller | PF-001 |
| OIDC linking | Email / `(issuer, subject)` / no JIT | `(issuer, subject)`; require `email_verified`; reject collisions | Prevents account takeover; matches the identity key | PF-003 |
| Session public id | Cookie secret / hash prefix / separate ULID | Separate public ULID | Allows list/revoke without exposing a credential-derived value | PF-005 |

## Security Considerations

- **Data sensitivity:** passwords, password hashes, session ids, CSRF tokens, OIDC claims.
- **Input validation:** identifier (max 320), passwords (max 1024; new password 12–1024),
  OIDC state/nonce, and `returnTo` sanitized to a same-origin path of at most 2048 characters.
- **Authentication & authorization:** login is public and rate limited; all other auth routes
  require a session except refresh/logout with a valid cookie. The forced-change gate allows
  only `/me`, `/password`, `/logout`, and `/meta/*`.
- **Injection risks:** no HTML rendering of claims; no SQL string concatenation; parameterized
  queries only.
- **Encryption needs:** TLS on the admin listener; HttpOnly Secure cookie; Argon2id PHC hash
  with a fresh 16-byte salt.
- **Rate limiting:** 5/min per IP and 10/hour per account on login; per-session and per-IP
  limits on password change; join limits in RD-05.
- **Infrastructure:** request logs strip query strings and never contain OIDC `code`/`state`,
  tokens, passwords, hashes, or CSRF values; no password in query strings; no credentials in
  browser storage.

## Acceptance Criteria

1. [ ] A correct local login returns 200 and a `__Host-ov_session` cookie with HttpOnly,
   Secure, SameSite=Lax, Path=/, and no Domain.
2. [ ] An unknown user, wrong password, disabled account, or locked account returns the same
   401 body and a response-time difference under 50 ms at p95.
3. [ ] Five failed logins in a rolling 15-minute window lock the account for 15 minutes; a
   subsequent attempt returns 401 without a real password check. The test performs the sixth
   attempt after the per-IP one-minute window, or from a second trusted IP, so the per-IP
   limiter does not mask the lockout response.
4. [ ] RD-03 proves that the auth path never logs the password, hash, or token and that a
   bootstrap fixture with `must_change = true` cannot use any route except the allowed
   forced-change set. RD-11/RD-13 prove the `0600` one-time file, stdout/stderr/container-log
   absence, and database non-persistence of the plaintext password.
5. [ ] OIDC login with a valid provider creates a session; a mismatched `sub`, bad state, bad
   nonce, or replayed state is rejected.
6. [ ] OIDC access, refresh, and ID tokens are absent from the cache, database, and request
   logs after login.
7. [ ] `POST /v1/auth/refresh` changes the cookie and CSRF values; the old cookie no longer
   resolves; the absolute expiry is preserved.
8. [ ] A mutation with a missing or wrong `X-CSRF-Token` returns 403; a same-origin token
   succeeds.
9. [ ] A cross-origin POST with a valid cookie but no token is rejected; a cross-origin POST
   with a valid token is also rejected by the origin guard.
10. [ ] Disabling a principal causes its next `/me` request to return 401 within 5 seconds.
11. [ ] `GET /v1/meta/auth` returns only booleans and no secrets.
12. [ ] `GET /v1/auth/sessions` lists the current principal's sessions without secret ids or
    CSRF values; `DELETE /v1/auth/sessions/:id` revokes an owned session and returns 404 for
    another principal's session.
13. [ ] `POST /v1/auth/password` requires the current password, enforces 12–1024 characters,
    clears `must_change`, revokes other sessions, and rotates the current session.
14. [ ] Security requirements verified: password hashing, rate limits, lockout, CSRF, cookie
    flags, OIDC state/nonce, log redaction, and token non-persistence.

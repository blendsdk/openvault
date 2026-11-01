# RD-04: CLI Authentication

> **Document**: RD-04-cli-auth.md
> **Status**: Preflighted
> **Created**: 2026-10-29
> **Preflight**: [00-preflight-report-RD-04.md](00-preflight-report-RD-04.md) — 12 findings resolved
> **Project**: OpenVault
> **Depends On**: RD-03
> **Client Owner**: RD-11
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines how the `ov` CLI authenticates a human without a browser session. The
server issues a short-lived Ed25519 JWT and a rotating opaque refresh token, stores only the
refresh-token hash, and supports family revocation. RD-04 owns the server API, token model,
signing keys, and revocation semantics. RD-11 owns the `ov` binary, the local credential file,
argv handling, and CLI-side logging.

The CLI must never pass a token in argv or write one to diagnostics. The server must never
store a raw refresh token or a raw signing seed.

## Functional Requirements

### Must Have

- [ ] `POST /v1/auth/cli/login` accepts `identifier` and `password` and returns an access
  token, a refresh token, their absolute expiries, the public user, and
  `mustChangePassword`. It does not set a browser cookie. A service principal is rejected
  with the generic authentication failure and cannot obtain a CLI family.
- [ ] The access token is an Ed25519 JWT with a 15-minute lifetime, issuer `openvault`,
  audience `openvault-cli`, and claims `sub`, `sid`, `jti`, `iat`, `exp`, and `kind`.
  `sid` is the CLI session family identifier and `kind` is `user`.
- [ ] The refresh token is 32 random bytes encoded as 43-character base64url without
  padding. It is not a JWT. `cli_sessions` stores only its SHA-256 hash.
- [ ] A CLI session family has an absolute 12-hour lifetime from login. Every refresh row in
  the family shares the family's original `expires_at`; rotation never extends it.
- [ ] Every refresh rotates the refresh token. The old row is marked revoked. Presenting an
  already-rotated or otherwise revoked refresh token revokes every row in its family and
  returns 401.
- [ ] Concurrent refreshes with the same token are serialized. At most one refresh may
  succeed; the loser triggers family revocation and receives 401.
- [ ] `POST /v1/auth/cli/refresh` returns a new access token and refresh token.
  `POST /v1/auth/cli/logout` revokes the family and is idempotent.
- [ ] CLI login shares the RD-03 local credential verifier, lockout state, generic failure
  response, dummy verification, and per-IP/per-account rate-limit buckets. Five failures on
  either login surface lock the account for both.
- [ ] Refresh is rate limited to 60 requests per minute per IP and 30 requests per minute per
  family. The family limit is enforced after the refresh-token lookup so rotation does not
  reset the bucket. Rejected requests return 429.
- [ ] Disabling a principal invalidates its refresh and access tokens within 5 seconds.
- [ ] Changing a password revokes every CLI family for the principal in the same transaction
  as the password update. The old access and refresh tokens fail; a fresh login with the new
  password succeeds.
- [ ] A protected CLI access-token request validates the JWT and checks both the principal
  status and a live family row. An invalid, expired, disabled, or revoked token returns 401.
  Browser cookies are never accepted as a substitute, and an invalid bearer token never falls
  back to a cookie.
- [ ] `GET /v1/auth/cli/me` returns the current CLI user and `mustChangePassword`.
- [ ] The JWT signing key is Ed25519 and is wrapped by the current KEK. Its `kid` is carried
  in the JWT header. Signing uses the current key; verification accepts the current and
  previous keys during rotation. A retired key is rejected.
- [ ] The first signing key is created by `ov init` when available, or idempotently by the
  server at startup when absent. Startup and init cannot create two current keys.
- [ ] Server logs and error bodies never contain access tokens, refresh tokens, passwords, or
  raw signing keys. Request-body fields `accessToken` and `refreshToken` are explicitly
  redacted.
- [ ] Expired and revoked `cli_sessions` rows are retained for 30 days for reuse detection and
  incident context, then removed by a daily idempotent cleanup.

### Should Have

- [ ] `GET /v1/auth/cli/sessions` lists the current principal's CLI families without token
  hashes. `DELETE /v1/auth/cli/sessions/:familyId` revokes an owned family and returns 404
  for another principal's family.
- [ ] RD-11 exposes the list/revoke routes as `ov auth sessions`.

### Won't Have (Out of Scope)

- OIDC login for the CLI (v0.2).
- Device authorization flow.
- Long-lived API keys.
- A JWKS endpoint or CLI-side JWT verification. The server verifies every access token.
- A CLI credential file, `ov logout` file removal, or argv handling in RD-04; RD-11 owns
  those, including the file-security contract.

## Technical Requirements

### Token model

| Token | Format | Lifetime | Storage |
|---|---|---|---|
| Access | Ed25519 JWT | 15 minutes | CLI memory or RD-11 credential file |
| Refresh | 32 random bytes, base64url | 12 hours absolute per family | SHA-256 in `cli_sessions` |
| Signing key | Ed25519 private seed | Rotatable | Wrapped by the KEK in `signing_keys` |
| Session family | ULID | 12 hours absolute from login | `cli_sessions.family_id` |

Claims:

```json
{
  "iss": "openvault",
  "aud": "openvault-cli",
  "sub": "01J...",
  "sid": "01J...",
  "jti": "01J...",
  "iat": 1760000000,
  "exp": 1760000900,
  "kind": "user"
}
```

- `sub` is the principal ULID; `sid` is the CLI family ULID; `jti` is a unique ULID for this
  access token.
- `kind` is exactly `user`. `service` and agent identities use RD-05 mTLS and are not accepted
  on CLI routes.
- The token carries no roles or permissions. RD-06 loads policy from the database on every
  request so role changes take effect without waiting for token expiry.
- Verification pins `EdDSA`, requires the `kid` header, checks `iss` and `aud`, and applies
  the shared 30-second clock skew tolerance from `CLOCK_SKEW_SECONDS` to `iat` and `exp`.

### Local CLI login

- Reuse the shared local-login service used by RD-03. The service owns identifier
  normalization (trim and lowercase email), the 320-character identifier bound, the
  1024-character password bound, lookup, disabled and locked checks, the policy-hash check,
  dummy verification, password verification, atomic failure/success counters, and the
  post-success hash compare-and-swap recheck.
- Unknown, wrong-password, disabled, and locked accounts return the same
  `401 invalid_credentials` body and perform a dummy Argon2id verification. A locked account
  does not verify the real password and does not extend the lock.
- CLI login uses the same per-IP (5/minute) and per-account (10/hour) limiter instances as
  browser login. Separate limiter instances are not acceptable because they create separate
  in-memory buckets.
- On success, create a new family with a ULID `family_id`, a ULID row `id`, a 32-byte random
  refresh token encoded with base64url, its SHA-256 hash, `expires_at = now() + 12 hours`,
  `principal_id`, `ip`, and `user_agent`. The access token's `sid` is the family id.
- After the family insert, re-read the credential hash (or hold the per-principal lock through
  the insert) and revoke the family if it changed. A concurrent password change must not leave
  a live CLI family created with the old password.
- If `must_change` is true, login still succeeds and returns `mustChangePassword: true`. The
  forced-change gate allows `GET /v1/auth/cli/me`; logout remains available because it uses
  the refresh token. Other CLI data routes return `403 password_change_required`.

### Refresh and rotation

The refresh request is `{ "refreshToken": "<43-char base64url>" }`. The server hashes the
canonical ASCII token with SHA-256 and looks up `cli_sessions.refresh_hash`.

1. Hash the token and perform a non-locking lookup to find the row's `principal_id`. If the
   row is absent, return `401 invalid_refresh_token`.
2. Begin a transaction and take the per-principal lock (a row lock on `principals` or an
   advisory lock). This is the same lock password change takes.
3. Re-select the row by hash with `FOR UPDATE`.
4. If `revoked_at` is set, revoke every row in the family (`revoked_at = now()` where
   `family_id = row.family_id`), commit, and return `401 invalid_refresh_token`.
5. If `expires_at <= now()`, return `401 invalid_refresh_token`.
6. Load the principal. If it is missing or not active, revoke the family and return
   `401 invalid_refresh_token`.
7. Mark the old row `revoked_at = now()`. Insert a new row with the same `family_id`,
   `principal_id`, and **original** `expires_at`, a new row ULID, a new 32-byte refresh token,
   and its SHA-256 hash.
8. Commit and return the new access token, new refresh token, both expiries, the public user,
   and `mustChangePassword`.

A partial unique index `UNIQUE (family_id) WHERE revoked_at IS NULL` is a database backstop:
a family can have at most one live refresh row. A failed insert rolls back the transaction.

Password change takes the same per-principal lock before updating the password and revoking
the families. The consistent lock order (principal first, then refresh row) prevents a
password change from committing between the refresh check and the new-row insert, which would
leave a fresh family alive after the password change.

Because a lost response looks like reuse, the CLI must serialize refresh per credential file
and treat a 401 as a re-login. RD-11 owns that serialization.

### Logout

The logout request is `{ "refreshToken": "<43-char base64url>" }`.

- Hash the token and find its row. If found, mark every row in the family revoked.
- Return 204 for any well-formed token, including an unknown or already-revoked token.
- Return 400 `validation_error` for a malformed token.
- Logout does not require a bearer token; possession of the refresh token is the authority.
- After commit, the family check in the bearer middleware rejects outstanding access tokens.

### Access-token authentication

- Parse `Authorization: Bearer <jwt>`. A missing, malformed, or non-Bearer header leaves the
  request unauthenticated.
- Verify the JWT with `jose`: `EdDSA` only, exact `iss` and `aud`, required `kid`, `iat` and
  `exp` with 30-second skew, and ULID `sub`, `sid`, and `jti`. Reject any other `kind`.
- Check the principal status and a live family row in one database query:
  `principals.status = 'active'` and at least one `cli_sessions` row with the same
  `family_id`, `principal_id`, `revoked_at IS NULL`, and `expires_at > now()`.
- Attach a discriminated auth context with `kind: "cli"`, `principalId`, `familyId`, `jti`,
  `expiresAt`, and `mustChangePassword`. Existing browser sessions attach `kind: "browser"`.
- `requireSession` is browser-only. `requirePrincipal` accepts either kind. The Origin and
  CSRF guards run only for `kind: "browser"`; CLI bearer requests never require a CSRF token
  and CLI endpoints never set a cookie.
- A valid bearer takes precedence over a cookie. An invalid bearer does not fall back to a
  cookie.
- `GET /v1/auth/cli/me` requires a valid CLI context and returns
  `{ user, mustChangePassword }`.
- The forced-change gate allows only `GET /v1/auth/cli/me` while `mustChangePassword` is true;
  logout is always available because it uses the refresh token. Other CLI data routes return
  403 `password_change_required`.

### CLI session store

`cli_sessions` already exists. It stores one row per refresh token and groups rows by
`family_id`.

| Field | Meaning |
|---|---|
| `id` | Row ULID; not returned to clients |
| `family_id` | Public CLI session family ULID; this is the JWT `sid` and the list/revoke id |
| `principal_id` | Owner |
| `refresh_hash` | SHA-256 of the 43-character refresh token; unique |
| `expires_at` | Absolute family expiry; inherited by every rotated row |
| `revoked_at` | Rotation, logout, reuse, or password-change revocation time |
| `created_at` | Row creation time |
| `ip`, `user_agent` | Optional login context |

- Add `UNIQUE (family_id) WHERE revoked_at IS NULL` and indexes supporting the retention
  cleanup.
- The list route returns one entry per family with at least one live row:
  `{ id: familyId, createdAt, expiresAt, current }`. `current` is true when the family id
  equals the caller's `sid`. Never return `refresh_hash`, row ids, or tokens.
- The delete route checks `principal_id` ownership, revokes every row in the family, and
  returns 404 `session_not_found` when the family is not owned or no live row exists.
- Retention: keep expired and revoked rows for 30 days after the later of `expires_at` and
  `revoked_at`, then delete them. Run the idempotent cleanup daily.

### JWT signing keys

Add a `signing_keys` table with:

| Field | Meaning |
|---|---|
| `kid` | ULID key identifier, also the JWT header `kid` |
| `public_key` | 32-byte Ed25519 public key, stored in clear |
| `wrapped_seed` | 32-byte Ed25519 private seed, AES-256-GCM wrapped by the KEK |
| `wrap_nonce`, `wrap_tag` | 12-byte nonce and 16-byte authentication tag |
| `kek_id` | KEK that wrapped the seed |
| `status` | `current`, `previous`, or `retired` |
| `created_at`, `activated_at`, `retired_at` | Lifecycle timestamps |

- Wrap the seed with AES-256-GCM under the current KEK and AAD `ov:jwt:v1:<kid>`. Do not use
  the project secret/certificate envelope AAD. The seed is never stored in clear.
- The server's keyring wrapper must expose a scoped callback for the named KEK, or an
  equivalent wrapping service. Controllers must never receive raw KEK bytes.
- Enforce at most one `current` and one `previous` key with partial unique indexes.
- `ensureSigningKey()` runs under a PostgreSQL advisory lock. If no current key exists, it
  generates an Ed25519 key pair, inserts the current key, and returns it. If a current key
  exists, it loads it. Startup and `ov init` are idempotent.
- `rotateSigningKey()` runs in a transaction: the new key becomes `current`, the old current
  becomes `previous`, and the old previous becomes `retired`. The previous key remains valid
  for verification until the maximum access-token lifetime plus 30 seconds have passed, then
  is retired. The operation never leaves two current keys. Reject a rotation that would
  retire a previous key still inside its overlap window; wait or fail with a clear error
  instead of invalidating live tokens.
- Sign with the current key. Verify with current and previous; reject retired or unknown
  `kid` values.
- RD-13 re-wraps every signing-key row when the KEK rotates and updates `kek_id` in the same
  transaction.
- No JWKS endpoint and no CLI-side verification in v0.1.

### API contracts

Add `packages/api-contract/src/cli-auth.ts` and export it from the package index.

| Schema | Shape |
|---|---|
| `cliLoginRequestSchema` | Reuse `loginRequestSchema`: `{ identifier, password }` |
| `cliRefreshTokenSchema` | `^[A-Za-z0-9_-]{43}$` |
| `cliTokenResponseSchema` | `{ accessToken, refreshToken, tokenType: "Bearer", accessExpiresAt, refreshExpiresAt, user, mustChangePassword }` |
| `cliRefreshRequestSchema` | `{ refreshToken }` |
| `cliLogoutRequestSchema` | `{ refreshToken }` |
| `cliMeResponseSchema` | `{ user, mustChangePassword }` |
| `cliSessionEntrySchema` | `{ id, createdAt, expiresAt, current }` |
| `cliSessionListSchema` | `{ sessions: cliSessionEntrySchema[] }` |

- `user` is the existing `authUserSchema`; CLI login uses `authMethod: "local"`.
- `accessExpiresAt` and `refreshExpiresAt` are ISO timestamps. Do not use an ambiguous
  `expiresAt` for two different lifetimes.
- All request objects are strict: unknown fields are rejected.
- Stable errors: `400 validation_error`, `401 invalid_credentials`,
  `401 invalid_refresh_token`, `401 authentication_required`,
  `403 password_change_required`, `404 session_not_found`, `429 RATE_LIMIT_EXCEEDED`.
- Use the WebAFX success/error envelopes. Errors never echo token values.

### Rate limits

| Route | Limit | Key |
|---|---|---|
| CLI login | 5/minute | Client IP, shared with browser login |
| CLI login | 10/hour | Normalized identifier hash, shared with browser login |
| CLI refresh | 60/minute | Client IP |
| CLI refresh | 30/minute | Family id, resolved after the refresh-token hash lookup |

Rejected requests return 429 `RATE_LIMIT_EXCEEDED`. The per-family refresh check runs after
the row and family lookup so rotation does not reset the bucket. Login uses the same limiter
instances as browser login; separate instances are not acceptable.

### Logging and redaction

- Extend `REDACT_PATHS` with `req.body.accessToken` and `req.body.refreshToken`.
- Never log request bodies, token responses, password hashes, raw signing seeds, or the
  `Authorization` header.
- The logger's request-url sanitizer continues to strip query strings. CLI tokens travel in
  headers or JSON bodies, not query strings.
- Add a captured-log test that sends valid and invalid login/refresh bodies and asserts the
  raw tokens are absent from logs and error envelopes.

### Retention and cleanup

- Retain expired and revoked `cli_sessions` rows for 30 days after the later of `expires_at`
  and `revoked_at`.
- Run an idempotent cleanup at startup and every 24 hours. The delete uses a bounded batch
  and does not block request traffic.
- Add an index supporting the cleanup predicate. Do not delete a row that is still the live
  row of its family.

### Runtime

- Use the installed `jose` package for JWT signing and verification. Do not add a new
  production dependency.
- Use Node's `generateKeyPairSync("ed25519")` or the equivalent `crypto` API to create the
  key pair. Zero or discard the private seed after wrapping.
- Use `newUlid()` for family ids, row ids, `jti`, and `kid`.
- Use `CLOCK_SKEW_SECONDS` for JWT verification.
- Node baseline remains 24.7 or later.

## Integration Points

- RD-03 supplies the browser session, the local credential verifier, lockout state, password
  change, and the browser guards. RD-04 extends the password-change transaction and makes the
  guards browser-only.
- RD-06 uses the JWT `sub` and `kind` and loads roles and permissions from the database. It
  must not trust authorization data from the token.
- RD-07 audits CLI login success/failure, refresh, reuse detection, logout, password-change
  revocation, and signing-key rotation. It records old/new row ids for rotation and never
  records tokens.
- RD-11 owns the `ov` binary, `~/.config/openvault/credentials.json` and its OS-specific
  paths, atomic writes, permissions, symlink handling, concurrent-process locking, `ov
  logout`, argv handling, local logs, and `ov auth sessions`. RD-04 supplies the server
  endpoints. RD-11 must fail closed on a corrupt or loosely permissioned file.
- RD-13 re-wraps the signing key during KEK rotation and may schedule the CLI session cleanup.
- RD-14 verifies the CLI security tests, token non-persistence, and key rotation.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | Decision Ref |
|---|---|---|---|---|
| CLI auth | API key / JWT + refresh / OIDC | JWT + rotating refresh | Short-lived, revocable | AR-6 |
| Access lifetime | 5 / 15 / 60 minutes | 15 minutes | Limits stolen-token window | — |
| Refresh lifetime | 1 / 12 / 24 hours; absolute or sliding | 12 hours absolute per family | Bounded session; rotation cannot extend it | PF-005 |
| Client ownership | RD-04 / RD-11 | RD-11 | RD-11 creates `apps/cli`; avoids a circular dependency | PF-001 |
| Signing key storage | Keyring entry / derived from KEK / dedicated table | Dedicated `signing_keys` table | Wraps the seed, supports two active keys, re-wrappable by RD-13 | PF-002 |
| Access-token revocation | Stateless / principal check / family check | Principal and family check on every request | Disable, logout, and password change take effect immediately | PF-003 |
| Refresh concurrency | Application lock / row lock / conditional update | Row lock plus partial unique index | Atomic; prevents family forks | PF-005 |
| Password change | Leave CLI families / revoke all | Revoke all CLI families | A password change evicts stolen CLI tokens | PF-006 |
| API contracts | Inline / shared Zod / reuse browser | Shared Zod | Server, CLI, and tests stay aligned | PF-007 |
| Credential storage | Plain file / 0600 file / keychain | 0600 file in RD-11; not RD-04 | Cross-platform baseline; no double ownership | PF-001 |
| Login limits | Shared / separate buckets | Shared with browser login | "Same limits" must be true across both doors | PF-004 |
| Refresh limits | None / 5 per minute / 60 per IP plus 30 per family | 60/min per IP, 30/min per family | Bounds abuse without blocking normal use | PF-009 |
| Retention | Delete on expiry / 30 days / forever | 30 days | Preserves reuse detection and incident context | PF-010 |
| JWT claims | Minimal / roles and permissions | Minimal; policy from database | Immediate role revocation; smaller token | PF-011 |
| Logging | Body logging / redaction / no bodies | Redact nested token fields and never log bodies | Defense in depth | PF-012 |
| OIDC CLI | v0.1 / v0.2 | v0.2 | Scope control | AR-30 |

## Security Considerations

- **Data sensitivity:** passwords, password hashes, access tokens, refresh tokens, refresh
  hashes, and the Ed25519 private seed.
- **Input validation:** identifier at most 320 characters; password at most 1024; refresh
  token exactly 43 base64url characters; JWT header and claims bounded; `kid`, `sub`, `sid`,
  and `jti` validated as ULIDs; unknown request fields rejected.
- **Authentication and authorization:** CLI login is public and rate limited; refresh and
  logout require the refresh token; `/cli/me` and data routes require a valid bearer; browser
  cookies are rejected. A disabled principal, revoked family, invalid signature, wrong
  algorithm, wrong issuer, wrong audience, or expired token returns 401.
- **CSRF:** CLI routes are bearer-only and set no cookie. The Origin and CSRF guards are
  scoped to browser contexts. A CLI request must not be forced to send browser headers.
- **Injection:** all SQL is parameterized. Token fields are used as parameters, never
  concatenated into SQL.
- **Encryption:** TLS on the admin listener; Ed25519 signing key wrapped by the KEK with a
  dedicated AAD; refresh tokens stored only as SHA-256; no raw token at rest.
- **Rate limiting:** shared login limits (5/minute per IP, 10/hour per account); refresh
  limits (60/minute per IP, 30/minute per family).
- **Concurrency:** refresh uses a row lock and a partial unique index; password change
  serializes with refresh per principal so no new family can be inserted after revocation.
- **Revocation:** family revocation on reuse, logout, and password change; principal status
  check on every request; 5-second bound for disable.
- **Logging:** never log request bodies, tokens, hashes, seeds, or the Authorization header;
  redact nested `req.body.accessToken` and `req.body.refreshToken`; errors never echo tokens.
- **Client storage:** RD-11 owns the `0600` file, `0700` directory, atomic write, symlink
  rejection, Windows ACL behavior, and concurrent-process locking. Tokens never appear in
  argv.
- **Availability:** bounded cleanup; one current and one previous signing key; no unbounded
  table growth.

## Acceptance Criteria

1. [ ] A valid CLI login returns a 200 token response. The access token is an Ed25519 JWT with
   issuer `openvault`, audience `openvault-cli`, a 15-minute lifetime, and claims `sub`,
   `sid`, `jti`, `iat`, `exp`, and `kind: "user"`. The refresh token is a 43-character
   base64url string that decodes to 32 bytes and is not a JWT.
2. [ ] `cli_sessions` stores only the SHA-256 hash of the refresh token; the raw token is
   absent from the database, logs, and error bodies.
3. [ ] Refresh returns a new access token and refresh token. The old refresh token fails. The
   family's `expires_at` is unchanged by rotation.
4. [ ] Reusing an already-rotated refresh token revokes the whole family; the current refresh
   token also fails. Two concurrent refreshes produce exactly one success; the loser revokes
   the family, so both returned refresh tokens fail.
5. [ ] Logout revokes the family. A subsequent refresh returns 401, and a subsequent
   `/v1/auth/cli/me` request with an access token from that family returns 401. Logout is
   idempotent.
6. [ ] Disabling a principal makes the next refresh and `/v1/auth/cli/me` request fail within
   5 seconds.
7. [ ] Changing a password revokes every CLI family for the principal; the old access and
   refresh tokens fail and a fresh login with the new password succeeds.
8. [ ] A valid bearer token is accepted. Wrong algorithm, issuer, audience, `kid`, or expiry,
   a disabled principal, a revoked family, and a browser cookie are rejected. Browser CSRF
   and Origin checks do not apply to CLI requests.
9. [ ] The first signing key is created once. The JWT header `kid` matches the current key. A
   rotation creates a new current key and keeps the old key as previous; an access token
   signed by the previous key verifies during the overlap; a retired key is rejected. The
   database contains no raw seed.
10. [ ] CLI and browser login share the same lockout and rate-limit buckets. Five failures on
    either surface lock both; the generic 401 body and dummy verification are used.
11. [ ] The CLI request and response schemas are strict Zod schemas in
    `@openvault/api-contract`. `accessExpiresAt` and `refreshExpiresAt` are distinct. A
    malformed logout body returns 400; a well-formed unknown token returns 204.
12. [ ] `GET /v1/auth/cli/sessions` lists families without hashes; `DELETE
    /v1/auth/cli/sessions/:familyId` revokes an owned family and returns 404 for another
    principal's family.
13. [ ] The 61st refresh in one minute from one IP and the 31st legitimate refresh in one
    minute for one family return 429. The family bucket is not reset by rotation.
14. [ ] Cleanup retains expired and revoked rows for 30 days, then deletes them; it never
    deletes a live family row.
15. [ ] Tokens never appear in argv, server logs, or error bodies. RD-11 proves the credential
    file, local logs, and argv behavior; RD-04 proves server-side redaction.
16. [ ] A service principal cannot complete CLI login, and no CLI family is created for it.
17. [ ] Security requirements verified: token lifetimes, absolute family expiry, rotation,
    reuse detection, signing-key rotation, password-change revocation, storage permissions,
    rate limits, log redaction, and service-principal rejection.

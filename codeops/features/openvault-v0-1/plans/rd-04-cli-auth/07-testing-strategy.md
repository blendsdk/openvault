# Testing Strategy: RD-04 CLI Authentication

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| JWT, wrapping, and signing-key lifecycle | 95% |
| CLI session repository and transactions | 90% |
| Shared local login and rate limits | 90% |
| Controllers and middleware | 85% |
| Contracts and documentation | 90% / docs build |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL through the existing disposable-database helper, real
  HTTPS, and real `jose`/Node crypto. There are no database or crypto mocks.
- The CLI binary is not part of RD-04. HTTP-level tests cover the complete server boundary;
  browser-to-CLI end-to-end tests belong to RD-11/RD-14.

## 🚨 Specification Test Cases

> These cases derive from RD-04, the preflight decision record, and the Ambiguity Register. The
> in-code traceability comment quotes the behavior in plain language; it never includes an `ST-`
> id, an RD id, or a `requirements/` path.

### Contracts

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Parse a complete CLI token response with `tokenType:"Bearer"`, distinct `accessExpiresAt`/`refreshExpiresAt`, valid user, and `mustChangePassword:false` | Schema accepts | RD-04 API contracts; AR-8 |
| ST-2 | Add an unknown field to a CLI login, refresh, logout, token, me, or session response | Strict schema rejects | RD-04 API contracts; AR-8 |
| ST-3 | Parse refresh tokens of 42 characters, 43 base64url characters, 44 characters, and 43 characters containing `+` or `=` | Only the 43-character unpadded base64url value is accepted | RD-04 refresh token; AR-2 |
| ST-4 | Parse login `{identifier:" Alice@Example.com ",password:"x"}` and a login with `rememberMe` | Padded identifier accepted without lowercasing; unknown field rejected | RD-04 local CLI login; AR-8 |
| ST-5 | Parse `/cli/me` and a session list entry containing a hash, token, or row id | Valid shapes accepted; the schemas have no field for hashes, tokens, or row ids | RD-04 API contracts; AR-9 |

### Schema and migration

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-6 | Apply migrations to an empty database | `signing_keys` exists with the documented columns; `cli_sessions` and the existing tables remain | RD-04 signing keys; AR-3, AR-13 |
| ST-7 | Inspect indexes and constraints | One partial unique index for `signing_keys(status) WHERE status='current'`, one for `previous`, one for live `cli_sessions(family_id)`, and one cleanup expression index exist | RD-04 concurrency/retention; AR-6, AR-11, AR-17, AR-24 |
| ST-8 | Run the migration ledger and type checks | Three migrations apply, the public table count is 20, generated types include `SigningKeys`, and `db:types:check` reports no drift | RD-04; AR-13 |

### Signing keys and JWT

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-9 | Call `ensure()` twice on an empty database | One `current` row; `public_key` and `wrapped_seed` are 32 bytes; the second call returns the same `kid`; no raw seed is stored | RD-04 acceptance 9; AR-3, AR-17 |
| ST-10 | Call `ensure()` concurrently from two requests | Exactly one current key and one `kid`; the partial index and advisory lock hold | RD-04 first-key rule; AR-3, AR-23 |
| ST-11 | Wrap a seed under KEK `k1` with AAD `ov:jwt:v1:<kid>`, then unwrap; retry with a wrong AAD or a flipped tag byte | Round trip returns the original seed; wrong AAD/tamper throws without plaintext | RD-04 signing-key wrapping; AR-3, AR-28 |
| ST-12 | Decode a freshly issued access token header and payload | Header has `alg:"EdDSA"` and the current `kid`; payload has exactly `iss`, `aud`, `sub`, `sid`, `jti`, `iat`, `exp`, `kind`; `exp - iat = 900`; `sid` is the family id | RD-04 acceptance 1; AR-2, AR-22 |
| ST-13 | Rotate once, then verify a token signed by the old current key | New key is current, old key is previous, and the old token verifies inside the overlap window | RD-04 acceptance 9; AR-17 |
| ST-14 | Advance past 15m30s after rotation; call `retireDue()`, then verify the previous token; also verify a retired and an unknown `kid` | Previous token is rejected once due; `retireDue()` marks the row retired; retired and unknown keys are rejected | RD-04 acceptance 9; AR-17 |
| ST-15 | Verify tokens with HS256, wrong issuer, wrong audience, wrong `kid`, `kind:"service"`, missing `sub`/`sid`/`jti`, future `iat`, and expired `exp` | Each token is rejected with a stable token error; a valid token is accepted | RD-04 acceptance 8; AR-22 |
| ST-52 | Service A loads a key; service B rotates and then retires the old key; A verifies a time-valid old-key token after its warm cache expires | A refreshes the atomic snapshot and rejects the retired key; it does not keep accepting the old key as current | RD-04 retired-key rule; AR-17, AR-37 |

### CLI login

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-16 | Valid CLI login | 200 token response; `tokenType:"Bearer"`; user has `authMethod:"local"`; access/refresh expiries are ISO and distinct; no `Set-Cookie` header | RD-04 acceptance 1/11; AR-2, AR-8 |
| ST-17 | Valid CLI login | `cli_sessions.refresh_hash` equals SHA-256 of the raw refresh token; the raw token is absent from every database column | RD-04 acceptance 2; AR-2 |
| ST-18 | Unknown identifier, wrong password, disabled principal, and locked principal | Identical `401 invalid_credentials` body; each generic path spends one dummy Argon2 derivation; only the wrong-password path increments the counter | RD-04 acceptance 10; AR-5 |
| ST-19 | Five CLI failures for one account from distinct IPs, then a correct browser login | Browser login returns 401 and the account is locked; CLI created the lock | RD-04 acceptance 10; AR-5 |
| ST-20 | Five browser failures for one account from distinct IPs, then a correct CLI login | CLI login returns 401 and the account is locked; browser created the lock | RD-04 acceptance 10; AR-5 |
| ST-21 | Five browser login attempts from one IP, then one CLI login from the same IP | Sixth request returns 429 `RATE_LIMIT_EXCEEDED`; the bucket is shared | RD-04 acceptance 10; AR-5, AR-15 |
| ST-22 | Ten browser attempts for one normalized identifier from distinct IPs, then one CLI attempt | CLI attempt returns 429; the account bucket is shared and keyed by a hash | RD-04 acceptance 10; AR-5, AR-15 |
| ST-23 | Login for a principal with `must_change=true` | 200 with `mustChangePassword:true`; no cookie; a family is created | RD-04 local CLI login; AR-2, AR-5 |
| ST-24 | A password change races a CLI login after credential verification | The login waits on the per-principal lock, rechecks the hash, returns 401, and creates no family; or the password change waits and then revokes the family | RD-04 local CLI login; AR-5, AR-33 |

### Refresh, logout, and bearer authentication

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-25 | Refresh with a valid token | 200 with a new access token and new 43-character refresh token; old refresh fails; family `expires_at` is unchanged | RD-04 acceptance 3; AR-2, AR-6 |
| ST-26 | Refresh with an already-rotated token | 401 `invalid_refresh_token`; every row in the family is revoked; the current refresh token also fails | RD-04 acceptance 4; AR-6 |
| ST-27 | Two concurrent refreshes with the same token | Exactly one 200; the loser returns 401; the loser revokes the family; both returned refresh tokens fail | RD-04 acceptance 4; AR-6, AR-23 |
| ST-28 | Logout with a valid refresh token, then repeat logout | 204 both times; subsequent refresh and `/cli/me` with the old access token return 401 | RD-04 acceptance 5; AR-6, AR-8 |
| ST-29 | Logout with a 42-character token and with a well-formed unknown 43-character token | Malformed returns 400 `validation_error`; unknown returns 204 | RD-04 acceptance 5/11; AR-8 |
| ST-30 | Disable the principal, then refresh and call `/cli/me` with the old access token | Both return 401; refresh revokes the family; the old access token fails on the next request | RD-04 acceptance 6; AR-2, AR-4 |
| ST-31 | Valid bearer token on `GET /v1/auth/cli/me` | 200 with the public user and `mustChangePassword`; no cookie is required or set | RD-04 acceptance 8; AR-4 |
| ST-32 | `/cli/me` with only a browser cookie; then with an invalid Bearer token plus a valid browser cookie | Both return 401; the invalid bearer does not fall back to the cookie | RD-04 acceptance 8; AR-18 |
| ST-33 | Bearer tokens with wrong alg, issuer, audience, `kid`, `kind`, expired `exp`, or a revoked family | Each returns 401 `authentication_required` | RD-04 acceptance 8; AR-22 |
| ST-34 | CLI refresh/logout with no `Origin` and no `X-CSRF-Token`; browser mutation with a cookie and no CSRF token | CLI requests succeed; the browser request still returns 403 `csrf_invalid` | RD-04 access-token auth; AR-4 |
| ST-35 | Forced-change CLI family calls `/cli/me`, `/sessions`, and `/logout` with and without its bearer token | `/cli/me` returns 200 with `mustChangePassword:true`; `/sessions` returns 403 `password_change_required`; logout returns 204 in both cases | RD-04 forced-change gate; AR-4, AR-35 |
| ST-36 | Send both a valid bearer token and a valid browser cookie to `/cli/me` | The CLI principal is used; the browser session does not override it | RD-04 access-token auth; AR-4, AR-18 |
| ST-37 | Present an invalid Bearer token on public CLI login | Login still works; no browser cookie is consulted | RD-04 access-token auth; AR-18 |
| ST-49 | Send 60 refreshes from one IP in one minute, then a 61st | 61st returns 429 `RATE_LIMIT_EXCEEDED` | RD-04 acceptance 13; AR-10 |
| ST-50 | Complete 30 legitimate rotations for one family in one minute, then a 31st | 31st returns 429; the family bucket was not reset by rotation | RD-04 acceptance 13; AR-10 |

### Sessions, password change, and retention

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-38 | Two CLI families for one principal, then list | Only live families; `createdAt` equals family login time and stays fixed after refresh; newest first; one `current:true`; no hash, token, or row id | RD-04 acceptance 12; AR-9, AR-19 |
| ST-39 | Delete an owned non-current family; then delete the current family | 204 and the family can no longer refresh or authenticate; deleting the current family kills the caller's next request | RD-04 acceptance 12; AR-9, AR-20 |
| ST-40 | Delete a foreign family, unknown family, malformed id, already-revoked family, and expired family | Each returns 404 `session_not_found`; the foreign family remains live | RD-04 acceptance 12; AR-20, AR-31 |
| ST-51 | Race an owned-family delete with a refresh of the same family | The principal lock serializes them; after a successful delete no live row or refresh token remains | RD-04 family revoke; AR-34 |
| ST-41 | Password change with two CLI families and one browser session | Password update and every CLI revocation commit together; old refresh/access tokens fail; fresh login with the new password succeeds; other browser sessions remain revoked | RD-04 acceptance 7; AR-7 |
| ST-42 | Two concurrent password changes with different current sessions | Exactly one wins; only the winner's transaction revokes CLI families; the loser changes nothing | RD-04 password-change rule; AR-7, AR-23 |
| ST-43 | Seed rows 31 days past expiry, 29 days past expiry, a revoked row 31 days past revocation, and a live row; run cleanup twice | 31-day rows are deleted; 29-day and live rows remain; second run deletes zero; at most 1,000 rows per batch | RD-04 acceptance 14; AR-11, AR-24 |
| ST-44 | Call `bootstrapAuthRuntime` twice; make the initial cleanup fail | One current key and one timer; cleanup failure is logged and does not fail startup; the next run retries | RD-04 startup/retention; AR-16, AR-24, AR-32 |

### Logging and documentation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-45 | Inspect `REDACT_PATHS` and log a nested object with `req.body.accessToken` and `req.body.refreshToken` | Both paths are present and both values become `[Redacted]` | RD-04 logging; AR-12 |
| ST-46 | Send valid and invalid login/refresh/logout requests while capturing logs and error bodies | No raw access token, refresh token, password, refresh hash, or signing seed appears; error bodies contain only stable codes/messages | RD-04 acceptance 15; AR-12, AR-28 |
| ST-47 | Build the documentation | The auth guide names `/cli/me`, refresh limits, session list/revoke, logout idempotence, and the process-local limitation; links resolve | RD-04 docs; AR-29 |
| ST-48 | Run `pnpm verify` under Node 24.21.0 | Build, typecheck, lint, unit/root tests, artifact checks, React check, and docs build pass | Plan-local AC; AR-26 |

## Test Categories

### Specification Tests

| Test file | ST cases | Component |
|---|---|---|
| `packages/api-contract/tests/cli-auth.spec.test.ts` | ST-1–ST-5 | Contracts |
| `apps/server/tests/integration/schema.spec.test.ts` | ST-6–ST-8 | Schema/migration |
| `apps/server/tests/integration/auth/signing-keys.spec.test.ts` | ST-9–ST-14, ST-52 | Key lifecycle |
| `apps/server/tests/auth/cli-jwt.spec.test.ts` | ST-12–ST-15 | JWT |
| `apps/server/tests/integration/auth.cli-login.spec.test.ts` | ST-16–ST-24 | Login and shared limits |
| `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` | ST-25–ST-37, ST-49–ST-50 | Refresh, logout, bearer, limits |
| `apps/server/tests/integration/auth.cli-sessions.spec.test.ts` | ST-38–ST-44, ST-51 | Sessions, password, retention |
| `apps/server/tests/integration/auth.cli-logging.spec.test.ts` | ST-45–ST-46 | Redaction |
| `apps/server/tests/startup.spec.test.ts` / docs build | ST-47–ST-48 | Release verification |

### Implementation Tests

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/auth/local-login.impl.test.ts` | Failure branches, CAS loss, revalidation, policy hash | High |
| `apps/server/tests/auth/login-rate-limits.impl.test.ts` | Account key, shared wrappers, family consume after lookup | High |
| `apps/server/tests/auth/middleware.impl.test.ts` | Browser/CLI union, require helpers, gate allowlists | High |
| `apps/server/tests/auth/csrf.impl.test.ts` | Browser-only CSRF/Origin behavior | High |
| `apps/server/tests/integration/auth/signing-keys.impl.test.ts` | Wrap failures, due predicate, rotation edge, cache reload | High |
| `apps/server/tests/auth/cli-sessions.impl.test.ts` | Repository result mapping, unique race, cleanup bound | High |
| `apps/server/tests/auth/cli-maintenance.impl.test.ts` | Timer idempotence, failure logging, stop | Medium |
| `apps/server/tests/auth/cli-auth.impl.test.ts` | Token response assembly, sign failure revokes family | High |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| CLI login suite | HTTPS app, PostgreSQL, signing service | Login, lockout, limits, contracts |
| CLI refresh suite | HTTPS app, PostgreSQL, bearer middleware | Rotation, reuse, concurrent refresh, logout, disable, forced change |
| CLI session suite | HTTPS app, PostgreSQL, maintenance | List, delete, password change, cleanup |
| Browser regression suite | Existing auth local/session tests | Shared login and guard changes must not regress |
| Logging suite | HTTPS app, captured pino destination | Nested redaction and no token leakage |

### End-to-End Tests

N/A for RD-04: the `ov` binary is created by RD-11, so a real CLI-to-server E2E test would build
part of a later requirement. The HTTPS integration suite exercises the complete server boundary,
including TLS, middleware, controller, database, and JWT verification.

## Test Data

### Fixtures needed

- Two active users with the fixed Argon2id fixture hash used by the existing auth tests.
- One disabled user, one locked user, and one `must_change=true` user.
- Two and three CLI families per user for list/revoke/password tests.
- Expired and revoked `cli_sessions` rows with timestamps 29 and 31 days in the past.
- A KEK fixture file with at least two named keys, so unwrap-by-`kek_id` can be tested.
- A test clock for signing-key overlap and JWT verification.

### Mock requirements

- No database mocks.
- No crypto mocks.
- `jose` is used directly to craft negative tokens; the signing key is generated in the test.
- A logger destination is a real writable sink, not a mocked logger.
- The existing disposable PostgreSQL and TLS helpers are reused; no new harness.

## Verification Checklist

- [ ] All specification test cases (ST-*) are defined with concrete input/output pairs.
- [ ] Every ST case traces to RD-04, a component spec, or an AR entry.
- [ ] Specification tests are written before implementation.
- [ ] Each phase records a red result before implementation.
- [ ] All specification tests pass after implementation.
- [ ] Implementation tests cover edge cases and internals.
- [ ] All unit, integration, and root policy tests pass.
- [ ] No regressions in existing browser auth, CSRF, session, transport, readiness, or logging tests.
- [ ] `pnpm verify` passes under Node 24.21.0.
- [ ] `pnpm db:types:check` passes after the migration.

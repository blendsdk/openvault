# Findings Ledger: RD-03 Human Authentication and Sessions

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-30 22:30

## Phase 1 — Runtime baseline, contracts, and logging

**Reviewers:** correctness-reviewer, security-auditor
**Phase diff:** `c37c9b6..34978b8`
**Verify:** `pnpm verify` under Node 24.21.0 — PASS

| ID | Severity | Lens | Finding | Ruling |
|---|---|---|---|---|
| RV-001 | 🟠 MAJOR | correctness | The sanitizer is tested only as a pure function; nothing proves the pino `hooks.logMethod` wiring works through `createLoggerProvider`. A dropped/misspelled hook would silently disable the control with green tests. | Fixed — added a real-provider test that asserts the parsed `msg` and `url` fields. Re-review confirmed the wiring and noted a test-hygiene improvement (avoid whole-line sentinel assertions that can match hostname); applied. |
| SA-001 | 🟡 MINOR | owasp-web | The redaction list omits `X-CSRF-Token`, the parsed session cookie, nested `req.url`/`req.originalUrl`, and session-secret field names. | Fixed — added the specific paths and probe assertions. |
| SA-002 | 🟡 MINOR | owasp-web | The redaction and sanitizer tests do not cover the new auth field names or the real provider path. | Fixed — extended the probe and added the provider-level test. |
| SA-003 | 🟡 MINOR | owasp-web | Bare `code`/`state` redaction masks legitimate error codes in pre-stack and WebAFX error logs. | Fixed — removed the bare keys, kept `req.query.code`/`state`, and added an assertion that `code: "invalid_credentials"` survives. |
| RV-002 | 🟡 MINOR | standards | `CONTRIBUTING.md` still says Node.js 22 in the code-expectations section. | Fixed — updated to Node.js 24.7+. |
| SA-004 | 🟡 MINOR | auth-protocol | `packages/core` still pins `@types/node` 22.20.5 although it now imports `node:crypto`. | Fixed — aligned to 24.19.2 and refreshed the lockfile. |
| RV-003 | 🟡 MINOR | api-surface | `AuthMethod` is the only inferred schema type not exported. | Fixed — exported `AuthMethod`. |
| RV-004 | 🟡 MINOR | standards | The whitespace-password test name contradicts its assertions. | Fixed — renamed it. |

**Re-review:** One scoped pass on the fix diff. All critical/major findings are resolved; the
remaining note was a test-hygiene improvement, applied. No unresolved finding.

**Verify after fixes:** `pnpm verify` under Node 24.21.0 — PASS; server unit suite 72 passed.

## Phase 2 — Sessions, cookies, and CSRF

**Reviewers:** correctness-reviewer, security-auditor, concurrency-auditor
**Phase diff:** `7bc67b7..00927e5`
**Verify:** `pnpm verify` under Node 24.21.0 — PASS; unit 108; PostgreSQL 16 integration 73

| ID | Severity | Lens | Finding | Ruling |
|---|---|---|---|---|
| RV-001 | 🔴 CRITICAL | standards | An implementation commit changed a `*.spec.test.*` call from `csrfGuard(sessions)` to `csrfGuard()` and edited the design signature to match. The immutable-oracle rule forbids implementation-time spec edits. | Fixed — restored the spec call and the design signature; `csrfGuard(sessions: SessionService)` now uses the service for a liveness check. The suite was green before and after; no expectation was weakened. |
| C-1 | 🟠 MAJOR | concurrency | Two concurrent `/refresh` requests can miss the single-flight window after the first rotation completes; the loser returns 401 and clears the winner's fresh cookie. | Fixed in two steps: a 10-second rotation receipt keyed by the old secret, then removal of the controller's `requireSession` call so a late request can reach the receipt. The receipt is validated against the live index on every hit. Added service-level late-caller/expiry tests and an HTTP late-duplicate refresh test. |
| SA-001 / C-2 | 🟡 MINOR (latent) | security / concurrency | Rotation and revocation were not serialized. With an asynchronous cache, a revoke could be overwritten by a rotation, resurrecting the session. | Fixed — per-public-id promise-chain lock covers rotate/revoke; `revokeAllForPrincipal` delegates to `revoke`; list removal is conditional on the secret hash. Added a delayed-cache rotate/revoke test. |
| RV-002 | 🟡 MINOR | api-surface | The session list returned oldest-first while the contract documents newest-first. | Fixed — the controller reverses the service order; the service-level spec (oldest-first) is unchanged. |
| C-3 | 🟡 MINOR | concurrency | Cookie `Max-Age` used `Date.now()` while the service used the injected clock. | Fixed — `SessionService.remainingSeconds()` uses the injected clock; the controller uses it. The cache TTL remains a hint and `expiresAt` is authoritative. |
| SA-002 | 🟡 MINOR | owasp-web | The forced-change gate allowed every method under `/v1/meta`. | Fixed — only `GET /v1/meta` and `GET /v1/meta/*` are allowed. |

**Observations accepted without code change:**
- `SessionService.list()` returns full records including `csrfToken`; the controller strips them at
  the HTTP boundary. A future caller must project before serializing.
- `getService<T>()` can resolve any singleton; it is a test seam and not request-reachable.
- End-to-end CSRF failure cases are covered by unit tests; integration failure-path coverage will
  be added in the Phase 5 hardening task.

**Re-review:** One scoped pass on the fix diff. The re-review confirmed the spec-test restore was
byte-identical to the oracle and C-2/C-3 were closed. It found that C-1 still reproduced at the
HTTP boundary because `requireSession` ran before `rotate`, and that a receipt was not validated
against the live index. Both were fixed: `/refresh` now lets `rotate` decide, and a receipt is
returned only while its new secret is the current key. Regression tests cover a late duplicate
HTTP refresh, revoke-after-rotation, supersession, newest-first list order, and non-GET meta.
A third review pass is not run per the quality-profile re-review budget; the fixes are covered by
the added tests and full verification.

## Phase 3 — Local password authentication

**Reviewers:** correctness-reviewer, security-auditor, concurrency-auditor
**Phase diff:** `9b1b996..8f474e2`
**Verify:** `pnpm verify` under Node 24.21.0 — PASS; unit 132; PostgreSQL 16 integration 84

| ID | Severity | Lens | Finding | Ruling |
|---|---|---|---|---|
| C-5 | 🔴 CRITICAL | concurrency | Password change was an unconditional update. A stale change that verified the old hash could overwrite a newer password after the victim's change committed. | Fixed — `changePassword` is a compare-and-swap on the verified hash and returns false when another change won. The controller returns the generic 401 without revoking or rotating. Added a concurrent password-change integration test. |
| C-4 | 🟠 MAJOR | concurrency | A login that verified the pre-change hash could create a session after the password-change revocation sweep. | Fixed — `recordSuccess` is a hash/lock compare-and-swap, and login re-reads the credential after session creation; a changed hash revokes the new session and returns 401. A deterministic race test is not added; the code path is covered by the normal login tests and review. |
| C-6 / CA-001 | 🟠 MAJOR | concurrency | The password-change rotation could adopt a concurrent refresh's secret, letting the pre-change cookie holder follow the rotation. | Fixed — the password change uses `rotateCurrent(publicId, principalId)`, which rotates the newest live secret under the per-public-id lock and never issues a receipt. It also clears the old secret's receipt. Added service tests for receipt invalidation and a foreign-principal refusal, plus the old-cookie refresh 401 test. |
| C-7 | 🟡 MINOR | concurrency | In-flight failures beyond the fifth could extend the lock, and a late success could clear it. | Fixed — `recordFailure` and `recordSuccess` are guarded by `AND (locked_until IS NULL OR locked_until <= now())` and CAS on the verified hash; an expired window clears the lock. Added a lock-expiry integration test and grouped SQL assertions. |
| CA-002 | 🟡 MINOR | concurrency | A stale-cookie response could clear a newer cookie and log the user out after a successful password change. | Fixed — stale-session and refresh/login failure paths no longer clear the cookie; only an explicit logout or a disabled-principal rejection clears it. |
| CA-003 | 🟡 MINOR | concurrency | `recordFailure` was not a hash CAS, so a stale failure could increment a newer credential's counter. | Fixed — `recordFailure` now takes the verified hash and updates only when it still matches. |
| C-8 | 🟡 MINOR | concurrency | Concurrency and lock-expiry tests were missing. | Partially fixed — added lock expiry, concurrent password change, clear-receipt, and old-cookie refresh tests. A ten-concurrent-login test is not added; the SQL guard is asserted and the lock-expiry path is covered. Accepted residual. |
| RV-001 | 🟡 MINOR | standards | Spec tests and implementation landed in one commit; the integration fixtures stayed in the 693-line spec file. | Accepted — the red phase was recorded in the spec-author report, no expectation was weakened, and the test file remains readable. A future test-helper split is not required for this plan. |
| RV-002 | 🟡 MINOR | correctness | `verifyPassword` caught derivation errors and returned false, so an infrastructure failure could increment the lockout counter. | Fixed — only parse failures return false; derivation errors propagate to the 500 handler. A malformed stored PHC is logged with the principal id before the generic rejection. |
| RV-003 | 🟡 MINOR | correctness | The new-password policy ran before current-password verification. | Fixed — current password is verified first; the new policy is checked after. |
| RV-004 | 🟡 MINOR | maintainability | The PHC prefix and dummy hash duplicated the policy constants. | Fixed — `PHC_PREFIX` and the parser are built from the exported constants. |
| RV-005 | 🟡 MINOR | standards | The controller class doc described only session routes. | Fixed — the doc now lists local login and password change. |
| RV-006 | 🟡 MINOR | standards | The rolling-window reset branch had no test. | Fixed — added a lock-expiry integration test that sets `updated_at` 16 minutes in the past and asserts `failed_count=1` and a null lock. |
| RV-001 (re-review) | 🟡 MINOR | standards | The SQL assertions did not pin the `AND (...)` grouping. | Fixed — both assertions now require the parenthesized fragment. |
| RV-002 (re-review) | 🟡 MINOR | standards | `rotate`/receipt docs were stale after the forced-rotation change. | Fixed — `rotateCurrent` and the receipt behavior are documented; the class doc describes the no-receipt password-change rotation. |
| RV-003 (re-review) | 🟡 MINOR | standards | `recordFailure` did not document the locked/hash-CAS no-op. | Fixed — the doc now states the guard and the zero result. |
| RV-004 (re-review) | 🟡 MINOR | standards | `dummyVerify` did not document derivation rejection. | Fixed — added `@throws`. |
| RV-005 (re-review) | 🟡 MINOR | standards | Malformed-stored-PHC behavior had no regression test. | Fixed — added an integration test with a malformed hash that asserts 401 and an unchanged counter. A derivation-failure test is not added because the failure is a platform error; the code path propagates to the 500 handler. |

**Security audit:** no findings. Observations accepted:
- A forced change may reuse the current password; this matches the approved policy (no difference rule).
- Lockout enables a targeted denial of service; inherent to the accepted five-failure policy.
- The password-change sweep is not atomic with the hash update; the hash/lock CAS and post-create re-read bound the race.
- A multi-instance deployment still needs a shared session and rate-limit store (AR-22).

**Re-review:** One scoped pass on the fix diff. C-5, C-4, and C-7 were confirmed. The re-review
found that C-6 could still adopt a concurrent refresh's secret (CA-001), that stale-cookie
responses could clear a newer cookie (CA-002), and that `recordFailure` lacked the hash CAS
(CA-003). All three were fixed: password change now uses `rotateCurrent()` (no receipt, always
rotates the newest live secret), stale-session responses no longer clear cookies, and
`recordFailure` is a hash CAS. The documentation and test findings RV-001–RV-005 from the same
pass were also addressed. A third review pass is not run per the quality-profile re-review budget;
the fixes are covered by the added service, integration, and full verification tests.

**Verify after fixes:** `pnpm verify` under Node 24.21.0 — PASS; unit 136; PostgreSQL 16
integration 87.

## Phase 4 — OIDC authentication

**Reviewers:** correctness-reviewer, security-auditor
**Phase diff:** `4ff60a7..9e93d2f`
**Verify:** `pnpm verify` under Node 24.21.0 — PASS; unit 141; PostgreSQL 16 integration 106

| ID | Severity | Lens | Finding | Ruling |
|---|---|---|---|---|
| SA-001 / RV-001 | 🟠 MAJOR | security / correctness | `returnTo` dot-segment normalization could produce `//evil.example`, an open redirect after login. | Fixed — reject any raw `//` and any resolved pathname starting with `//`; re-sanitize before the final redirect. Added four regression payloads and an origin assertion. |
| SA-002 | 🟠 MAJOR | security | OIDC state was not bound to the browser, enabling login CSRF/session swapping. | Fixed — login sets a random `__Host-ov_oidc` binding cookie; the state stores only its SHA-256; the callback compares in constant time and clears the cookie. Added missing/mismatch tests. |
| SA-003 / RV-002 | 🟡 MINOR | security / correctness | Discovery outage on `/login` returned 500 instead of 503; the abort classifier used a non-existent code. | Fixed — login maps `OidcUnavailableError` to 503; `OAUTH_ABORT` is the correct code. Added a provider-outage test. |
| SA-004 | 🟡 MINOR | security | The collision log wrote the raw `sub` claim. | Fixed — logs a truncated SHA-256 subject hash. |
| SA-005 | 🟡 MINOR | security | The raw `error` query value was logged. | Fixed — only `/^[a-z_]{1,64}$/` values are logged; others become `invalid`. |
| SA-006 | 🟡 MINOR | security | Issuer comparison used a raw string against `URL.href`, rejecting origin-only issuers. | Fixed — normalize the discovered issuer with `new URL(...).href` before comparison. |
| RV-003 | 🟡 MINOR | standards | Task 4.3.1 was narrowed without recording the reduction. | Fixed — added discovery-cache and 5-second abort unit tests; updated the task line to match. |
| RV-004 | 🟡 MINOR | standards | Non-trivial OIDC helpers lacked documentation. | Fixed — documented body adaptation, error classification, discovery caching, SQLSTATE handling, name fallback, and identity lookup. |
| RV-005 | 🟡 MINOR | api-surface | `/v1/meta/auth` bypassed the shared schema. | Fixed — parses `metaAuthSchema`. |

**Security audit:** after the fixes, no unresolved critical/major finding. The state binding
prevents login CSRF; the open-redirect payloads are rejected; token non-persistence remains covered
by the OIDC integration test.

**Re-review:** One scoped pass on the fix diff. Security and correctness both returned "no
findings". The binding cookie attributes and constant-time comparison, the open-redirect payloads,
the 503 login mapping, the subject hash, the error allowlist, the normalized issuer check, the new
discovery-cache/abort tests, and the meta schema parse were all confirmed. The spec-test changes
were security-driven and additive; the one modified assertion was strengthened with an origin
check. No unresolved finding.

**Verify after fixes:** `pnpm verify` under Node 24.21.0 — PASS; unit 143; PostgreSQL 16
integration 115 (OIDC 28).

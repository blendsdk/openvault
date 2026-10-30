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

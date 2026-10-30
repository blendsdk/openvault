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

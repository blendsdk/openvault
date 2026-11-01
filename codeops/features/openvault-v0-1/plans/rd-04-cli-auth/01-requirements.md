# Requirements: RD-04 CLI Authentication

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-04](../../requirements/RD-04-cli-auth.md) — the owning requirements document
> **Preflight**: [00-preflight-report-RD-04.md](../../requirements/00-preflight-report-RD-04.md)

## Scope of this plan (delta view)

The RD is the owning requirements document. This page records only the plan's boundary and the
decisions that are local to this plan.

### In this plan

- RD-04 Must Have: CLI login, JWT access tokens, rotating refresh families, logout, shared
  local login and lockout, bearer authentication, `/cli/me`, signing keys, redaction, and
  retention. [AR-2, AR-3, AR-4, AR-5, AR-6, AR-7, AR-10, AR-11, AR-12]
- RD-04 Should Have: CLI family list and revoke server endpoints. RD-11 exposes the command.
  [AR-9, AR-19, AR-20]
- RD-04 technical requirements: strict shared contracts, token encoding, stable errors, and
  the existing runtime dependencies. [AR-8, AR-13, AR-22, AR-26]
- Plan-local server mechanics: generated migration and types, module split, shared rate-limit
  service, startup bootstrap, key overlap rules, malformed family-id handling, and test
  strategy. [AR-13–AR-39]

### Deferred / out of this plan

- CLI binary, credential file, OS permissions, atomic writes, concurrent-process locking,
  argv handling, local logs, `ov logout`, and `ov auth sessions` — RD-11, per PF-001.
  [AR-1]
- OIDC CLI login, device authorization, long-lived API keys, JWKS, and CLI-side JWT
  verification — RD-04 `Won't Have`; v0.2 or never in v0.1.
- KEK rotation and signing-key re-wrap — RD-13. This plan provides the internal rotation
  method that RD-13 will call. [AR-25]
- RBAC role and permission evaluation — RD-06. The token carries no roles or permissions.
  [AR-2]
- Audit persistence for CLI events — RD-07. This plan does not add audit inserts. [AR-1]
- A public signing-key rotation route or operator command — not in RD-04. [AR-25]

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Migration source | Edit `schema.ts`; generate one incremental migration and regenerate types/snapshots | AR-13 |
| Module split | Separate CLI session, JWT, auth-service, controller, and signing-key modules | AR-14, AR-27 |
| Shared limiters | One per-app `AuthRateLimitService`; async route wrappers resolve it from `req.services` | AR-15 |
| CLI login race | Principal row lock held through family insertion plus hash recheck | AR-33 |
| Startup | `main.ts` calls idempotent `bootstrapAuthRuntime(app)` after `prepare()`; first use also lazily ensures keys | AR-16 |
| Key overlap | Previous verifies only while `now < current.activated_at + 15m30s`; rotation guard only when a previous exists | AR-17 |
| Authorization header | Any Authorization header disables cookie fallback; valid bearer attaches CLI; otherwise unauthenticated | AR-18 |
| Family list | Live families only, `createdAt = MIN(created_at)`, newest first | AR-19 |
| Session routes | CLI bearer required; browser-only request gets 401 | AR-20 |
| Family delete | Principal lock before the family update; no live row survives a racing refresh | AR-34 |
| Rotation row | Current IP/user-agent; original family expiry; unique race revokes family | AR-21 |
| JWT verification | Pure verifier with `jose`, pinned EdDSA, key resolver, injectable time | AR-22 |
| Locking | DB transactions, principal row lock, refresh row lock, advisory lock for key ensure | AR-23 |
| Cleanup | One 1,000-row batch at startup and every 24 hours | AR-24 |
| Rotation exposure | Internal method only; no HTTP route | AR-25 |
| Tests | Real PostgreSQL, real crypto, pure unit tests for JWT, no mocks or new harness | AR-26 |
| Key failure | Generic 500; never issue an unverifiable token | AR-28 |
| Key cache | Atomic current/previous snapshot; refresh a warm cache after 30 seconds; clear on failure | AR-37 |
| Docs | Authentication guide and known limitations; references only if drift is found | AR-29 |

## Acceptance Criteria

The RD owns the 16 acceptance criteria. This plan adds only these execution criteria:

1. [ ] `pnpm verify` passes under Node 24.21.0.
2. [ ] The migration ledger applies cleanly and `pnpm db:types:check` reports no drift.
3. [ ] The CLI integration suite passes against PostgreSQL 16 and 17.
4. [ ] The captured-log test finds no raw access token, refresh token, password, or signing
   seed in server logs or error envelopes.
5. [ ] The existing browser authentication, CSRF, session, transport, and readiness suites
   remain green.
6. [ ] No plan or requirement identifier appears in shipped code or documentation comments.

> **Traceability:** Every plan-local decision above cites the owning [Ambiguity Register](00-ambiguity-register.md)
> entry. The RD owns the functional and security acceptance criteria.

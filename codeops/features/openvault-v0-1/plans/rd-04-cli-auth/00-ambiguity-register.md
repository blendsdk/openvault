## Ambiguity Register: RD-04 CLI Authentication Plan

> **Status**: ✅ GATE PASSED — all 35 items resolved
> **Last Updated**: 2026-11-01 00:38
> **Mode**: make-plan with `--auto-design`
> **Root invocation ID**: `mp-rd04-20261101-0038`
> **Policy version**: 1

The requirements source is the preflighted [RD-04](../../requirements/RD-04-cli-auth.md). Its
accepted preflight decisions are imported as resolved context and are not re-litigated. New
plan-local decisions are either delegated technical decisions recorded with complete
provenance or imported product/security decisions already approved by the user.

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|---|---|---|---|---|
| AR-1 | Scope | Whether RD-04 also owns the CLI binary, credential file, argv handling, and local logs | A: server only, client to RD-11 / B: minimal CLI in RD-04 / C: shared credential package | User accepted PF-001 Option A: server-only RD-04; RD-11 owns the client contract | ✅ Resolved |
| AR-2 | Technical | Access/refresh token formats, lifetimes, claims, and the meaning of `sid` | A: minimal Ed25519 JWT, `sid = family_id`, 15-minute access, 12-hour absolute refresh / B: longer-lived or richer tokens | User accepted PF-003, PF-005, PF-007, PF-011 Option A | ✅ Resolved |
| AR-3 | Data & state | Where the Ed25519 seed lives and how current, previous, and retired keys are represented | A: dedicated `signing_keys` table with KEK-wrapped seed / B: keyring entry / C: derive from KEK | User accepted PF-002 Option A | ✅ Resolved |
| AR-4 | Security | How browser and CLI authentication coexist in middleware and CSRF guards | A: discriminated `browser`/`cli` context, browser-only Origin/CSRF, bearer middleware / B: reuse browser session shape | User accepted PF-003 Option A | ✅ Resolved |
| AR-5 | Security | How CLI login shares lockout, generic failure, dummy verification, and rate-limit buckets with browser login | A: shared `LocalLoginService` and shared limiter instances / B: duplicate flow / C: rate limits only | User accepted PF-004 Option A | ✅ Resolved |
| AR-6 | Edge cases | How concurrent refresh, reuse detection, and absolute family expiry are enforced | A: per-principal and row locks, partial unique index, revoke family on reuse / B: conditional update / C: extra rotation columns | User accepted PF-005 Option A | ✅ Resolved |
| AR-7 | Security | Whether a password change revokes CLI families | A: revoke every family in the password-change transaction / B: asynchronous revocation / C: leave families alive | User accepted PF-006 Option A | ✅ Resolved |
| AR-8 | Integration | CLI request/response contracts, token encoding, expiry fields, and stable errors | A: shared strict Zod schemas with explicit access/refresh expiries / B: inline types / C: reuse browser schemas | User accepted PF-007 Option A | ✅ Resolved |
| AR-9 | Feature gaps | Whether RD-04 exposes CLI family list and revoke endpoints | A: add both server endpoints; RD-11 exposes `ov auth sessions` / B: move to RD-11 / C: logout only | User accepted PF-008 Option A | ✅ Resolved |
| AR-10 | Non-functional | Refresh rate limits and the point at which the family bucket is checked | A: 60/minute per IP and 30/minute per family after lookup / B: no refresh limit / C: reuse 5/minute login limit | User accepted PF-009 Option A | ✅ Resolved |
| AR-11 | Data & state | Retention and cleanup of expired and revoked CLI session rows | A: keep 30 days after the later of expiry and revocation, daily bounded cleanup / B: delete on expiry / C: keep forever | User accepted PF-010 Option A | ✅ Resolved |
| AR-12 | Security | Token fields in nested request-body logs | A: redact `req.body.accessToken` and `req.body.refreshToken` plus captured-log test / B: rely on handler discipline / C: remove body logging | User accepted PF-012 Option A | ✅ Resolved |
| AR-13 | Technical | How the schema change becomes a reviewed migration and generated types | A: edit `schema.ts`, generate one incremental migration with BlendSDK, regenerate types and snapshots / B: hand-write the migration / C: add columns in the trigger migration | AI — delegated by `--auto-design` (see AR-13 note) | ✅ Resolved |
| AR-14 | Naming | File, class, and service names for the new CLI authentication surface | A: `CliAuthController`, `CliAuthService`, `CliSessionRepository`, `SigningKeyService`, `bootstrapAuthRuntime` / B: combine everything in the browser controller / C: generic `auth-v2` naming | AI — delegated by `--auto-design` (see AR-14 note) | ✅ Resolved |
| AR-15 | Technical | How one rate-limiter instance is shared by browser and CLI login routes when route definitions are synchronous | A: per-application `AuthRateLimitService` with async route wrappers that resolve it from `req.services` / B: module-level singleton / C: separate limiter instances | AI — delegated by `--auto-design` (see AR-15 note) | ✅ Resolved |
| AR-16 | Technical | Where startup signing-key ensure and CLI-session maintenance run without making every unit test require PostgreSQL | A: production `main.ts` calls an idempotent bootstrap after `app.prepare()`; services register in the plugin; CLI integration tests call the same bootstrap; first signing use lazily ensures / B: plugin factory does it / C: lazy-only | AI — delegated by `--auto-design` (see AR-16 note) | ✅ Resolved |
| AR-17 | Security | When a previous signing key stops verifying and when a rotation may retire it | A: guard only when a previous exists; reject verification once `current.activated_at + 15m30s <= now`; retire the row at bootstrap/rotation / B: keep previous forever until next rotation / C: add `previous_at` and a scheduler | AI — delegated by `--auto-design` (see AR-17 note) | ✅ Resolved |
| AR-18 | Security | Behavior when an `Authorization` header is present but invalid or not Bearer | A: disable cookie fallback for any Authorization header; attach CLI only when valid; leave unauthenticated otherwise; protected routes return 401 / B: immediate 401 on every route / C: ignore non-Bearer and allow cookie fallback | AI — delegated by `--auto-design` (see AR-18 note) | ✅ Resolved |
| AR-19 | UX & data | Meaning and ordering of `createdAt` in the CLI family list | A: `MIN(created_at)` per family, newest family first, live families only / B: live row creation time / C: separate family table | AI — delegated by `--auto-design` (see AR-19 note) | ✅ Resolved |
| AR-20 | Security | Whether CLI session management routes accept browser sessions | A: require a CLI bearer context / B: accept either browser or CLI / C: make the routes public | AI — delegated by `--auto-design` (see AR-20 note) | ✅ Resolved |
| AR-21 | Data & state | Which request context a refreshed row stores and how a unique-index race is reported | A: carry the current request's IP and user-agent, keep the original family expiry, treat a unique violation as reuse and revoke the family / B: copy the original row context / C: leave the new row context null | AI — delegated by `--auto-design` (see AR-21 note) | ✅ Resolved |
| AR-22 | Technical | How JWT signing and verification use `jose` and how negative verification cases are tested | A: pin EdDSA, require `kid`, validate `iss`/`aud`/`iat`/`exp` with 30-second skew, expose a pure verifier with a key resolver and injectable current time / B: inline verification in middleware / C: use WebAFX auth provider | AI — delegated by `--auto-design` (see AR-22 note) | ✅ Resolved |
| AR-23 | Concurrency | Which database primitives serialize refresh, logout, password change, and signing-key ensure | A: `withTransaction`, a per-principal `FOR UPDATE` row lock, refresh-row `FOR UPDATE`, and a transaction-scoped advisory lock for key ensure / B: application mutexes / C: optimistic retries | AI — delegated by `--auto-design` (see AR-23 note) | ✅ Resolved |
| AR-24 | Non-functional | Cleanup batch size, schedule, and the index that supports it | A: one bounded 1,000-row batch at startup and every 24 hours, expression index on the later of expiry/revocation / B: unbounded delete / C: no index | AI — delegated by `--auto-design` (see AR-24 note) | ✅ Resolved |
| AR-25 | Scope | Whether signing-key rotation gets an HTTP endpoint in RD-04 | A: internal service method only; RD-13 owns KEK re-wrap and operational rotation / B: unauthenticated admin route / C: public route | AI — delegated by `--auto-design` (see AR-25 note) | ✅ Resolved |
| AR-26 | Technical | How the implementation is verified without a new test harness | A: real PostgreSQL integration tests using the existing disposable-database helper, unit tests for pure crypto/JWT functions, and `jose`-crafted negative tokens / B: mock the database / C: add a new runner | AI — delegated by `--auto-design` (see AR-26 note) | ✅ Resolved |
| AR-27 | Naming | What the plan calls the access-token claim object and CLI family record | A: `CliAccessClaims` and `CliFamily` / B: `JwtPayload` and `Session` / C: reuse browser `SessionRecord` | AI — delegated by `--auto-design` (see AR-14 note) | ✅ Resolved |
| AR-28 | Security | What happens when signing-key material is missing, corrupt, or cannot be unwrapped | A: fail the login/refresh request with a generic 500 and never issue a token; log only a stable code and principal id / B: fall back to a deterministic key / C: issue an unsigned token | AI — delegated by `--auto-design` (see AR-28 note) | ✅ Resolved |
| AR-29 | UX & presentation | Documentation scope for the new server behavior | A: update the authentication guide and known limitations; the API and architecture references already carry the contract / B: no documentation change / C: rewrite all architecture docs | AI — delegated by `--auto-design` (see AR-29 note) | ✅ Resolved |
| AR-30 | Stakeholder conflicts | Which review roles cover the security and concurrency risks | A: security-auditor on auth/crypto phases, concurrency-auditor on locking phases, correctness-reviewer every phase / B: correctness only / C: create a new project specialist | AI — delegated by `--auto-design` (see AR-30 note) | ✅ Resolved |
| AR-31 | Behavioral | Response for a malformed `:familyId` on CLI family delete | A: 404 `session_not_found` / B: 400 `validation_error` / C: 422 framework validation | AI — delegated by `--auto-design` (see AR-31 note) | ✅ Resolved |
| AR-32 | Behavioral | Whether a failed initial retention cleanup blocks server startup | A: log and continue; retry in 24 hours / B: fail startup / C: skip all later runs | AI — delegated by `--auto-design` (see AR-32 note) | ✅ Resolved |
| AR-33 | Concurrency | How CLI login closes the password-change race | A: hold the per-principal lock through family insertion and recheck the verified hash / B: insert then re-read without a lock / C: ignore the race | AI — delegated by `--auto-design` (see AR-33 note) | ✅ Resolved |
| AR-34 | Concurrency | Whether owned-family delete must serialize with refresh | A: lock the principal row before the family update / B: single update without a principal lock / C: delete only the current row | AI — delegated by `--auto-design` (see AR-34 note) | ✅ Resolved |
| AR-35 | Edge cases | Whether a forced-change CLI context may call logout when it sends a bearer token | A: allow `POST /v1/auth/cli/logout` in the CLI gate allowlist / B: block it because only `/cli/me` is listed / C: ignore the context on logout | AI — delegated by `--auto-design` (see AR-35 note) | ✅ Resolved |

## Resolution Notes

### AR-1 — Scope

Imported from PF-001. The plan implements only the server API, token model, signing keys, and
revocation semantics. The CLI binary, credential file, argv handling, client logs, and
`ov auth sessions` remain RD-11 work.

### AR-2 — Token contract

Imported from PF-003, PF-005, PF-007, and PF-011. The access token is a 15-minute Ed25519 JWT
with issuer `openvault`, audience `openvault-cli`, and exactly `sub`, `sid`, `jti`, `iat`,
`exp`, `kind: "user"`. `sid` is the family ULID. The refresh token is 32 random bytes encoded
as 43-character base64url. Every family has one absolute 12-hour `expires_at` from login.

### AR-3 — Signing-key storage

Imported from PF-002. A dedicated `signing_keys` row stores the public key in clear and the
32-byte seed wrapped by the current KEK with AES-256-GCM and AAD `ov:jwt:v1:<kid>`.
Current/previous/retired is explicit, with partial unique indexes for current and previous.

### AR-4 — Authentication context

Imported from PF-003. `AuthContext` becomes a discriminated union. Browser contexts carry the
session, CSRF token, and browser user. CLI contexts carry principal, family, `jti`, expiry,
user, and forced-change state. Origin and CSRF checks apply only to browser contexts.

### AR-5 — Shared login behavior

Imported from PF-004. Browser and CLI login both call one `LocalLoginService` for identifier
normalization, lookup, disabled/locked checks, policy-hash validation, dummy verification,
password verification, failure/success counters, and post-success hash recheck. Both routes
use the same per-IP and per-account limiter instances.

### AR-6 — Refresh serialization

Imported from PF-005. A non-locking lookup finds the principal and family. The refresh
transaction then locks `principals` first and the refresh row second, marks the old row
revoked, and inserts the replacement with the family's original `expires_at`. A partial unique
index on `(family_id) WHERE revoked_at IS NULL` is the database backstop.

### AR-7 — Password-change revocation

Imported from PF-006. The password hash update and `UPDATE cli_sessions ... SET revoked_at`
run in one transaction, after the same per-principal lock that refresh takes.

### AR-8 — Contracts and errors

Imported from PF-007. `packages/api-contract/src/cli-auth.ts` owns the strict request and
response schemas. `accessExpiresAt` and `refreshExpiresAt` are distinct ISO timestamps. Stable
errors are the ones listed in RD-04; logout returns 204 for any well-formed token.

### AR-9 — Family management

Imported from PF-008. `GET /v1/auth/cli/sessions` and
`DELETE /v1/auth/cli/sessions/:familyId` are server capabilities in RD-04. RD-11 exposes
`ov auth sessions`.

### AR-10 — Refresh limits

Imported from PF-009. Refresh uses 60/minute per IP and 30/minute per family. The family
bucket is consumed only after a token lookup resolves the family, so rotation cannot reset it.

### AR-11 — Retention

Imported from PF-010. Rows are deleted when the later of `expires_at` and `revoked_at` is more
than 30 days old. Cleanup is idempotent, bounded, and runs at startup and every 24 hours.

### AR-12 — Redaction

Imported from PF-012. `REDACT_PATHS` adds `req.body.accessToken` and
`req.body.refreshToken`. A captured-log integration test proves raw tokens are absent from
login, refresh, and error paths.

### AR-13 — Migration strategy

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Persistence and reversible migration mechanism; within the approved schema and token model.
- **Objective:** Add the approved signing-key table and CLI-session indexes without hand-maintained drift.
- **Decision:** Edit `apps/server/src/database/schema.ts`, run BlendSDK's incremental generator for one `cli-auth` migration, then regenerate `schema.snapshot.json`, `generated-types.ts`, and `ctypes.ts`. The migration is additive and transactional.
- **Evidence:** `apps/server/blendsdk.migrations.ts:10-14` makes `schema.ts` the source; `CONTRIBUTING.md:47-66` defines generation and type regeneration; existing migrations are generated plus reviewed manual files.
- **Rejected alternatives:** Hand-written SQL (drifts from the model and types); editing the initial migration (rewrites immutable history); adding the table in the manual trigger migration (wrong ownership).
- **Strongest counterargument:** Generated SQL must still be reviewed; the generator can choose names or constraint forms that are hard to read.
- **Confidence:** High — the workflow is already used by RD-01.
- **Hardening:** Generator output is reviewed against RD-04 and integration schema tests.
- **Reopen triggers:** The generator cannot express the partial indexes; generation produces destructive changes; the snapshot check fails.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-14 — Naming and module layout

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Internal interfaces and file organization; no product or public-contract change.
- **Objective:** Keep each file reviewable and avoid growing the existing 317-line browser auth controller.
- **Decision:** Use `apps/server/src/auth/cli-sessions.ts` for SQL and transaction-backed family operations, `apps/server/src/auth/cli-jwt.ts` for pure JWT sign/verify helpers, `apps/server/src/auth/cli-auth-service.ts` for token issuance/rotation orchestration, `apps/server/src/security/signing-keys.ts` for key wrapping and lifecycle, and `apps/server/src/controllers/cli-auth.ts` for routes. The access-claim type is `CliAccessClaims`; the family list type is `CliFamily`.
- **Evidence:** `controllers/auth.ts` is already 317 lines; the server splits session, cookie, CSRF, password, and OIDC concerns into separate modules; `packages/core` already has a scoped keyring callback.
- **Rejected alternatives:** One large `AuthController` (crosses the split threshold); a generic `auth-v2` layer (meaningless naming); exposing the core `Keyring` to controllers (key material boundary).
- **Strongest counterargument:** More files increase navigation cost; `cli-jwt.ts` is small enough to merge into the service.
- **Confidence:** High — matches the existing module boundaries.
- **Hardening:** Confirmed by the independent challenger's context review; no divergence.
- **Reopen triggers:** A file exceeds ~500 lines or the JWT helper needs DB access.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-15 — Shared limiter mechanism

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Internal architecture and security mechanism within the approved rate-limit policy.
- **Objective:** Make browser and CLI login consume the same in-memory buckets while keeping per-application isolation.
- **Decision:** Create one `AuthRateLimitService` per application in the auth plugin. It owns four WebAFX limiter instances: login IP, login account, refresh IP, refresh family. Route middleware is a small async wrapper that resolves `authRateLimits` from `req.services` and delegates. Browser and CLI controllers use the same wrappers. The family limiter is consumed explicitly after a refresh-token lookup.
- **Evidence:** `webafx` `rateLimitMiddleware` keeps a private `Map` per invocation (`dist/webafx/application/rate-limiter.js:21-55`); `BaseController.routes()` is synchronous (`base-controller.d.ts:53`); `ServiceContainer.get()` is async (`service-container.d.ts:117`); `req.services` exists (`webafx/application/type.d.ts:6-12`).
- **Rejected alternatives:** A module-level singleton (leaks buckets across test apps and server instances); separate instances (violates PF-004); a custom limiter (new machinery for an existing capability).
- **Strongest counterargument:** The async wrapper adds one promise hop and a failure path to every login request.
- **Confidence:** High — direct consequence of the synchronous route builder.
- **Hardening:** Wrapper propagates resolution failures to `next`; tests prove a browser failure limits CLI and vice versa.
- **Reopen triggers:** WebAFX adds async route definitions or a shared limiter registry.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-16 — Startup bootstrap

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Implementation sequencing and operational mechanism; no scope change.
- **Objective:** Ensure the first signing key and cleanup job run on production startup without making unrelated unit tests require PostgreSQL.
- **Decision:** The auth plugin registers `SigningKeyService` and `CliSessionMaintenanceService`. Production `main.ts` calls `bootstrapAuthRuntime(app)` after `app.prepare()`; the function runs an idempotent `ensureSigningKey()` and starts maintenance. CLI integration tests call the same function. `SigningKeyService` also lazily ensures key material on first sign/verify, so a missed bootstrap cannot mint an unsigned token. The maintenance service is registered for disposal and stops its timer on shutdown.
- **Evidence:** `createTestApplication()` calls `prepare()` (`app.ts:100-106`); unit tests intentionally use a closed database (`logging.spec.test.ts:159-176`, `ready.impl.test.ts:17-37`); `main.ts:24-26` is the production entry. The independent challenger verified this constraint.
- **Rejected alternatives:** Plugin-factory ensure (breaks DB-free unit tests); lazy-only (does not satisfy startup cleanup/ensure); a global bootstrap flag in every test (noisy and weaker default).
- **Strongest counterargument:** A future entry point could call `startTransport()` without `bootstrapAuthRuntime()`, leaving cleanup unscheduled.
- **Confidence:** High — challenger verdict `Justified` for Option B, with lazy ensure to close the forgetting risk.
- **Hardening:** Independent design-challenger; verdict accepted with the lazy-ensure refinement.
- **Reopen triggers:** A second production entry point is added; `prepare()` gains a mandatory bootstrap hook.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-17 — Key overlap and retirement

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Security mechanism within the approved rotation policy.
- **Objective:** Keep old access tokens verifiable only for the approved overlap window.
- **Decision:** The overlap window is 15 minutes plus `CLOCK_SKEW_SECONDS`. A previous key is accepted only while `now < current.activated_at + overlap`. The current key's `activated_at` records when the previous key became previous. A rotation is rejected only when a previous key exists and that predicate is false. Due previous keys are retired at bootstrap and at rotation; verification rejects a due key even if its row still says `previous`.
- **Evidence:** `CLOCK_SKEW_SECONDS` is 30 (`security/clock.ts:2`); the access lifetime is 15 minutes; RD-04 lines 257-261 require the overlap guard; no `previous_at` column exists.
- **Rejected alternatives:** Never retire (violates the bound); add `previous_at` and a scheduler (extra state and machinery); reject every rotation for 15m30s even with no previous key (blocks the first rotation unnecessarily).
- **Strongest counterargument:** The overlap start is implicit in `current.activated_at`; a manual database edit could break the invariant.
- **Confidence:** High — challenger verdict `Justified` for Option A with the due-predicate refinement.
- **Hardening:** Independent design-challenger; the due predicate is enforced at verification, not only at maintenance.
- **Reopen triggers:** A previous-key verification window longer than the access lifetime is approved; key rotations happen on multiple servers without a shared clock.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-18 — Invalid Authorization handling

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Security mechanism within the approved bearer-only policy.
- **Objective:** Prevent an invalid bearer token from silently becoming a browser session.
- **Decision:** Any `Authorization` header marks bearer intent and disables cookie fallback. A valid Bearer token attaches a CLI context. A malformed, invalid, or non-Bearer value leaves the request unauthenticated; protected routes return 401 through `requirePrincipal`, and public login/refresh/logout routes still work. The scheme is matched case-insensitively.
- **Evidence:** RD-04 lines 188-201; `sessionMiddleware` currently reads only the cookie (`middleware.ts:34-77`); CSRF and Origin guards assume browser contexts (`csrf.ts:43-46,79-94`).
- **Rejected alternatives:** Immediate 401 for every Authorization header (breaks harmless proxy headers and public routes); ignore non-Bearer (allows cookie fallback and violates the requirement).
- **Strongest counterargument:** A proxy that injects Basic auth will stop cookie authentication for those requests.
- **Confidence:** High — challenger verdict `Justified` for Option A.
- **Hardening:** Independent design-challenger; tests cover Basic, empty, lowercase `bearer`, invalid Bearer plus a valid cookie, and public routes with a stale header.
- **Reopen triggers:** A deployment requires forwarding a non-Bearer Authorization header to browser routes.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-19 — Family list semantics

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Data presentation for an approved endpoint; no new product behavior.
- **Objective:** Return a stable family creation time without adding a second table.
- **Decision:** List only families with a live row (`revoked_at IS NULL AND expires_at > now()`), group by `family_id`, return `MIN(created_at)` as `createdAt`, `MIN(expires_at)` as `expiresAt`, order newest family first, and set `current` by comparing the family id with the caller's `sid`. No hashes or row ids are returned.
- **Evidence:** Every row in a family shares the original expiry; rows are retained for 30 days; existing `cli_sessions_principal_idx` covers the owner filter; RD-04 lines 226-230 define the entry.
- **Rejected alternatives:** Live row `created_at` (changes on rotation); a separate family table (new persistence surface for one timestamp).
- **Strongest counterargument:** `MIN(created_at)` derives a family fact from retained rows.
- **Confidence:** High — challenger verdict `Justified` for Option A.
- **Hardening:** Independent design-challenger; a listed family is at most 12 hours old, so its original row cannot be retention-deleted.
- **Reopen triggers:** A family table is added for other reasons; retention starts deleting live-family rows.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-20 — CLI session route authentication

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Route-level application of the approved CLI bearer model.
- **Objective:** Keep CLI credential management on the CLI authentication surface.
- **Decision:** `GET /v1/auth/cli/sessions` and `DELETE /v1/auth/cli/sessions/:familyId` require a CLI context; a browser cookie alone receives 401. The delete checks `principal_id` and live-family ownership and returns 404 for any miss.
- **Evidence:** RD-04 lines 72-75 and 226-230; RD-11 exposes `ov auth sessions`; `/cli/me` is explicitly CLI-only.
- **Rejected alternatives:** Accept either context (widens the route beyond the CLI surface); make the routes public (discloses session metadata).
- **Strongest counterargument:** A user may expect to revoke CLI sessions from the browser UI in a later release.
- **Confidence:** High — follows the route family and the CLI command owner.
- **Hardening:** Not challenger-required; direct application of the approved route family.
- **Reopen triggers:** RD-12 needs browser-side CLI session management.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-21 — Rotation row context and unique races

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Persistence details and failure handling within the approved rotation model.
- **Objective:** Preserve useful incident context without changing family identity or expiry.
- **Decision:** A rotated row carries the current request's `ip` and `user_agent`, the same `family_id`, `principal_id`, and original `expires_at`. A unique violation on the partial live-family index is treated as reuse: a separate transaction revokes the family and the request returns 401.
- **Evidence:** RD-04 lines 159-166; the table has `ip` and `user_agent`; the partial index is the backstop; `OidcIdentityService` already maps PostgreSQL `23505` to a domain outcome (`identity.ts:45-48,154-173`).
- **Rejected alternatives:** Copy the login row context (stale after long sessions); store nulls (loses incident context); return 500 on a unique race (turns a security event into an outage).
- **Strongest counterargument:** The new row's context changes on each rotation, while `createdAt` stays family-scoped.
- **Confidence:** High — consistent with the family list decision.
- **Hardening:** Not challenger-required; direct consequence of AR-19 and the approved unique index.
- **Reopen triggers:** RD-07 needs the original login context on every row; the table gains explicit family metadata.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-22 — JWT implementation and testing

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Algorithm and implementation mechanics within the approved JWT policy.
- **Objective:** Pin every security-relevant JWT check and make negative cases deterministic.
- **Decision:** Use `jose` `SignJWT`/`jwtVerify`. Signing pins `EdDSA`, `kid`, `iss`, `aud`, `sub`, `sid`, `jti`, `iat`, `exp`, and `kind`. Verification pins `algorithms: ["EdDSA"]`, exact issuer/audience, a required ULID `kid`, ULID `sub`/`sid`/`jti`, `kind === "user"`, and 30-second clock tolerance for `iat` and `exp`. The verifier is a pure function with a key resolver and injectable current time; middleware only maps its result to an auth context.
- **Evidence:** `jose@6.2.13` is installed; `CLOCK_SKEW_SECONDS` exists; RD-04 lines 97-119 and 188-195.
- **Rejected alternatives:** Inline verification (hard to test); the WebAFX auth provider (not used and token-oriented); accepting any `alg` (algorithm confusion risk).
- **Strongest counterargument:** A pure verifier plus a service key cache duplicates some key lookup logic.
- **Confidence:** High — separates crypto correctness from HTTP plumbing.
- **Hardening:** Unit tests cover wrong alg, issuer, audience, `kid`, `kind`, missing claims, future `iat`, and expired `exp`.
- **Reopen triggers:** `jose` drops Ed25519 or the claim set changes.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-23 — Transaction primitives

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Concurrency and consistency mechanism within the approved locking model.
- **Objective:** Use the database as the only cross-request serialization authority.
- **Decision:** Use `PostgreSQLDatabase.withTransaction` for refresh, logout, password change, and signing-key ensure/rotate. Refresh and password change lock `principals` first with `FOR UPDATE`; refresh then locks the refresh row. Signing-key ensure/rotate use `pg_advisory_xact_lock(hashtext('openvault:signing_keys'))`. No application mutex guards a shared DB invariant.
- **Evidence:** `PostgreSQLDatabase.withTransaction` is async-local and already used in `identity.ts:134-153`; RD-04 lines 149-171 and 253-261; `pg_advisory_xact_lock` is built into PostgreSQL.
- **Rejected alternatives:** In-process locks (do not coordinate instances); optimistic retries (more code and ambiguous reuse semantics); serializable isolation (broader retry surface).
- **Strongest counterargument:** `hashtext` collisions could serialize unrelated advisory locks; the keyspace makes this acceptable.
- **Confidence:** High — follows the approved lock order and existing DB patterns.
- **Hardening:** Tests cover concurrent refresh and concurrent password change.
- **Reopen triggers:** Multi-instance deployment changes the locking assumptions; `withTransaction` semantics change.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-24 — Cleanup bounds

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Operational implementation of the approved retention policy.
- **Objective:** Bound each cleanup transaction without letting the table grow without limit.
- **Decision:** Run one `DELETE ... WHERE id IN (SELECT ... ORDER BY cleanup_key LIMIT 1000)` per run at startup and every 24 hours. Add an expression index on `GREATEST(expires_at, COALESCE(revoked_at, expires_at))`. The delete predicate also requires the row to be expired for more than 30 days, so a usable live row is never removed.
- **Evidence:** RD-04 lines 315-322; existing `cli_sessions` has no cleanup index; table growth is driven by refresh rotation.
- **Rejected alternatives:** Unbounded delete (long locks); no cleanup (unbounded growth); delete on expiry (loses reuse detection).
- **Strongest counterargument:** One 1,000-row batch per day may fall behind extreme rotation volume.
- **Confidence:** Medium-High — the limit is a policy choice; volume is bounded by 12-hour families and rate limits.
- **Hardening:** Batch size is a named constant and can be raised without schema changes.
- **Reopen triggers:** Cleanup lag grows for two consecutive checks; the table gains millions of rows.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-25 — Rotation exposure

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Scope boundary for an internal operational mechanism.
- **Objective:** Implement rotation semantics without adding an unrequested public administrative surface.
- **Decision:** Provide `SigningKeyService.rotate()` as an internal method, tested directly. RD-04 adds no HTTP route. RD-13 owns KEK re-wrap and any operator-facing rotation command.
- **Evidence:** RD-04 lines 253-266; RD-13 is the re-wrap owner; no admin auth surface exists yet.
- **Rejected alternatives:** Add an unauthenticated admin route (security defect); add a public route (scope expansion); omit rotation entirely (fails acceptance 9).
- **Strongest counterargument:** An internal method cannot be operated without a future caller.
- **Confidence:** High — keeps RD-04 within its approved server contract.
- **Hardening:** Not challenger-required; explicit RD boundary.
- **Reopen triggers:** RD-13 adds an operations endpoint or command.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-26 — Test execution strategy

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Testing strategy using existing project infrastructure.
- **Objective:** Prove database, crypto, and HTTP behavior with real components and deterministic negative cases.
- **Decision:** Use the existing disposable PostgreSQL helper and real HTTPS test app for integration. Use unit tests for pure JWT verification, seed wrapping, and rate-limiter service behavior. Craft invalid JWTs with `jose` in tests; do not mock the database or crypto. Do not add a new test runner or harness.
- **Evidence:** `tests/integration/helpers/test-database.ts:169-218`; existing TLS helper; `CONTRIBUTING.md:91-100`.
- **Rejected alternatives:** Mock PostgreSQL (does not prove locking/indexes); a custom CLI test harness (new support surface); skip negative JWT cases (unacceptable security coverage).
- **Strongest counterargument:** Integration tests are slower and need a local PostgreSQL service.
- **Confidence:** High — matches the repository's established test boundary.
- **Hardening:** Spec tests are split by phase so each red phase is focused; full verify remains mandatory.
- **Reopen triggers:** PostgreSQL is unavailable in CI; a pure in-memory adapter becomes a project standard.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-27 — Claim and family naming

Merged with AR-14. The access claim object is `CliAccessClaims`; the family projection is
`CliFamily`. Browser `SessionRecord` is not reused because its `csrfToken`, `publicId`, and
auth-method fields describe a different credential.

### AR-28 — Signing-key failure

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Security failure behavior within the approved fail-closed policy.
- **Objective:** Never issue a token that cannot be verified.
- **Decision:** If key material is missing, corrupt, cannot be unwrapped, or the database key
  operation fails, login/refresh throws a generic 500. No token is returned. If the failure
  happens after a family was inserted, that family is revoked before the request fails. The
  server logs a stable code and, where safe, the principal id; it never logs ciphertext, seeds,
  or tokens.
- **Evidence:** RD-04 lines 59-66 and 387-396; `CryptoIntegrityError` already fails closed
  without plaintext (`packages/core/src/crypto.ts:45-51`).
- **Rejected alternatives:** Deterministic fallback key (compromises every token); unsigned
  token (defeats authentication); continue with a warning (unverifiable credentials).
- **Strongest counterargument:** A 500 during key corruption is operationally visible but
  correct; the alternative is worse.
- **Confidence:** High — direct security requirement.
- **Hardening:** Unit tests for wrong AAD and tampered wrap; integration test that no token is
  returned when the current key is absent and ensure is forced to fail.
- **Reopen triggers:** A KMS-backed signer adds a retryable availability mode.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-29 — Documentation scope

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Documentation maintenance for implemented behavior.
- **Objective:** Keep the public auth guide and limitations aligned without rewriting already
  updated references.
- **Decision:** Update `docs/guide/authentication.md` with `/cli/me`, refresh/session
  management, forced-change behavior, refresh limits, and logout idempotence. Add known
  limitations for process-local refresh limiter buckets and the absence of an operator-facing
  key-rotation command. `docs/reference/api.md`, `docs/architecture/identity.md`, and
  `docs/architecture/crypto.md` already carry the preflighted contract; change them only if
  implementation reveals drift.
- **Evidence:** `docs/reference/api.md:92-123` and `docs/architecture/identity.md:32-40` already
  describe the contract; `docs/guide/authentication.md:81-90` is shorter.
- **Rejected alternatives:** No docs change (stale guide); rewrite all docs (unnecessary
  churn).
- **Strongest counterargument:** The reference already exists, so the guide update is small.
- **Confidence:** High.
- **Hardening:** Docs build is part of `pnpm verify`.
- **Reopen triggers:** Implementation changes a public field or error.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-30 — Review roles

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Review strategy; no new specialist creation.
- **Objective:** Cover authentication-protocol and transaction-concurrency risks with existing
  roles.
- **Decision:** Use `security-auditor` on every phase touching tokens, key wrapping, login, or
  middleware; `concurrency-auditor` on refresh, password-change, and signing-key lifecycle
  phases; and `correctness-reviewer` on every executed phase. Do not create a project
  specialist: the catalog roles plus dynamic packets cover the domain.
- **Evidence:** `codeops/codeops.json` quality profile; RD-04 is an auth-protocol and
  concurrency feature; no repeated project-specific finding pattern exists yet.
- **Rejected alternatives:** Correctness only (misses protocol/concurrency risks); a new
  project specialist (no unique project invariant beyond the catalog checklists).
- **Strongest counterargument:** A standing specialist could accumulate RD-04 context across
  phases.
- **Confidence:** High — no recurring evidence justifies new machinery.
- **Hardening:** Not challenger-required; this is review selection, not a gate change.
- **Reopen triggers:** Two review batches repeat the same CLI-auth finding area.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-31 — Malformed family id

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Error-shape detail within the approved `session_not_found` response; no new
  endpoint behavior.
- **Objective:** Avoid a distinct error oracle for malformed versus unknown family ids.
- **Decision:** A malformed or non-ULID `:familyId` on `DELETE /v1/auth/cli/sessions/:familyId`
  returns `404 session_not_found`, the same as an unknown, foreign, or already-revoked family.
  The repository receives the raw path value only after the handler checks the CLI context; no
  SQL is built from it.
- **Evidence:** RD-04 lines 226-230 define 404 for a family that is not owned or has no live
  row; the route is a management surface for the caller's own families.
- **Rejected alternatives:** 400 `validation_error` (creates a malformed-id oracle and a
  different error for a path that is still safely a miss); 422 framework validation (breaks the
  contract's stable 4xx set).
- **Strongest counterargument:** A malformed id is a client bug and 400 is more descriptive.
- **Confidence:** High — the endpoint already treats every miss as 404.
- **Hardening:** Not challenger-required; direct consequence of AR-19 and AR-20.
- **Reopen triggers:** A general path-parameter validation policy is adopted for all routes.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-32 — Cleanup failure at startup

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Operational failure policy within the approved retention behavior.
- **Objective:** Keep cleanup best-effort while preserving authentication availability.
- **Decision:** A failed initial cleanup is logged with a stable code and is retried at the next
  24-hour interval. It does not fail server startup. Signing-key ensure remains fail-fast.
  `runOnce()` still rejects so tests and operators can observe the failure.
- **Evidence:** RD-04 lines 317-322 require the cleanup to run and be bounded; cleanup is
  maintenance, while signing-key availability is required to issue any credential.
- **Rejected alternatives:** Fail startup (a cleanup outage takes down authentication); skip
  later runs (retention silently stops); swallow the failure without a log (invisible).
- **Strongest counterargument:** A persistent cleanup failure can grow the table without bound.
- **Confidence:** High — availability and observability both remain.
- **Hardening:** The maintenance service logs at error level and tests cover the retry path.
- **Reopen triggers:** Retention becomes a compliance requirement with a hard startup gate.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-33 — Login/password-change serialization

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Concurrency mechanism within the approved password-change revocation rule.
- **Objective:** Ensure a CLI family can never be created from a password that a concurrent
  password change has already replaced.
- **Decision:** `CliSessionRepository.createFamilyForLogin` runs in a transaction, locks the
  `principals` row with `FOR UPDATE` (the same first lock as refresh and password change),
  re-reads the verified credential hash, and returns `credential_changed` without inserting when
  the hash differs. It inserts the family only while holding the lock. The browser path keeps
  its existing post-session recheck; the CLI path uses the lock-through-insert rule from RD-04.
- **Evidence:** RD-04 lines 137-139 explicitly allow "hold the per-principal lock through the
  insert"; a plain post-insert `SELECT` does not block on an uncommitted password update under
  PostgreSQL READ COMMITTED, so a password change could commit after its CLI revocation and
  leave a late-inserted family alive (`apps/server/src/auth/credentials.ts:235-252`,
  `apps/server/src/controllers/auth.ts:198-236`).
- **Rejected alternatives:** Post-insert re-read without a lock (race remains); application
  mutex (does not coordinate instances); ignoring the race (violates the accepted requirement).
- **Strongest counterargument:** The login request now serializes on the principal row, adding
  a short wait behind another login or password change.
- **Confidence:** High — the lock order is the same as refresh and password change.
- **Hardening:** Independent reasoning against PostgreSQL MVCC semantics; the fix is stronger
  than the minimum recheck.
- **Reopen triggers:** Password updates stop taking the principal lock; the database isolation
  policy changes.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-34 — Family delete serialization

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Concurrency mechanism within the approved family revocation behavior.
- **Objective:** A successful family delete must leave no live row even if a refresh races it.
- **Decision:** `revokeOwnedFamily` runs in a transaction, locks the `principals` row first, then
  updates every live row in the family with the ownership predicate. If no row is updated, it
  returns `session_not_found`. This uses the same lock order as refresh, logout, password change,
  and CLI login.
- **Evidence:** A single `UPDATE` without the principal lock can miss a replacement row inserted
  by a refresh that commits after the update's snapshot; RD-04 lines 226-230 require the delete
  to revoke every row in the family.
- **Rejected alternatives:** Single update without the lock (race leaves a live family); delete
  only the current row (leaves prior rows and contradicts family revocation); application mutex
  (does not coordinate instances).
- **Strongest counterargument:** The delete now waits behind an in-flight login or refresh for
  the same principal.
- **Confidence:** High — consistent with the existing lock order.
- **Hardening:** Concurrency test covers refresh/delete interleaving.
- **Reopen triggers:** Family revocation moves to a database trigger or a family table with its
  own lock.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

### AR-35 — Forced-change logout

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** Edge-case application of the approved forced-change gate and public logout.
- **Objective:** Keep logout available even when a CLI client sends its access token with the
  refresh token.
- **Decision:** The CLI branch of `passwordChangeGate` allows `POST /v1/auth/cli/logout` in
  addition to `GET /v1/auth/cli/me`. Logout still requires no bearer token and authorizes on the
  refresh token.
- **Evidence:** RD-04 lines 140-142 and 204-206 say logout remains available because it uses the
  refresh token; a present bearer context would otherwise trigger the gate before the handler.
- **Rejected alternatives:** Block a bearer-bearing logout while forced change is pending (breaks
  the "always available" behavior); ignore the bearer context globally (weakens the gate for
  data routes).
- **Strongest counterargument:** The RD's allowlist names only `/cli/me`.
- **Confidence:** High — the RD separately states logout is always available.
- **Hardening:** Test sends a valid bearer plus refresh token while `mustChangePassword` is true.
- **Reopen triggers:** Logout changes to require a bearer token.
- **Policy version:** 1
- **Root invocation ID:** `mp-rd04-20261101-0038`

## Gate Result

All 35 entries are resolved. The imported PF-001 through PF-012 decisions retain their original
user decisions. Every new plan-local technical decision carries delegated auto-design provenance;
no reserved product, scope, retention, or security-policy decision was decided by the AI.

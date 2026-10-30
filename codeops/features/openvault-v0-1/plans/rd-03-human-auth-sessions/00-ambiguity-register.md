# Ambiguity Register: RD-03 Human Authentication and Sessions

> **Status**: ✅ GATE PASSED — all 22 items resolved
> **Last Updated**: 2026-10-30 21:55
> **Policy**: auto-design active for eligible technical decisions; reserved decisions recorded from the preflight session

## Register

| # | Category | Ambiguity / Gap | Options Presented | Decision | Status |
|---|----------|-----------------|-------------------|----------|--------|
| AR-1 | Scope | Are the Should Have session list/revoke routes and last-login display in this plan? | Include / defer to RD-12 | Include list/revoke; return the current session's `createdAt` as `lastLoginAt`. User accepted all preflight recommendations. | ✅ Resolved |
| AR-2 | Technical | Which OIDC implementation? | Native fetch + jose / `openid-client` low-level / WebAFX controller | Use `openid-client` 6.8.8 directly with a timed fetch; no WebAFX controller. See delegated record. | ✅ Resolved |
| AR-3 | Technical | How is Argon2id provided? | Native package / Node built-in / pure JS | Raise the Node baseline to 24.7+ and use built-in `crypto.argon2`; no new native dependency. User decision (PF-002). | ✅ Resolved |
| AR-4 | Technical | What PHC format and parameters are stored? | PHC string / separate columns | PHC `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`, 16-byte salt, 32-byte tag; strict parser with bounds. See delegated record. | ✅ Resolved |
| AR-5 | Technical | How are public identifiers generated? | UUIDv4 / ULID / hash prefix | Add a small `newUlid()` to `@openvault/core`; use it for session public IDs and JIT principal IDs. See delegated record. | ✅ Resolved |
| AR-6 | Technical | Session expiry, rotation, and index semantics | Absolute / sliding; rotate CSRF or not; public ID | Absolute TTL from creation; rotate secret and CSRF; stable public ULID; in-process index. See delegated record. | ✅ Resolved |
| AR-7 | Technical | How is the 15-minute lockout window tracked without a schema change? | Add `last_failed_at` / use `updated_at` | Use `updated_at` as the last-failure anchor with an atomic `UPDATE … RETURNING`; no migration. See delegated record. | ✅ Resolved |
| AR-8 | Technical | Rate-limit order and keys | Lockout first / per-IP first; raw email / hashed key | Per-IP limiter first (5/min), then per-account limiter (10/h) keyed by SHA-256 of the normalized identifier. See delegated record. | ✅ Resolved |
| AR-9 | Technical | CSRF and Origin enforcement wiring | Global token check / session-scoped wrapper + origin guard / custom combined | WebAFX `csrfMiddleware` wrapped to run only with a session, plus a separate same-origin guard. See delegated record. | ✅ Resolved |
| AR-10 | Technical | OIDC state, nonce, and returnTo storage | Memory cache / signed cookies / provider state | Memory cache key `oidc:state:<sha256(state)>`, 600s TTL, atomic consume, strict returnTo. See delegated record. | ✅ Resolved |
| AR-11 | Security | OIDC linking and JIT policy | Email auto-link / `(issuer,subject)` / no JIT | Link only by `(issuer,subject)`; require `email_verified`; JIT only for an unused email; reject collisions. User decision (PF-003). | ✅ Resolved |
| AR-12 | Technical | API response contracts | Shared Zod / inline / raw rows | Shared Zod schemas in `@openvault/api-contract`; stable user shape. See delegated record. | ✅ Resolved |
| AR-13 | Technical | How to stop callback query leakage into logs | Pino hook / replace WebAFX logger / route middleware | Add a pino `hooks.logMethod` sanitizer and explicit redaction paths. See delegated record. | ✅ Resolved |
| AR-14 | Technical | Error codes for auth failures | Generic codes / distinct codes | `invalid_credentials` (401), `authentication_required` (401), `password_change_required` (403), `csrf_invalid` (403), `oidc_not_configured` (404), `oidc_callback_failed` (400), `oidc_unavailable` (503). See delegated record. | ✅ Resolved |
| AR-15 | Technical | How to test OIDC without an external IdP | Mock library / fake HTTPS IdP / live provider | A fake HTTPS IdP using `jose`, with a custom fetch that trusts the test CA. See delegated record. | ✅ Resolved |
| AR-16 | Scope | Who owns bootstrap provisioning? | RD-03 / RD-11+13 / move `ov init` | RD-03 owns the forced-change gate; RD-11/RD-13 own provisioning. User accepted recommendation. | ✅ Resolved |
| AR-17 | Security | Password-change policy and session behavior | Current password + length / no current / composition | Require current password; 12–1024 chars; no composition; revoke other sessions; rotate current. User decision (PF-006). | ✅ Resolved |
| AR-18 | Technical | Exact Node baseline and type package | 24.7.0 floor / installed 24.21.0 | Use Node 24.21.0 in `.nvmrc` and CI; `engines >=24.7.0`; `@types/node` 24.19.2. See delegated record. | ✅ Resolved |
| AR-19 | Technical | OIDC client authentication and scopes | Basic / POST / auto | `client_secret_basic`; scopes `openid profile email`; ID-token non-repudiation checks enabled. See delegated record. | ✅ Resolved |
| AR-20 | Technical | Session TTL config versus the 8-hour acceptance wording | Config / clamp | Use `OPENVAULT_SESSION_TTL_HOURS` (default 8, range 1–24); acceptance means the default. See delegated record. | ✅ Resolved |
| AR-21 | Technical | Last-login data source | Current session / new columns / RD-07 | Return the current session's `createdAt` as `lastLoginAt`. See delegated record. | ✅ Resolved |
| AR-22 | Technical | Multi-instance behavior | Shared store / document limitation | Document that sessions and rate limits are process-local in v0.1; no code change. See delegated record. | ✅ Resolved |

## Delegated Decisions

> **Authority:** AI — delegated by `--auto-design`
> **Policy version:** 1
> **Root invocation ID:** `rd-03-2026-10-30-2155`
> **Eligibility:** Each row is an implementation mechanism inside the approved RD-03 scope, security policy, and acceptance criteria. None expands product scope or changes reserved security policy; the reserved decisions are AR-3, AR-11, AR-16, and AR-17, recorded from explicit user choices.

### AR-2 — OIDC implementation

- **Objective:** Complete OIDC login without storing tokens and without hand-writing protocol-critical code.
- **Decision:** Add `openid-client@6.8.8`; use `discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`, and `fetchUserInfo` directly with a 5-second custom fetch. Do not use the WebAFX controller or its session store.
- **Evidence:** `blendsdk/webafx-auth` statically imports `openid-client` but does not declare it; its controller stores access/refresh/ID tokens. `openid-client` 6.8.8 is the maintained v6 line used by the SDK.
- **Rejected alternatives:** Native fetch + jose (larger custom protocol surface); WebAFX controller (token retention, refresh needs the token); adding a second OIDC framework (redundant).
- **Strongest counterargument:** Direct `openid-client` use still requires custom state/returnTo/error mapping. The library removes the signature, nonce, and PKCE risk, which is the larger surface.
- **Confidence:** High — the library is approved and the flow is covered by a fake-IdP integration test.
- **Hardening:** Independent design challenger selected `openid-client`; the timeout refinement (direct client, not the SDK provider) is recorded.
- **Reopen triggers:** `openid-client` drops Node 24 support; discovery cannot be bounded; the fake-IdP tests cannot cover nonce/state failure paths.

### AR-4 — Password hash format

- **Objective:** Store a self-describing Argon2id hash that verifies with the Node built-in API.
- **Decision:** PHC string `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>`, salt 16 bytes, tag 32 bytes, base64 without padding. The parser accepts only `argon2id`, version 19, `m=65536`, `t=3`, `p=1`, salt 16, tag 32.
- **Evidence:** `local_credentials.password_hash` checks `^\$argon2id\$`; Node 24.21 `crypto.argon2Sync` measured ~260 ms with these parameters.
- **Rejected alternatives:** Separate salt/parameter columns (schema change); accepting arbitrary parameters from the database (DoS via a malicious row).
- **Strongest counterargument:** Strict parameters prevent verifying a future rehash with different costs. A later rotation can widen the parser with an approved migration; v0.1 keeps one cost.
- **Confidence:** High.
- **Hardening:** Independent challenger rejected pure-JS Argon2 and the native package in favor of the Node built-in.
- **Reopen triggers:** Argon2 parameter policy changes; Node deprecates the API; a stored hash uses different parameters.

### AR-5 — Public identifiers

- **Objective:** Give sessions and JIT principals a public identifier without exposing a secret or adding a dependency.
- **Decision:** Add `newUlid(now = Date.now())` to `@openvault/core`, using the Crockford alphabet and `randomBytes` for the 80-bit randomness. Use it for session public IDs and JIT principal IDs.
- **Evidence:** `principals.id` and `session` records use ULID checks; the workspace has no ULID generator.
- **Rejected alternatives:** UUIDv4 (inconsistent with resource IDs); hash prefix (derived secret); external `ulid` package (new dependency for a small helper).
- **Strongest counterargument:** A new utility is slightly more code. It is 30 lines, tested, and needed by several later RDs.
- **Confidence:** High.
- **Hardening:** In-context review only; the helper is small and deterministic.
- **Reopen triggers:** ULID monotonicity becomes a requirement; the database switches identifier formats.

### AR-6 — Session lifecycle

- **Objective:** Deliver the RD's rotation, list/revoke, and invalidation behavior with the memory cache.
- **Decision:** Absolute expiry from `createdAt`; refresh rotates the secret and CSRF, keeps the public ID and expiry; `SessionService` maintains `principalId → publicIds` and `publicId → secretHash` indexes with a 60-second sweeper; `/me` checks the principal status in PostgreSQL on every request.
- **Evidence:** `webafx-cache` has no enumeration or atomic take; `get` + `delete` is not atomic across awaits. The cache TTL alone cannot support list/revoke.
- **Rejected alternatives:** Sliding expiry (extends stolen sessions); using the secret or hash as the public ID (credential leakage); adding a Postgres session table (out of AR-12 scope).
- **Strongest counterargument:** The index is process-local and lost on restart. That matches the accepted in-memory session model.
- **Confidence:** High.
- **Hardening:** Independent challenger selected the same model and required atomic consume.
- **Reopen triggers:** Multi-instance sessions become a requirement; the cache gains enumeration/take APIs.

### AR-7 — Lockout window

- **Objective:** Enforce five failures in 15 minutes without a schema migration.
- **Decision:** Use `updated_at` as the last-failure anchor. A single atomic `UPDATE … RETURNING` resets the count when `updated_at < now() - interval '15 minutes'`, otherwise increments it; when the new count is at least 5 it sets `locked_until = now() + interval '15 minutes'`. A successful login resets both fields.
- **Evidence:** `local_credentials` has `failed_count`, `locked_until`, and `updated_at`; no `last_failed_at`.
- **Rejected alternatives:** Add a column (migration); application-level read-modify-write (lost updates).
- **Strongest counterargument:** The inactivity window can over-lock a user who fails four times, waits 14 minutes, then fails once. Safe direction.
- **Confidence:** Medium — the approximation is deliberate and documented.
- **Hardening:** In-context review; the challenger accepted `updated_at`.
- **Reopen triggers:** Exact first-failure windows become a requirement; a migration is scheduled for another reason.

### AR-8 — Rate-limit order and keys

- **Objective:** Apply the accepted limits without a custom limiter.
- **Decision:** Two WebAFX `rateLimitMiddleware` instances: per-IP 5/60s first, per-account 10/3,600s second keyed by `sha256(normalizedIdentifier)`. The account limiter ignores malformed/missing identifiers.
- **Evidence:** WebAFX exports `rateLimitMiddleware`; it throws `RateLimitError` (429).
- **Rejected alternatives:** Custom composite limiter (new layer); lockout before the limiter (DB work before the DoS boundary).
- **Strongest counterargument:** The sixth same-IP attempt returns 429, so the lockout acceptance test uses a second IP or waits for the window.
- **Confidence:** High.
- **Hardening:** Independent challenger selected per-IP first.
- **Reopen triggers:** Distributed rate limiting becomes required; the login surface moves behind a shared gateway.

### AR-9 — CSRF and Origin

- **Objective:** Protect cookie-authenticated mutations without breaking future bearer/mTLS routes.
- **Decision:** Wrap WebAFX `csrfMiddleware` so it runs only when `req.auth` exists; add an origin guard for cookie-authenticated unsafe requests and the local login POST. Origin must equal `config.baseUrl.origin`; otherwise `Sec-Fetch-Site` must be `same-origin`; both absent is a rejection.
- **Evidence:** `csrfMiddleware` fails closed without an expected token; applying it globally would reject bearer/mTLS.
- **Rejected alternatives:** Global token check with a growing exemption list; custom constant-time compare.
- **Strongest counterargument:** Two middleware pieces instead of one. The boundary is clearer and future routes are safe by default.
- **Confidence:** High.
- **Hardening:** Independent challenger selected the wrapper.
- **Reopen triggers:** Non-browser clients need cookie auth; the UI uses a different origin.

### AR-10 — OIDC state and returnTo

- **Objective:** Make state single-use and prevent open redirects.
- **Decision:** Store `{codeVerifier, nonce, returnTo}` under `oidc:state:<sha256(state)>` in a memory cache with 600s TTL. Consume with an in-flight set so concurrent callbacks cannot both use one state. `returnTo` must start with `/`, contain no `//`, backslash, control character, or CRLF, resolve to the configured origin, and be at most 2048 characters.
- **Evidence:** Cache get/delete is not atomic; the RD requires 10-minute single-use state.
- **Rejected alternatives:** Signed cookies (exposes verifier, open-redirect risk); provider state store (token-storing controller).
- **Strongest counterargument:** Process-local state is lost on restart, consistent with memory sessions.
- **Confidence:** High.
- **Hardening:** Independent challenger selected the same model.
- **Reopen triggers:** Multi-instance OIDC state becomes required; a shared cache is introduced.

### AR-12 — API contracts

- **Objective:** Keep the server, tests, and RD-12 UI aligned.
- **Decision:** Add strict Zod schemas to `@openvault/api-contract`: login request, password change, auth user, session response (`user`, `expiresAt`, `csrfToken`, `mustChangePassword`, `lastLoginAt`), refresh response (`expiresAt`, `csrfToken`), session list/entry, and meta auth. Use ISO timestamps and ULIDs.
- **Evidence:** `@openvault/api-contract` already exists and the server depends on it; RD-12 consumes `/me`.
- **Rejected alternatives:** Inline shapes (drift); raw rows (secret leakage).
- **Strongest counterargument:** Over-constrains the contract before RD-12. Keep the user shape minimal.
- **Confidence:** High.
- **Hardening:** Independent challenger selected shared schemas.
- **Reopen triggers:** RD-12 needs additional fields; roles/capabilities move into the user shape.

### AR-13 — Log sanitizer

- **Objective:** Keep OIDC code/state and auth secrets out of access logs.
- **Decision:** Add a pino `hooks.logMethod` sanitizer that strips query strings from request-log message strings and from a shallow `url` property; add explicit redaction paths for auth fields.
- **Evidence:** WebAFX logs `req.originalUrl` at info level; the callback query carries `code` and `state`.
- **Rejected alternatives:** Replacing WebAFX logging (fragile); per-route suppression (incomplete).
- **Strongest counterargument:** Sanitizing messages is a string-level control; tests must cover both message and object paths.
- **Confidence:** High.
- **Hardening:** Independent challenger flagged the leak as required.
- **Reopen triggers:** WebAFX changes its request-log shape; a new auth route puts secrets in a path.

### AR-14 — Error codes

- **Objective:** Return stable, non-enumerating auth errors.
- **Decision:** Use the codes in the register table; local failures always use `invalid_credentials` with the same body.
- **Evidence:** WebAFX `ApiError` and `csrfMiddleware` use stable codes; the UI needs stable branches.
- **Rejected alternatives:** Distinct unknown/locked codes (enumeration); framework default codes for every case (unstable).
- **Strongest counterargument:** More codes to document. The set is small and explicit.
- **Confidence:** High.
- **Hardening:** In-context review only.
- **Reopen triggers:** The UI needs a different error taxonomy.

### AR-15 — OIDC test harness

- **Objective:** Test the real OIDC flow without an external provider.
- **Decision:** Add a fake HTTPS IdP helper using `node:https` and `jose`; it serves discovery, JWKS, token, and UserInfo endpoints and validates PKCE/nonce. The `OidcService` accepts an optional `fetch` implementation so tests can trust the fixture CA.
- **Evidence:** Config requires HTTPS issuers; the test fixtures already generate a CA and server certificate.
- **Rejected alternatives:** Mocking `openid-client` (does not prove the flow); a live provider (external dependency, non-deterministic).
- **Strongest counterargument:** A fake IdP is test-only machinery. It directly proves the accepted security behavior and reuses the existing TLS fixtures.
- **Confidence:** High.
- **Hardening:** In-context review; the harness is bounded and test-only.
- **Reopen triggers:** The fake IdP diverges from the provider metadata the production client needs.

### AR-18 — Node baseline

- **Objective:** Use the built-in Argon2 without a native dependency.
- **Decision:** `.nvmrc` 24.21.0; CI Node 24.21.0; `engines.node >=24.7.0`; `@types/node` 24.19.2 in the root and server.
- **Evidence:** Node 24.21.0 is installed; `crypto.argon2` was added in 24.7.0 and measured ~260 ms at the required parameters.
- **Rejected alternatives:** Node 24.7.0 exact (older than the installed runtime); keeping Node 22 and adding a native package (user rejected).
- **Strongest counterargument:** A platform-wide baseline change affects CI, docs, and future deployment images. It is explicit and approved.
- **Confidence:** High.
- **Hardening:** User decision on PF-002.
- **Reopen triggers:** A dependency requires Node >24; the project moves to Node 26.

### AR-19 — OIDC client details

- **Objective:** Use standards-compliant client authentication and scopes.
- **Decision:** `client_secret_basic`; scopes `openid profile email`; `enableNonRepudiationChecks` for ID-token signatures; discovery issuer must exactly match the configured issuer; discovery cache 1 hour.
- **Evidence:** `openid-client` defaults to client secret basic; the RD requires the three scopes and ID-token verification.
- **Rejected alternatives:** `client_secret_post` (less standard); disabling signature checks (unsafe).
- **Strongest counterargument:** Some providers prefer POST. The configured provider must support the standard basic method; a later config option can add POST if needed.
- **Confidence:** Medium — provider compatibility is verified by the fake IdP, not a real provider.
- **Hardening:** In-context review.
- **Reopen triggers:** A target provider rejects `client_secret_basic`.

### AR-20 — Session TTL

- **Objective:** Reconcile the 8-hour acceptance wording with the RD-02 config.
- **Decision:** Use `config.sessionTtlHours` (default 8, range 1–24); the acceptance criterion means the default.
- **Evidence:** `loader.ts:303`; `types.ts:53`.
- **Rejected alternatives:** Clamp to 8 (misleading config).
- **Strongest counterargument:** An operator can choose 24 hours. The RD now documents the range.
- **Confidence:** High.
- **Hardening:** In-context review.
- **Reopen triggers:** The accepted maximum changes.

### AR-21 — Last login

- **Objective:** Satisfy the Should Have without a schema change.
- **Decision:** Return `lastLoginAt = new Date(session.createdAt).toISOString()` and `user.authMethod`.
- **Evidence:** Sessions store `createdAt`; RD-07 audit is not implemented yet.
- **Rejected alternatives:** New columns (migration, duplicates audit); defer (drops the Should Have).
- **Strongest counterargument:** It is the current login, not the previous one. Acceptable for v0.1; RD-07 can add history later.
- **Confidence:** High.
- **Hardening:** In-context review.
- **Reopen triggers:** RD-07 provides a last-login projection.

### AR-22 — Multi-instance limitation

- **Objective:** Be explicit about process-local state.
- **Decision:** Document that sessions, OIDC state, lockout/rate-limit counters, and the session index are per process in v0.1; the reference stack runs one server.
- **Evidence:** Memory cache and WebAFX limiter are process-local.
- **Rejected alternatives:** Add Redis now (out of AR-12 scope).
- **Strongest counterargument:** A future HA deployment will need a shared store. The limitation is documented.
- **Confidence:** High.
- **Hardening:** In-context review.
- **Reopen triggers:** A multi-instance deployment is approved.

## Resolution Notes

- **Reserved decisions:** AR-3 (Node baseline), AR-11 (OIDC linking), AR-16 (bootstrap ownership), and AR-17 (password policy) were decided explicitly by the user during the RD-03 preflight.
- **Delegated decisions:** AR-2, AR-4–AR-10, AR-12–AR-15, and AR-18–AR-22 were resolved under `--auto-design` within the approved scope and acceptance criteria.
- **No deferred rows:** Every decision is resolved; none is deferred.

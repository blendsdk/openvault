# Preflight Report: RD-04 CLI Authentication

> **Status**: ✅ PASSED — all 12 findings resolved; re-scan complete
> **Iteration**: 2 (re-scan after accepted fixes)
> **Previous Iteration**: 12 findings — all resolved
> **This Iteration**: 0 new findings
> **Artifact**: Single requirement document at `codeops/features/openvault-v0-1/requirements/RD-04-cli-auth.md`
> **Artifact Ref**: `a7e1d29d0fb1feabc18d5c103d5b5ca08d6a0723`
> **Codebase Grounded**: 24 source, test, schema, and configuration files examined; 14 references verified, 0 unverifiable
> **Scope**: Strict. Audit target is RD-04 only; RD-03, RD-11, the requirements ambiguity register, architecture docs, and server code are context.
> **Last Updated**: 2026-10-31 13:03
> **Same-Agent Review**: The artifact was authored in an earlier session; this review is independent of its creation.

## Codebase Context Summary

**Tech Stack:** pnpm workspace, TypeScript, Node.js >= 24.7, Express 5 through BlendSDK WebAFX, PostgreSQL, Vitest, `jose@6.2.13`.

**Architecture:** The monorepo contains `apps/server`, `apps/web`, `packages/core`, `packages/api-contract`, and `packages/test-support`. There is no `apps/cli` package. The server has typed configuration, HTTPS/mTLS listeners, browser authentication and sessions, a PostgreSQL credential repository, a symmetric-KEK keyring, and readiness probes. Browser sessions use an opaque `__Host-ov_session` cookie plus CSRF; there is no bearer-token authentication path.

**Key Files Examined:**

- `apps/server/migrations/20261030094203_initial.up.sql`, `apps/server/src/database/schema.ts`
- `apps/server/src/auth/credentials.ts`, `password.ts`, `middleware.ts`, `csrf.ts`, `plugin.ts`, `types.ts`
- `apps/server/src/controllers/auth.ts`
- `apps/server/src/security/keyring.ts`, `apps/server/src/security/clock.ts`
- `packages/core/src/keyring.ts`, `packages/core/src/crypto.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/src/app.ts`
- `apps/server/src/auth/oidc/identity.ts`
- `packages/api-contract/src/auth.ts`
- `codeops/features/openvault-v0-1/requirements/RD-03-human-auth-sessions.md`
- `codeops/features/openvault-v0-1/requirements/RD-11-cli.md`
- `codeops/features/openvault-v0-1/requirements/RD-01-foundation-data-build.md`
- `codeops/features/openvault-v0-1/requirements/00-ambiguity-register.md`
- `docs/architecture/identity.md`, `docs/architecture/crypto.md`, `docs/architecture/overview.md`, `docs/reference/api.md`

**Key Observations:**

- `cli_sessions` already exists with `id`, `principal_id`, `refresh_hash` (unique, 32 bytes), `family_id`, `expires_at`, `revoked_at`, `created_at`, `ip`, and `user_agent`; indexes cover `principal_id` and `family_id`. There is no `rotated_at` or `replaced_by_id`.
- The local credential verifier, lockout counters, generic failure, and dummy verification already exist and are used by browser login.
- The keyring stores only 32-byte symmetric AES KEKs; `KeyringProvider` exposes status, not key material. There is no signing-key table, JWT signer, or Ed25519 key lifecycle.
- `jose` is already installed, so JWT signing/verification does not require a new dependency.
- `PostgreSQLDatabase.withTransaction`, `newUlid()`, and `CLOCK_SKEW_SECONDS` are available.
- The browser auth guards assume `req.auth` is a browser session; a CLI bearer context would need a discriminated type and browser-only CSRF/Origin checks.
- `docs/architecture/overview.md` lists `apps/cli`, and `RD-01` says it is created by RD-11; no such package exists yet.

**Reference Verification:** 14 references mapped to code or documents, all verified. The only expected absence is the `apps/cli` package, which RD-01 assigns to RD-11.

## Summary by Dimension

| # | Dimension | Findings | Highest Severity |
|---|-----------|----------|------------------|
| 1 | Ambiguities | 1 | 🟠 MAJOR |
| 2 | Implicit Assumptions | 0 | — |
| 3 | Logical Contradictions | 0 | — |
| 4 | Completeness Gaps | 4 | 🟠 MAJOR |
| 5 | Dependency Issues | 0 | — |
| 6 | Feasibility Concerns | 1 | 🟠 MAJOR |
| 7 | Testability | 0 | — |
| 8 | Security Blind Spots | 2 | 🟠 MAJOR |
| 9 | Edge Cases | 2 | 🟠 MAJOR |
| 10 | Scope Creep Indicators | 0 | — |
| 11 | Ordering & Sequencing | 0 | — |
| 12 | Consistency | 1 | 🟡 MINOR |
| 13 | Codebase Alignment | 1 | 🟠 MAJOR |

Counts use each finding's primary dimension. Findings PF-001, PF-002, PF-003, PF-004, and PF-005 also touch the related dimensions named in their entries.

## Summary by Severity

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | — |
| MAJOR | 7 | All resolved |
| MINOR | 5 | All resolved |
| OBSERVATION | 0 | — |

## Independent Challenge

One independent design challenger reviewed the complete MAJOR batch (PF-001 through PF-007) with the codebase context and without the parent's picks. It converged on Option A for every major finding and added these refinements:

- split server-side log redaction from the CLI file/argv obligations;
- use the existing `audit_keys` wrapped-key pattern for signing keys, with a partial unique index for current/previous;
- add a discriminated browser/CLI authentication context so the existing CSRF and Origin guards do not reject bearer requests;
- share the rate-limit limiter instances so "same limits as RD-03" is true across both login surfaces;
- add a partial unique index on `cli_sessions (family_id) WHERE revoked_at IS NULL` as a rotation backstop;
- use explicit `accessExpiresAt` and `refreshExpiresAt` fields in the token response.

`Confidence:` High. `Hardening:` Challenger converged; no recommendation changed.

## Re-scan (Iteration 2)

The accepted fixes were applied to RD-04, RD-11, and the affected docs. This iteration checked each fixed section and its direct consequences. No new findings were introduced.

| Finding | Applied change | Verification |
|---|---|---|
| PF-001 | RD-04 is server-only; the credential-file contract moved to RD-11 `Credential storage`, with path precedence, `0700`/`0600`, atomic write, symlink rejection, locking, Windows ACL, schema, logout, and no-argv/log rules. Docs updated. | RD-04 `Won't Have` and acceptance 15; RD-11 section and acceptance 6. |
| PF-002 | RD-04 adds `signing_keys`, KEK wrapping, current/previous/retired lifecycle, startup ensure, init idempotence, rotation overlap guard, and RD-13 re-wrap. | RD-04 `JWT signing keys` and acceptance 9; `docs/architecture/crypto.md` aligned. |
| PF-003 | RD-04 adds bearer verification, `sid = family_id`, principal plus live-family check, `/cli/me`, discriminated auth context, browser-only CSRF/Origin guards, and no cookie fallback. | RD-04 `Access-token authentication` and acceptance 5, 6, 8. |
| PF-004 | RD-04 requires the shared local-login service and shared per-IP/per-account limiter instances, including lockout, generic failure, and dummy verification. | RD-04 `Local CLI login` and acceptance 10. |
| PF-005 | RD-04 requires absolute 12-hour family expiry, principal and row locking, partial unique index, reuse revocation, and CLI refresh serialization. | RD-04 `Refresh and rotation` and acceptance 3, 4. |
| PF-006 | RD-04 revokes every CLI family in the password-change transaction and uses the same per-principal lock as refresh. | RD-04 acceptance 7 and `Security Considerations`. |
| PF-007 | RD-04 defines shared Zod CLI schemas, base64url tokens, explicit access/refresh expiries, stable errors, and idempotent logout; docs list the contract. | RD-04 `API contracts` and acceptance 11; `docs/reference/api.md`. |
| PF-008 | RD-04 adds family-level CLI session list/revoke; RD-11 adds `ov auth sessions`. | RD-04 `CLI session store` and acceptance 12; RD-11 command table and acceptance 11. |
| PF-009 | RD-04 adds 60/minute per IP and 30/minute per family refresh limits, enforced after family lookup. | RD-04 `Rate limits` and acceptance 13. |
| PF-010 | RD-04 adds 30-day retention, cleanup indexes, and a daily idempotent cleanup. | RD-04 `Retention and cleanup` and acceptance 14. |
| PF-011 | RD-04 keeps the minimal claim set and loads roles/permissions from the database; `docs/architecture/identity.md` now shows the minimal claims. | RD-04 `Claims` and acceptance 1, 16; identity docs. |
| PF-012 | RD-04 adds `req.body.accessToken` and `req.body.refreshToken` redaction and a captured-log test. | RD-04 `Logging and redaction` and acceptance 15. |

Direct consequences checked during this iteration: the per-principal lock order avoids a password-change/refresh deadlock, the signing-key rotation guard prevents retiring a key still inside its overlap window, `iat` and `exp` both use the shared 30-second skew, and the CLI session route parameter is consistently `:familyId`.

---

## Findings

### PF-001: CLI credential-file ownership contradicts the RD-11 dependency order [🟠 MAJOR]

**Dimension:** 4 — Completeness Gaps (related: 5 Dependency Issues, 11 Ordering & Sequencing, 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:30, 81-84, 124-125`; `RD-11-cli.md:7, 21, 31, 141`
**Codebase Evidence:** No `apps/cli` package exists. `apps/` contains `server` and `web`; `RD-01-foundation-data-build.md:21` says `apps/cli` is created by RD-11; `RD-11-cli.md:7` makes RD-11 depend on RD-04. `docs/architecture/overview.md:25` lists the package as if it exists.

**The Problem:** RD-04 requires the CLI to write `~/.config/openvault/credentials.json` with mode `0600`, requires `ov logout` to remove it, and makes acceptance criteria 7 and 8 depend on a CLI executable and its argv/log behavior. The CLI and `ov logout` belong to RD-11, which cannot start until RD-04 is finished. RD-04 therefore cannot satisfy its own acceptance criteria without building part of RD-11, and RD-11 would repeat the same work. The file path, schema, atomic-write contract, directory permissions, symlink handling, concurrent-process behavior, and Windows permission semantics are also unspecified. On Windows, `chmod 0600` does not enforce an ACL, so the stated permission guarantee is not portable as written.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Move CLI credential-file storage, `ov logout` removal, and argv/local-log acceptance to RD-11. RD-04 keeps server-side token issuance and server-log redaction, and adds a cross-RD integration test. | Removes the circular dependency; keeps RD-04 focused on server authentication; puts file behavior where the CLI is built. | Leaves token-at-rest behavior unproven until RD-11; RD-11 must carry a complete file-security contract. |
| B | Create a minimal `apps/cli` auth foundation in RD-04 (login/logout/whoami plus credential store). | Proves the full client flow in RD-04. | Pulls RD-11 work forward, adds a new app package, and duplicates RD-11 ownership; large scope increase. |
| C | Add a shared `packages/cli-credentials` store in RD-04; RD-11 wires commands. | Independently testable file-security contract without a full CLI. | Adds a single-consumer package; `ov logout` and argv acceptance still belong to RD-11. |

**Recommendation:** Option A. Move the CLI file and argv/log acceptance to RD-11, and specify there: path precedence (`$XDG_CONFIG_HOME`, macOS Application Support, `%APPDATA%`), `0700` directory and `0600` file, symlink rejection with `O_NOFOLLOW`/`lstat`, temp-file plus `fsync` plus atomic rename, a lock file for concurrent login/logout, a versioned JSON schema, fail-closed handling of corrupt or loose files, Windows ACL behavior, and logout ordering/offline behavior. RD-04 should still add the missing nested request-body redaction paths and retain a server-log acceptance test; that part is a server obligation.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-002: JWT signing-key storage, initialization, and rotation are not implementable with the current keyring [🟠 MAJOR]

**Dimension:** 6 — Feasibility Concerns (related: 2 Implicit Assumptions, 5 Dependency Issues, 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:33-34, 53-56`
**Codebase Evidence:** `packages/core/src/keyring.ts:22, 34, 105-115` accepts only 32-byte symmetric keys; `apps/server/src/security/keyring.ts:86-103` exposes status only, not key material. No signing-key table exists in `apps/server/migrations/20261030094203_initial.up.sql`. `packages/core/src/crypto.ts:79-115` wraps 32-byte values with AES-GCM and an AAD of project/object/version. `docs/architecture/crypto.md:5-13, 51-56` says the KEK wraps the JWT signing key and KEK rotation re-wraps it. `ov init` is RD-11/RD-13.

**The Problem:** The requirement names the right key properties but not where the Ed25519 key lives, how it is wrapped, how the server accesses key material, or how two active keys are activated and retired. The current keyring is an AES-KEK store, and its server wrapper deliberately hides key bytes. "Generated at init" also depends on `ov init`, which is deferred. Without a concrete key store, the JWT signer cannot be built; without rotation semantics, old tokens may stop verifying during a key change.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add a dedicated `signing_keys` table (`kid`, public key, wrapped Ed25519 seed, `kek_id`, status, timestamps) and a small signer service. Ensure the first key idempotently at startup under an advisory lock (and from `ov init` when available); sign with `current`, verify with `current` and `previous`; retire `previous` after the access-token lifetime plus clock skew. | Explicit lifecycle; supports two active keys; uses the existing wrapped-key pattern (`audit_keys`); can be re-wrapped by RD-13. | Requires a migration, a repository, and a signer service. |
| B | Store the Ed25519 seed as another entry in the keyring JSON and use `keyring.withKey` to sign. | No migration or database table. | The keyring file already holds the KEK, so the seed would sit beside the KEK rather than be wrapped by it; the single `current` pointer cannot model two active signing keys; rotation is manual. |
| C | Derive the Ed25519 seed deterministically from the current KEK (for example with HKDF). | No new storage. | KEK rotation invalidates the signing key; two active keys are impossible; a KEK compromise compromises signing. |

**Recommendation:** Option A. Follow the `audit_keys` pattern: store the public key in clear, wrap the 32-byte Ed25519 seed with the current KEK, and keep `current`/`previous`/`retired` states with a partial unique index allowing at most one current and one previous key. Sign with `current`, verify with both, and retire a previous key only after the maximum access-token lifetime plus 30-second clock skew. Add an acceptance test that signs with the previous key during overlap and verifies it. Include signing keys in the RD-13 KEK re-wrap.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-003: Access-token verification and CLI revocation semantics are missing [🟠 MAJOR]

**Dimension:** 13 — Codebase Alignment (related: 1 Ambiguities, 4 Completeness Gaps, 8 Security Blind Spots)
**Location:** `RD-04-cli-auth.md:22-23, 26-29, 32, 57-70, 77`
**Codebase Evidence:** `apps/server/src/auth/plugin.ts:99-102` installs only browser session middleware; `apps/server/src/auth/middleware.ts:34-77` resolves only a session cookie; `apps/server/src/auth/types.ts:46-53` makes `session` mandatory in `AuthContext`; `apps/server/src/auth/csrf.ts:43-46, 79-94` treats any `req.auth` as a browser session and would require CSRF/Origin on a CLI POST. `apps/server/src/app.ts:80-83` registers no CLI routes.

**The Problem:** RD-04 issues a JWT but never defines who verifies it, which routes accept it, or what `sid` means. The database has both `cli_sessions.id` (one refresh row) and `family_id`; choosing one changes whether logout and rotation invalidate an access token immediately or only after 15 minutes. Acceptance criterion 6 requires a disabled principal's next access-token request to fail within 5 seconds, but there is no protected CLI request path to test. The requirement also omits algorithm pinning (`EdDSA` only), issuer/audience validation, clock-skew tolerance, and the interaction with the existing browser CSRF/Origin guards.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add bearer middleware and `GET /v1/auth/cli/me`. Set `sid` to `family_id`; verify signature, `EdDSA`, `iss`, `aud`, and `exp` with 30-second skew; require `kind: "user"`; check that the principal is active and the family has a non-revoked, unexpired row. Introduce a discriminated browser/CLI auth context and make the CSRF/Origin guards browser-only. | Makes disable, logout, and family revocation effective immediately; gives RD-11 a `whoami` endpoint; fits the existing per-request status check. | Adds a DB check per request and a small auth-context refactor. |
| B | Add bearer middleware, but check only principal status; set `sid` to `family_id`. | Simpler; meets the literal 5-second disable requirement. | Logout and family revocation leave the access token valid for up to 15 minutes. |
| C | Defer access-token verification to RD-06/RD-11; RD-04 only issues tokens. | Smallest RD-04 change. | Acceptance 6 is untestable; the access token has no protected consumer; security guarantee is unenforced. |
| D | Set `sid` to the current `cli_sessions.id` row and check that row is not revoked. | Access tokens die on refresh/logout. | `sid` changes on every refresh; old access tokens die before their 15-minute lifetime; breaks the stable-public-id pattern. |

**Recommendation:** Option A. Use `sid = family_id`. Add a `cliAuthMiddleware` that verifies the token, checks the principal status and an active family row in one query, and attaches a discriminated `AuthContext` (`browser` or `cli`). Make `requireSession` browser-only and add `requirePrincipal`; update `originGuard` and `csrfGuard` to apply only when `req.auth.kind === "browser"`. Add `GET /v1/auth/cli/me` for the CLI and for acceptance testing. A valid bearer must win over a cookie, and an invalid bearer must not fall back to a cookie. Carry `mustChangePassword` so the existing forced-change gate still applies to CLI data routes.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-004: CLI login can bypass the RD-03 account lockout [🟠 MAJOR]

**Dimension:** 8 — Security Blind Spots (related: 3 Logical Contradictions, 9 Edge Cases, 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:31, 88`
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:77-94` creates the login rate limiters; `:110-143` performs the lockout check, dummy verification, failure counter, and success reset. `apps/server/src/auth/credentials.ts:170-221` owns the atomic failure/success updates. `apps/server/src/auth/password.ts:117-140` owns verification and dummy verification.

**The Problem:** RD-04 says CLI login uses the same rate limits and that RD-03 supplies the verifier and lockout state, but it does not require CLI login to apply the 5-failure/15-minute lockout, generic failure body, or dummy verification. A CLI controller that only calls `verifyPassword` would leave `failed_count` and `locked_until` untouched, so an attacker could use `/v1/auth/cli/login` as a second door around the browser lockout. Creating a second `rateLimitMiddleware` instance would also create separate in-memory buckets, so "same limits" would not be true even if the numbers match.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Extract the local-login flow into a shared `LocalLoginService` used by browser and CLI controllers. Share the per-IP and per-account limiter instances (or a shared store). | One lockout policy; no drift; same buckets; preserves dummy verification and generic errors. | Small refactor of a security-critical path. |
| B | Duplicate the existing `CredentialsRepository`/`verifyPassword` flow in the CLI controller. | No refactor. | Security logic duplicated; future changes can diverge. |
| C | Apply only the rate limits to CLI login; do not use the account lockout. | Simpler CLI endpoint. | Lockout bypass; inconsistent policy; weaker than RD-03. |

**Recommendation:** Option A. Move normalization, lookup, disabled/locked checks, policy-hash check, dummy verification, password verification, failure/success counters, and the post-success hash CAS recheck into `LocalLoginService`; controllers own only session/token issuance. Export one per-IP limiter and one per-account limiter for both login routes, or use a shared limiter store. Add tests that a CLI failure locks the browser login and vice versa, and that the per-account bucket is shared.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-005: Refresh rotation has no atomic concurrency model, and the 12-hour family lifetime is undefined [🟠 MAJOR]

**Dimension:** 9 — Edge Cases (related: 3 Logical Contradictions, 8 Security Blind Spots, 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:24-27, 72-77`
**Codebase Evidence:** `apps/server/migrations/20261030094203_initial.up.sql:77-87` defines `cli_sessions` with `family_id`, unique `refresh_hash`, `expires_at`, and `revoked_at`, but no `rotated_at`; indexes at `:364-365` cover principal and family. `PostgreSQLDatabase.withTransaction` is already used in `apps/server/src/auth/oidc/identity.ts:134`.

**The Problem:** Two concurrent refresh requests with the same token can both read the row as valid and insert two new rows, forking the family; the unique `refresh_hash` does not prevent this. The requirement also does not say whether the 12-hour refresh lifetime is absolute from login or resets on every rotation. A sliding lifetime lets a stolen token extend indefinitely; an absolute lifetime forces re-login every 12 hours. The table has no explicit rotation marker, so using `revoked_at` for both rotation and logout conflates the states unless the audit log records the distinction.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Absolute 12-hour family lifetime from login. One transaction locks the refresh row with `SELECT … FOR UPDATE`; a revoked row revokes the whole family; otherwise set the old `revoked_at = now()` and insert the new row with the family's original `expires_at`. Add a partial unique index on `family_id` where `revoked_at IS NULL` as a backstop. | Atomic; bounded maximum lifetime; no new column; second waiter sees the revocation and triggers reuse detection. | A lost refresh response looks like reuse and revokes the family; the CLI must serialize refresh and treat 401 as re-login. |
| B | Sliding 12-hour lifetime per refresh. Use a conditional `UPDATE … WHERE refresh_hash = :hash AND revoked_at IS NULL AND expires_at > now() RETURNING …`, then insert in the same transaction. | Atomic and more usable; no explicit lock. | A stolen token can extend indefinitely; family lifetime is unbounded. |
| C | Absolute lifetime plus explicit `rotated_at`/`replaced_by_id` columns and a transaction. | Rotation and logout are distinguishable for audit. | Migration and more state; RD-07 can record the distinction in the audit event instead. |

**Recommendation:** Option A. Use an absolute 12-hour family expiry from login, `SELECT … FOR UPDATE` on the refresh hash, set the old row's `revoked_at`, insert the new row with the original `expires_at`, and revoke the whole family on reuse. Add the partial unique index `UNIQUE (family_id) WHERE revoked_at IS NULL`. Record old and new row ids plus the action in the RD-07 audit event rather than adding rotation columns. Document that the CLI must serialize refresh per credentials file and treat a 401 as re-login.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-006: Password change does not revoke CLI token families [🟠 MAJOR]

**Dimension:** 4 — Completeness Gaps (related: 8 Security Blind Spots, 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:32, 77`; compare `RD-03-human-auth-sessions.md:113-115`
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:199-220` changes the password and revokes every other browser session; it does not touch `cli_sessions`. There is no CLI repository or revocation call.

**The Problem:** A stolen CLI refresh token survives the exact action a victim takes to evict an attacker. RD-03 revokes other browser sessions on password change, but RD-04 only requires principal disable to revoke CLI families. The asymmetry leaves a 12-hour window after a password change.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | In the same transaction as the password-hash CAS, revoke all non-revoked CLI families for the principal. | Closes the window; symmetric with browser sessions; with PF-003 A it also invalidates outstanding access tokens immediately. | Signs out CLI automation the user did not explicitly target. |
| B | Revoke CLI families asynchronously after the password change. | Shorter critical section. | Leaves a short window; more moving parts. |
| C | Do not revoke CLI families on password change; document the risk. | No change. | Stolen token survives; inconsistent with browser behavior. |

**Recommendation:** Option A. Wrap `CredentialsRepository.changePassword` and the CLI-family revocation in one transaction. Add an acceptance test: after a password change, the old refresh token and old access token return 401, and a fresh CLI login with the new password succeeds.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-007: CLI token API contracts, token encoding, and error codes are unspecified [🟠 MAJOR]

**Dimension:** 1 — Ambiguities (related: 4 Completeness Gaps, 7 Testability, 12 Consistency)
**Location:** `RD-04-cli-auth.md:20-34, 49-70, 114-127`
**Codebase Evidence:** `packages/api-contract/src/auth.ts:10-118` contains browser schemas only; the browser response has `csrfToken` and no access/refresh tokens. `RD-11-cli.md:34,145` requires a generated API client and `pnpm api:check`.

**The Problem:** The paths are defined, but the request/response bodies are not. The refresh token's wire encoding (base64url or hex), the login/refresh response fields, the logout input and idempotency, and the stable error codes are all unspecified. `@openvault/api-contract` has no CLI schemas, so the server, CLI, and tests will guess. The CLI cannot tell whether `expiresAt` refers to the 15-minute access token or the 12-hour refresh token.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add strict Zod schemas to `@openvault/api-contract`: login request (reuse the existing schema), login/refresh response with `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `accessExpiresAt`, `refreshExpiresAt`, `user`, `mustChangePassword`; refresh request `{ refreshToken }`; logout request; `cliMeResponseSchema`; stable error codes. Use base64url and make logout idempotent with 204. | One contract for server, CLI, and tests; supports RD-11's generated client; removes expiry ambiguity. | More schemas and tests. |
| B | Define inline server types and response shapes. | Less upfront work. | Drift; no generated client; RD-11 `api:check` cannot help. |
| C | Reuse the existing browser auth schemas and add token fields. | Reuses some shapes. | Browser and CLI contracts differ; `csrfToken` and token fields do not fit. |

**Recommendation:** Option A. Add `packages/api-contract/src/cli-auth.ts` and export it. Use `loginRequestSchema` for the login body; define `cliRefreshTokenSchema` as 43-character base64url; one token response schema for login and refresh with explicit `accessExpiresAt` and `refreshExpiresAt`; `cliRefreshRequestSchema` and `cliLogoutRequestSchema` with `{ refreshToken }`; `cliMeResponseSchema` with `user` and `mustChangePassword`. Hash the canonical 43-character ASCII token with SHA-256 for `refresh_hash`. Use stable errors: 401 `invalid_credentials`, 401 `invalid_refresh_token`, 401 `authentication_required`, 400 `validation_error`, 429 `RATE_LIMIT_EXCEEDED`. Logout returns 204 for any well-formed token, including an already-revoked one.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-008: CLI session list/revoke has no server API and the command name conflicts [🟡 MINOR]

**Dimension:** 4 — Completeness Gaps (related: 7 Testability, 12 Consistency)
**Location:** `RD-04-cli-auth.md:36-39`; `RD-11-cli.md:54-57, 138-141`
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:285-314` implements browser session list/revoke only. There is no CLI session route. `docs/reference/api.md:69-71` lists CLI login/refresh/logout but no CLI sessions endpoint.

**The Problem:** The Should Have says `ov sessions` lists and revokes CLI sessions, but no server endpoint or family-level listing model exists. Listing `cli_sessions` rows would show every refresh as a separate "session"; the user-facing unit should be the family. RD-11's command table says `ov auth sessions`, not `ov sessions`.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add `GET /v1/auth/cli/sessions` and `DELETE /v1/auth/cli/sessions/:familyId` in RD-04; list families with created/expires/current and never expose hashes; RD-11 exposes `ov auth sessions`. | Satisfies the Should Have; gives users a revocation surface; aligns with RD-11. | Two more endpoints and repository methods. |
| B | Drop the Should Have from RD-04 and add it to RD-11 with the endpoints. | Keeps RD-04 focused. | Loses the capability from v0.1 unless RD-11 adds it. |
| C | Rely on `ov logout` only; no list/revoke. | Smallest. | Drops the Should Have; no way to revoke a specific family. |

**Recommendation:** Option A. Keep the server endpoints in RD-04 (they are auth-server capabilities) and let RD-11 expose the command as `ov auth sessions`; update the RD-04 wording to say the server supports list/revoke for CLI families.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-009: Refresh rate-limit values are missing [🟡 MINOR]

**Dimension:** 4 — Completeness Gaps (related: 7 Testability)
**Location:** `RD-04-cli-auth.md:31, 111`
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:77-94` defines login and password-change limits; there is no refresh limiter. RD-04's security considerations mention "login and refresh limits" but the functional requirements only give login numbers.

**The Problem:** A technical requirement says refresh is rate limited, but no values or keys are defined, so the behavior is untestable and the implementation may omit it.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Use 60/min per IP and 30/min per family, with 429 `RATE_LIMIT_EXCEEDED`, using the same limiter instances as login where applicable. | Concrete, testable, aligned with the existing middleware. | Numbers are a policy choice. |
| B | Explicitly state that refresh is not rate limited in v0.1 and remove the technical requirement. | Honest scope. | Loses a DoS control. |
| C | Reuse the login per-IP limit (5/min) for refresh. | Simple. | Too strict for normal CLI use. |

**Recommendation:** Option A. Add the two limits and a test that the 31st refresh for one family returns 429.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-010: Expired and revoked CLI session rows have no cleanup or retention policy [🟡 MINOR]

**Dimension:** 9 — Edge Cases (related: 4 Completeness Gaps)
**Location:** `RD-04-cli-auth.md:24-26, 74-77`
**Codebase Evidence:** `apps/server/migrations/20261030094203_initial.up.sql:77-87` has `expires_at` and `revoked_at` but no `expires_at` index and no cleanup job.

**The Problem:** The table grows without bound. Deleting rows too early would break reuse detection for old tokens; never deleting them is an operational burden.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Retain expired/revoked rows for 30 days to preserve reuse-detection and incident context; add an `expires_at` index and a daily cleanup job. | Bounded table; preserves recent history. | A scheduled job and an index. |
| B | Delete rows immediately after expiry/revocation. | Smallest table. | Reuse of an old token becomes an unknown token instead of a family revocation. |
| C | Never delete; rely on database maintenance. | No code. | Unbounded growth. |

**Recommendation:** Option A. Add the index and a daily cleanup that deletes rows older than 30 days past expiry or revocation. Keep the retention period documented.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-011: JWT claim set conflicts with the architecture documentation and the RD-06 policy path [🟡 MINOR]

**Dimension:** 12 — Consistency (related: 13 Codebase Alignment)
**Location:** `RD-04-cli-auth.md:57-70`
**Codebase Evidence:** `docs/architecture/identity.md:45-60` shows claims `sub`, `kind`, `authMethod`, `name`, `email`, `roles`, `permissions`, and `projects`; RD-04 lists only `sub`, `sid`, `jti`, `iat`, `exp`, and `kind`. RD-06 will enforce roles, and `docs/architecture/identity.md:76-77` says policy is re-evaluated from the database.

**The Problem:** Two contracts disagree. If roles and permissions are put in the token, role changes will not take effect until the 15-minute token expires, which conflicts with the 5-second revocation requirement. If they are not in the token, the docs are wrong.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep the minimal RD-04 claim set; load roles and permissions from the database on each request; update the docs to remove the extra claims from the CLI JWT example. | Consistent with immediate revocation; smaller token; no stale authorization. | One DB lookup per request (already needed for status). |
| B | Add `authMethod`, `name`, `email`, `roles`, `permissions`, and `projects` to the token now. | Fewer database reads for policy. | Stale roles for up to 15 minutes; token size; conflicts with 5-second revocation. |
| C | Keep both and let RD-06 decide. | Defers. | Unresolved contract. |

**Recommendation:** Option A. Keep the minimal claims and update `docs/architecture/identity.md`; RD-06 should read roles and permissions from the database, consistent with the per-request status check.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

### PF-012: CLI token logging has no nested request-body redaction or test [🟡 MINOR]

**Dimension:** 8 — Security Blind Spots (related: 7 Testability)
**Location:** `RD-04-cli-auth.md:105-112, 125`
**Codebase Evidence:** `apps/server/src/observability/logger.ts:13-63` redacts top-level `accessToken`, `refreshToken`, `authorization`, and `req.headers.authorization`, but not `req.body.accessToken` or `req.body.refreshToken`. No test sends a CLI token body and asserts that it never reaches the captured logs.

**The Problem:** The requirement says tokens never appear in logs or error bodies, but a handler that logs the request body would leak nested token fields. The current redaction set does not cover that path, and acceptance 8 has no test.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add `req.body.accessToken` and `req.body.refreshToken` to `REDACT_PATHS`; add a captured-log integration test for login, refresh, and error responses. | Closes the defense-in-depth gap; proves acceptance 8. | One-time test and redaction change. |
| B | Rely on the rule that handlers never log bodies. | No change. | No test; one mistake leaks tokens. |
| C | Remove request-body logging entirely. | Strongest. | Already the intended rule; the framework may still log bodies in future. |

**Recommendation:** Option A. Add the paths and a test that sends valid and invalid token bodies and asserts the raw tokens are absent from logs and error envelopes.

**User Decision:** Resolved — User accepted recommendation: Option A.

---

## Verdict

**✅ PASSED** — all 12 findings are resolved (7 major, 5 minor). Iteration 2 found zero new findings across the changed sections. RD-04 may advance to `RD Preflighted` and proceed to plan creation.

## Decision Summary

| Finding | Severity | Recommendation | Decision |
|---------|----------|----------------|----------|
| PF-001 | 🟠 MAJOR | Move CLI file/argv/logout acceptance to RD-11; keep server-log redaction in RD-04 | Resolved — Option A applied |
| PF-002 | 🟠 MAJOR | Dedicated `signing_keys` table plus signer; current/previous/retired lifecycle | Resolved — Option A applied |
| PF-003 | 🟠 MAJOR | Bearer middleware, `sid = family_id`, family/status check, `/cli/me`, browser-only guards | Resolved — Option A applied |
| PF-004 | 🟠 MAJOR | Shared `LocalLoginService` and shared limiter buckets | Resolved — Option A applied |
| PF-005 | 🟠 MAJOR | Absolute 12-hour family TTL, row-locked rotation, partial unique index | Resolved — Option A applied |
| PF-006 | 🟠 MAJOR | Revoke all CLI families in the password-change transaction | Resolved — Option A applied |
| PF-007 | 🟠 MAJOR | Shared Zod CLI schemas, base64url tokens, explicit expiry fields, stable errors | Resolved — Option A applied |
| PF-008 | 🟡 MINOR | Add CLI family list/revoke endpoints; RD-11 exposes `ov auth sessions` | Resolved — Option A applied |
| PF-009 | 🟡 MINOR | Add 60/min per IP and 30/min per family refresh limits | Resolved — Option A applied |
| PF-010 | 🟡 MINOR | Retain 30 days, add index, daily cleanup | Resolved — Option A applied |
| PF-011 | 🟡 MINOR | Minimal claims; roles from database; update docs | Resolved — Option A applied |
| PF-012 | 🟡 MINOR | Add nested body redaction paths and a log-capture test | Resolved — Option A applied |

## Next Step

Advance the RD-04 roadmap row to `RD Preflighted` and proceed to plan creation with the established `--auto-design` flow. The implementation plan should preserve the accepted decisions in this report and map every acceptance criterion to a specification test.

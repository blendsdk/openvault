# Current State: RD-04 CLI Authentication

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What exists

OpenVault already has a complete browser authentication boundary from RD-03:

- The auth plugin installs `SessionService`, `CredentialsRepository`, session middleware, the
  forced-change gate, the Origin guard, and the session-scoped CSRF guard
  (`apps/server/src/auth/plugin.ts:36-105`).
- Local login uses a fixed Argon2id policy, a generic `401 invalid_credentials` response,
  dummy verification, atomic failure counters, a 15-minute lockout, and shared per-IP and
  per-account rate-limit middleware (`apps/server/src/controllers/auth.ts:77-170`,
  `apps/server/src/auth/credentials.ts:170-251`, `apps/server/src/auth/password.ts:117-140`).
- Browser sessions are opaque, in-memory, and stored under a SHA-256 key
  (`apps/server/src/auth/sessions.ts:47-67`).
- The transport is HTTPS-only, with separate admin and agent listeners and a trusted-proxy
  source guard (`apps/server/src/transport/secure-application.ts:116-242`).
- PostgreSQL has a `cli_sessions` table with `id`, `principal_id`, `refresh_hash`,
  `family_id`, `expires_at`, `revoked_at`, `created_at`, `ip`, and `user_agent`
  (`apps/server/migrations/20261030094203_initial.up.sql:77-87`,
  `apps/server/src/database/schema.ts:107-119`).
- The keyring holds 32-byte AES KEKs and exposes status only. It never returns key bytes
  (`packages/core/src/keyring.ts:39-145`, `apps/server/src/security/keyring.ts:23-112`).
- Pino redaction covers top-level and one-level token fields but not
  `req.body.accessToken` or `req.body.refreshToken`
  (`apps/server/src/observability/logger.ts:13-63`).

### Relevant files

| File | Purpose | Changes needed |
|---|---|---|
| `apps/server/src/auth/types.ts` | Auth context and principal status | Split into discriminated browser/CLI contexts |
| `apps/server/src/auth/middleware.ts` | Session resolution, `requireSession`, forced-change gate | Add bearer intent, `requirePrincipal`/`requireCli`, CLI allowlist |
| `apps/server/src/auth/csrf.ts` | Origin and CSRF checks | Apply only to browser contexts |
| `apps/server/src/auth/plugin.ts` | Auth service and middleware wiring | Register CLI, signing-key, limit, and maintenance services |
| `apps/server/src/auth/credentials.ts` | Credential SQL and password change | Allow the password update to run on a transaction handle |
| `apps/server/src/controllers/auth.ts` | Browser auth routes | Use shared local login; revoke CLI families on password change |
| `apps/server/src/controllers/cli-auth.ts` | New CLI routes | Add login, refresh, logout, me, sessions, delete |
| `apps/server/src/security/keyring.ts` | KEK access boundary | Add scoped current/named key callbacks |
| `apps/server/src/security/signing-keys.ts` | New key wrapping/lifecycle | Add AES-GCM wrap/unwrap, ensure, rotate, retire, sign, verify |
| `apps/server/src/auth/cli-sessions.ts` | New CLI session repository | Add create, rotate, revoke, list, active-context, cleanup |
| `apps/server/src/auth/cli-jwt.ts` | New JWT helpers | Add pure sign and verify functions |
| `apps/server/src/auth/cli-auth-service.ts` | New CLI orchestration | Login, refresh, logout, token response |
| `apps/server/src/auth/bootstrap.ts` | New production bootstrap | Ensure key and start maintenance |
| `apps/server/src/auth/cli-maintenance.ts` | New cleanup timer | Startup and 24-hour cleanup |
| `apps/server/src/database/schema.ts` | Desired schema | Add `signing_keys`, partial indexes, cleanup index |
| `apps/server/migrations/*` | Migration lineage | Generate and review one additive migration |
| `packages/api-contract/src/cli-auth.ts` | New CLI contracts | Add strict schemas and types |
| `packages/api-contract/src/index.ts` | Contract exports | Export CLI schemas and types |
| `apps/server/src/observability/logger.ts` | Redaction list | Add nested access/refresh token paths |
| `apps/server/src/app.ts` | Application assembly | Register `CliAuthController` |
| `apps/server/src/main.ts` | Production startup | Call `bootstrapAuthRuntime` after `prepare` |
| `apps/server/src/types/express.d.ts` | `req.auth` typing | Use the discriminated union |
| `docs/guide/authentication.md` | User-facing auth guide | Document CLI server behavior |
| `docs/security/limitations.md` | Accepted limitations | Add process-local refresh limits and internal rotation |

### Code analysis

- `AuthContext` currently requires `session` and a browser `user`
  (`apps/server/src/auth/types.ts:46-53`). A CLI context cannot fit without narrowing every
  caller or changing the contract. The plan uses a union and a dedicated `requireCli`.
- `sessionMiddleware` reads only the cookie and resolves status on each request
  (`apps/server/src/auth/middleware.ts:34-77`). It must skip cookie resolution when the caller
  presented an Authorization header, so an invalid bearer cannot fall back.
- `originGuard` treats any `req.auth` as a browser session
  (`apps/server/src/auth/csrf.ts:43-46`). A CLI POST would therefore be forced to send browser
  Origin headers. It must check `req.auth.kind`.
- `csrfGuard` dereferences `req.auth.session` (`apps/server/src/auth/csrf.ts:79-94`), which
  does not exist on a CLI context.
- `AuthController.routes()` creates limiter instances inside the method. A second controller
  would get separate in-memory maps, so "same buckets" would be false even with equal numbers.
- `CredentialsRepository.changePassword` updates only `local_credentials`
  (`apps/server/src/auth/credentials.ts:235-252`). CLI revocation must join the same
  transaction and the same per-principal lock as refresh.
- `KeyringProvider` exposes status only (`apps/server/src/security/keyring.ts:86-103`). The
  signer needs a scoped callback, not raw key bytes in a controller.
- The CLI table has only `cli_sessions_family_idx` and `cli_sessions_principal_idx`
  (`apps/server/migrations/20261030094203_initial.up.sql:364-365`). The partial live-family
  unique index and the cleanup index do not exist.
- The existing schema is the migration source of truth
  (`apps/server/blendsdk.migrations.ts:10-14`). A new migration must be generated, not appended
  to the initial file.
- `createTestApplication()` prepares the app but does not bind a listener
  (`apps/server/src/app.ts:100-106`). Several unit tests use the default closed database URL
  (`apps/server/tests/integration/helpers/server-environment.ts:49`). Bootstrap therefore cannot
  run inside the plugin factory.
- The WebAFX rate limiter keeps a private `Map` per middleware instance
  (`blendsdk/webafx/application/rate-limiter.js:21-55`). Sharing requires sharing the
  middleware object, not only the numbers.
- `PostgreSQLDatabase.withTransaction` uses async-local storage and is safe for concurrent
  requests (`blendsdk/postgresql/database.d.ts:129-201`). It is already used by OIDC identity
  provisioning.

## Gaps Identified

### Gap 1: No CLI token issuer or verifier

**Current behavior:** There is no `apps/cli`, no CLI route, and no bearer middleware.
**Required behavior:** Login, refresh, logout, `/cli/me`, and protected CLI routes with
Ed25519 JWTs and refresh families.
**Fix required:** Contracts, signing keys, CLI session repository, auth service, controller,
bearer middleware, and app wiring.

### Gap 2: No signing-key store or lifecycle

**Current behavior:** The keyring holds only symmetric KEKs and exposes no key material.
**Required behavior:** A KEK-wrapped Ed25519 seed in `signing_keys`, with current/previous/
retired states, idempotent ensure, and rotation.
**Fix required:** Schema and migration, keyring callback, wrap/unwrap helpers, repository,
signer service, bootstrap.

### Gap 3: Browser-only auth context and guards

**Current behavior:** `req.auth` is always a browser session; CSRF and Origin assume a cookie.
**Required behavior:** Browser and CLI contexts, browser-only CSRF/Origin, no cookie fallback
for an invalid bearer.
**Fix required:** Auth-context union, bearer middleware, middleware and guard updates, request
typing update.

### Gap 4: Login logic is embedded in the browser controller

**Current behavior:** Normalization, lockout, dummy verification, counters, and the success
recheck live in `AuthController`.
**Required behavior:** Browser and CLI login share one implementation and one set of limiter
buckets.
**Fix required:** `LocalLoginService`, `AuthRateLimitService`, controller refactor.

### Gap 5: Password change does not revoke CLI families

**Current behavior:** The password update and browser session revocation are separate, and
`cli_sessions` is untouched.
**Required behavior:** The password hash update and every CLI family revocation commit in one
transaction under the per-principal lock.
**Fix required:** Transaction-aware credential update and CLI revocation.

### Gap 6: No CLI family management or retention

**Current behavior:** Only browser sessions can be listed and revoked. Expired CLI rows have no
cleanup.
**Required behavior:** CLI family list/revoke and 30-day bounded cleanup.
**Fix required:** Repository queries, controller routes, maintenance service, indexes.

### Gap 7: Nested token fields are not redacted

**Current behavior:** `REDACT_PATHS` does not cover `req.body.accessToken` or
`req.body.refreshToken`.
**Required behavior:** Nested token fields are redacted, and a captured-log test proves it.
**Fix required:** Add paths and an integration log assertion.

## Dependencies

### Internal dependencies

- RD-03 auth plugin, local credential verifier, password policy, browser sessions, CSRF, and
  forced-change gate.
- RD-01 schema, migration generator, generated types, keyring, and crypto helpers.
- RD-02 transport, config, logger, PostgreSQL adapter, and readiness.
- `@openvault/api-contract` and `@openvault/core`.
- WebAFX rate limiter, `jose`, and PostgreSQL advisory locks.

### External dependencies

- No new production dependency. `jose@6.2.13` is already installed.
- Node.js 24.7+ (24.21.0 in the verified environment).
- PostgreSQL 16 and 17 for integration tests.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Per-principal lock order deadlocks with password change | Low | High | Both paths lock `principals` first, then the refresh row; tests use concurrent requests |
| Partial unique index rejects a legitimate rotation | Low | High | Principal and row locks serialize writers; unique violation is treated as reuse and revokes the family |
| Signing-key overlap retires a live token | Low | High | 15m30s overlap and a due predicate at verification; rotation guard only when a previous exists |
| Shared limiter wrapper fails to resolve its service | Low | Medium | Propagate to `next`; tests cover both browser and CLI paths |
| Bootstrap runs in unit tests that have no database | Medium | High | Keep bootstrap in `main.ts` and an explicit test helper; lazy ensure covers first use |
| Migration adds a unique index to a non-empty table | Low | Medium | This is the first CLI implementation; the table is empty in every supported deployment |
| JWT negative tests accidentally exercise only one claim | Medium | High | Pure verifier unit tests cover alg, issuer, audience, kid, kind, iat, exp, and missing claims |
| Cleanup deletes a usable family row | Low | High | Predicate requires expiry more than 30 days ago; tests keep a live family row |
| File grows beyond review size | Medium | Medium | Split CLI repository, JWT, service, controller, and maintenance modules |
| Docs drift from implementation | Low | Medium | Docs build in `pnpm verify`; update the owning page only |

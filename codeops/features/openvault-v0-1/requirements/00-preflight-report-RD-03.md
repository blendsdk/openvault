# Preflight Report: RD-03 Human Authentication and Sessions

> **Status**: ✅ PREFLIGHT PASSED — all 17 findings resolved (4 critical, 8 major, 4 minor, 1 observation)
> **Iteration**: 1 (first scan)
> **Artifact**: Requirements document at `codeops/features/openvault-v0-1/requirements/RD-03-human-auth-sessions.md`
> **Artifact Hash**: `34a41d1cf8364358495c45efc935967a3d629df88dbfd5f809103cb7cfbd1b9e`
> **Git Revision**: `285b581670bcf6b45a4cd064b115f8f6068d4e5d`
> **Codebase Grounded**: 31 source, test, schema, and package files examined; 24 references verified
> **Last Updated**: 2026-10-30 21:38
> **Same-Session Bias**: The auditor did not author RD-03; the document predates this session.

## Codebase Context Summary

**Tech Stack:** TypeScript 7, Node.js 22.23, pnpm 12, Express 5, Zod 4, BlendSDK 5.68.1 (WebAFX, PostgreSQL, webafx-cache/memory, webafx-pino), jose 6, cookie-parser 1.4.7, PostgreSQL 16/17, Vitest 5.

**Architecture:** One `SecureWebApplication` extends WebAFX and owns two HTTPS listeners. A pre-stack installs request correlation, listener scope, proxy trust, media-type and body limits, and no-store headers. WebAFX owns routing, DI, response envelopes, error handling, and graceful disposal. PostgreSQL is accessed through `PostgreSQLDatabase.executeQuery`. The database schema includes `principals`, `local_credentials`, and `oidc_identities`; migrations are generated from `src/database/schema.ts`.

**Key Files Examined:**
- `codeops/features/openvault-v0-1/requirements/RD-03-human-auth-sessions.md`
- `codeops/features/openvault-v0-1/requirements/00-ambiguity-register.md`
- `codeops/features/openvault-v0-1/requirements/RD-04-cli-auth.md`, `RD-06-rbac.md`, `RD-07-audit.md`
- `apps/server/src/app.ts`, `main.ts`, `transport/pre-stack.ts`, `transport/secure-application.ts`, `transport/scope.ts`
- `apps/server/src/config/loader.ts`, `types.ts`, `redact.ts`
- `apps/server/src/database/schema.ts`, `generated-types.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/package.json`, `packages/api-contract/package.json`
- `apps/server/tests/integration/helpers/server-environment.ts`
- `node_modules/blendsdk/dist/webafx/application/{rate-limiter,csrf,web-application}.js`
- `node_modules/blendsdk/dist/webafx-auth/{index,oidc-auth-provider,oidc-auth-controller}.{d.ts,js}`
- `node_modules/blendsdk/dist/webafx-cache/{abstract-cache-provider,memory-cache-provider}.d.ts`
- `docs/reference/api.md`, `docs/guide/authentication.md`, `docs/architecture/identity.md`
- `deploy/compose/README.md`, `deploy/compose/compose.yaml`

**Reference Verification:** 24 references mapped — 20 verified, 4 contradictory or incomplete (noted below).

## Summary by Dimension

| # | Dimension | Findings | Highest Severity |
|---|-----------|----------|-----------------|
| 1 | Ambiguities | 5 | 🔴 |
| 2 | Implicit Assumptions | 3 | 🟠 |
| 3 | Logical Contradictions | 3 | 🟠 |
| 4 | Completeness Gaps | 4 | 🔴 |
| 5 | Dependency Issues | 3 | 🔴 |
| 6 | Feasibility Concerns | 2 | 🔴 |
| 7 | Testability | 2 | 🟠 |
| 8 | Security Blind Spots | 4 | 🔴 |
| 9 | Edge Cases | 3 | 🟠 |
| 10 | Scope Creep Indicators | 1 | 🟡 |
| 11 | Ordering & Sequencing | 2 | 🟠 |
| 12 | Consistency | 3 | 🟡 |
| 13 | Codebase Alignment | 4 | 🔴 |

## Summary by Severity

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 CRITICAL | 4 | All resolved |
| 🟠 MAJOR | 8 | All resolved |
| 🟡 MINOR | 4 | All resolved |
| 🔵 OBSERVATION | 1 | Resolved (documentation action) |

## Decision Summary

| Finding | Resolution | Authority |
|---------|------------|-----------|
| PF-001 | Add `openid-client`; reuse only the low-level OIDC provider methods | User approved CE-1 |
| PF-002 | Raise the Node.js baseline to 24.7+ and use built-in `crypto.argon2`; no new dependency | User chose the Node 24.7+ option |
| PF-003 | Link only by `(issuer, subject)`; require `email_verified`; JIT only for an unused email; reject collisions | User chose Option A |
| PF-004 | Add a pino log-method sanitizer and explicit auth redaction paths | User accepted recommendation |
| PF-005 | Absolute TTL; rotate secret and CSRF; stable public session ULID; in-memory index | User accepted recommendation |
| PF-006 | `POST /v1/auth/password`; current password; 12–1024 chars; revoke other sessions; rotate current | User chose Option A |
| PF-007 | Keep provisioning in RD-11/RD-13; RD-03 enforces the gate; fix the README | User accepted recommendation |
| PF-008 | Keep both limits; per-IP first; dummy hash for unknown/locked; test after the window or from another IP | User accepted recommendation |
| PF-009 | Session-scoped CSRF wrapper plus a separate same-origin guard | User accepted recommendation |
| PF-010 | Hashed state key, 600s TTL, atomic consume, strict `returnTo`, 5s timeouts, sanitized errors | User accepted recommendation |
| PF-011 | Shared Zod auth schemas in `@openvault/api-contract` | User accepted recommendation |
| PF-012 | Treat JIT as an audited system action; no roles; document the RD-06 integration | User accepted recommendation |
| PF-013 | Use `config.sessionTtlHours` with an 8-hour default and update the acceptance wording | User accepted recommendation |
| PF-014 | Use two WebAFX `rateLimitMiddleware` instances | User accepted recommendation |
| PF-015 | Return the current session's `createdAt` and `authMethod` as last-login data | User accepted recommendation |
| PF-016 | Add the new routes and the `0600` bootstrap-file behavior to the docs | User accepted recommendation |
| PF-017 | Document the single-instance limitation; no code change | User accepted recommendation |

---

## Findings

### PF-001: OIDC implementation cannot use the built-in WebAFX helper [🔴 CRITICAL]

**Dimension:** Dependency Issues / Feasibility / Codebase Alignment
**Location:** RD-03, Functional Requirements lines 25–28 and Technical Requirements lines 82–92
**Codebase Evidence:** `blendsdk/webafx-auth` re-exports `OidcAuthProvider`, whose module statically imports `openid-client` (`dist/webafx-auth/oidc-auth-provider.js:20`). `openid-client` is neither a dependency nor a peer of `blendsdk@5.68.1` and is absent from the lockfile; importing the subpath fails with `ERR_MODULE_NOT_FOUND`. The full `OidcAuthController` stores `accessToken`, `refreshToken`, and `idToken` in its session type (`oidc-types.d.ts:367-373`), which contradicts RD-03 lines 40–41.

**The Problem:** RD-03 requires OIDC but does not name an implementation. The only built-in BFF helper cannot load, and its session model stores the exact tokens RD-03 forbids. Choosing the wrong path either blocks implementation or creates a token-retention violation.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Implement discovery, authorization, token exchange, and UserInfo with native `fetch` + `jose` (already direct) | No new production dependency | Large security-critical protocol surface; custom state/nonce/timeout handling; large fake-IdP test suite |
| B | Add `openid-client`; reuse `OidcAuthProvider.buildAuthorizationUrl`, `exchangeCode`, and `fetchUserInfo` with a custom token-free session store | Reuses vetted PKCE/nonce/ID-token code; smaller test surface | New production dependency (`openid-client`, transitive `oauth4webapi`); the SDK provider has no request timeout, so a timed fetch wrapper is still needed |
| C | Add `openid-client` and use the full WebAFX controller, overriding session hooks to strip tokens | Least custom code | Controller `/refresh` needs the refresh token; stripping tokens breaks it; large fragile override; effectively a rewrite |

**Recommendation:** Option B — add `openid-client` and use only the low-level provider methods. It reuses the standards-critical code while keeping the token-free session model. Do not use the controller.
**Independent Challenger Verdict:** B (conditional on explicit dependency approval). Fallback A if the dependency is refused; C rejected.
**Complexity:** This is a production-dependency escalation. See the approval packet below.
**User Decision:** Resolved — see Decision Summary

---

### PF-002: Argon2id requires an unavailable production dependency [🔴 CRITICAL]

**Dimension:** Dependency Issues / Feasibility / Security
**Location:** RD-03, line 31 and line 132; local login lines 66–80
**Codebase Evidence:** `apps/server/package.json` has no Argon2 library. `local_credentials.password_hash` requires the `$argon2id$` PHC prefix (`database/schema.ts:92`). `@noble/hashes@1.8.0` is present only as a dev transitive and measured ~3.3 s per hash at 64 MiB / 3 / 1 in this environment. Node 22 has no built-in Argon2.

**The Problem:** The mandated KDF cannot be implemented with the current dependency set. A pure-JS fallback is too slow and allocates 64 MiB per concurrent login, creating a denial-of-service risk on the login surface. A native library is required.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | `@node-rs/argon2` 2.2.2 | Prebuilt Linux x64/arm64 glibc and musl; no install script; fast; PHC output matches the schema | New native production dependency and platform binaries |
| B | `argon2` 0.45.1 | Widely used; prebuilt binaries | `node-gyp-build` install script and compiler fallback; larger dependency surface |
| C | `@noble/hashes` 1.8.0 | Pure JS; already in the lockfile | ~3.3 s per hash at required parameters; 64 MiB per concurrent hash; login DoS |
| D | Implement Argon2id in-repo | No dependency | Custom crypto; unacceptable |

**Recommendation:** Option A — `@node-rs/argon2`. It is the only practical option that preserves the mandated parameters and login latency without a build toolchain.
**Independent Challenger Verdict:** A. Option C is a DoS; B adds install-script risk; D is unacceptable. Node 24.7 built-in `crypto.argon2` would avoid a package but raises the platform baseline.
**Complexity:** This is a production-dependency escalation. See the approval packet below.
**User Decision:** Resolved — see Decision Summary

---

### PF-003: OIDC account linking and JIT provisioning can enable account takeover [🔴 CRITICAL]

**Dimension:** Security Blind Spots / Edge Cases
**Location:** RD-03, lines 38–39 and lines 90–91
**Codebase Evidence:** `oidc_identities` is keyed by `(issuer, subject)` (`database/schema.ts:100-105`). `principals.email` is nullable and unique by `lower(email)` for users (`schema.ts:65,79-85`). The RD says to link an existing principal or provision one when the domain is allowed, but does not define email collisions or `email_verified`.

**The Problem:** Auto-linking by email across issuers lets an attacker-controlled IdP assert a victim's verified email and take over the local account. Ignoring the unique email index causes a provisioning failure that leaks account existence. The RD is silent on both.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Link only `(issuer, subject)`; require `email_verified === true` for any email decision; JIT only when the email is unused; reject collisions and require admin linking | No takeover path; deterministic; matches the schema key | Needs an admin linking path (RD-06); JIT is a system action, not an `identity.create` API call |
| B | Auto-link a verified email to an existing local principal across issuers | Convenient | Account takeover via reassignable email; unacceptable |
| C | No JIT in v0.1; admins pre-provision all OIDC identities | Safest | Removes the RD's allowed-domain JIT feature; extra admin work |
| D | JIT provision on collision by creating a second principal | Preserves JIT | Blocked by the unique lower(email) index; would require weakening a security constraint |

**Recommendation:** Option A. Treat JIT as an audited system action, not a violation of RD-06's admin-only `identity.create` rule. Add a cross-RD note that RD-06 must provide an admin linking path for collisions.
**Independent Challenger Verdict:** A, with the RD-06 ownership conflict resolved explicitly.
**User Decision:** Resolved — see Decision Summary

---

### PF-004: WebAFX logs the OIDC callback query, including code and state [🔴 CRITICAL]

**Dimension:** Security Blind Spots / Codebase Alignment
**Location:** RD-03, lines 40–41 and Security Considerations lines 136–144
**Codebase Evidence:** WebAFX installs a request-timing middleware that logs `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms` with `url: req.originalUrl` at info level (`dist/webafx/application/web-application.js:193-205`). The OIDC callback carries `code` and `state` in the query. The pino redaction list covers headers, password, token, value, and private keys but not `url`, `code`, `state`, `nonce`, `codeVerifier`, `idToken`, `accessToken`, or `refreshToken` (`apps/server/src/observability/logger.ts:12-31`).

**The Problem:** Every OIDC callback would write the authorization code and state to the access log. A code is single-use and short-lived, but log access plus a race can still enable session hijacking. This directly violates RD-03's "no tokens in logs" requirement and acceptance criterion 6.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add a pino `hooks.logMethod` sanitizer that strips query strings from string messages and `url` fields, plus explicit redaction paths for auth fields | Central; covers WebAFX's built-in log; no route changes | One small logger-layer control; must test both string and object paths |
| B | Replace WebAFX's request-initialization logging with a custom logger that logs only normalized paths | Removes the leak at source | Requires overriding framework internals; fragile across upgrades |
| C | Configure the callback route to reject query strings in logs by custom middleware | Local | Does not cover other routes or future leaks; rejection is impossible because the callback needs the query |

**Recommendation:** Option A. Add a sanitizer in the logger provider and expand `REDACT_PATHS`. The sanitizer must strip the query from `req.originalUrl` in both the message string and the `url` field. Add a spec test that performs a callback and asserts the code/state never appear in captured logs.
**Independent Challenger Verdict:** Required action X1; no conflicting option.
**User Decision:** Resolved — see Decision Summary

---

### PF-005: Session lifecycle, rotation, public IDs, and revocation are underspecified [🟠 MAJOR]

**Dimension:** Ambiguities / Completeness / Edge Cases
**Location:** RD-03, lines 44–47, 54–55, 94–103
**Codebase Evidence:** `webafx-cache` has `get`/`set`/`delete`/`deletePattern` but no enumeration or atomic take (`abstract-cache-provider.d.ts:85-102,129-149`). The session value is defined as principal id, CSRF, created, expires, method; no public handle is defined. The Should Have routes list/revoke by `:id`, but the only defined id is the secret cookie value.

**The Problem:** The plan cannot implement list/revoke, refresh rotation, or the 5-second disable requirement without deciding: absolute vs sliding expiry, whether CSRF rotates, how a session is identified without exposing the secret, and how old sessions are revoked. Using the cookie secret or its hash as a public handle leaks a credential-derived value.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Absolute TTL from creation; refresh rotates secret and CSRF, preserves expiry; add a stable public ULID per session; maintain a principal→session index and publicId→secretHash map in memory | Satisfies RD and AC7/AC10; no schema change; no secret exposure | Small in-process index; lost on restart (consistent with memory sessions) |
| B | Sliding TTL from last refresh; same public id | Simple | Stolen sessions can be extended indefinitely |
| C | Absolute TTL; keep CSRF stable; use a truncated hash as public id | Fewer moving parts | Leaks a derived secret; conflates identifiers |

**Recommendation:** Option A. Rotate both the secret and CSRF on refresh, return the new CSRF in the refresh response, preserve the absolute expiry and public ID, and set `Max-Age` to the remaining seconds. Add the index with TTL cleanup and `revokeAllForPrincipal`.
**Independent Challenger Verdict:** A, with stable public ID and an atomic consume primitive.
**User Decision:** Resolved — see Decision Summary

---

### PF-006: Forced password change has no endpoint, policy, or gate definition [🟠 MAJOR]

**Dimension:** Completeness / Ambiguities / Security
**Location:** RD-03, lines 37, 79–80
**Codebase Evidence:** `local_credentials` has `must_change` and `updated_at` (`database/schema.ts:91-98`). The API reference lists no password-change route (`docs/reference/api.md:43-55`). RD-04 expects to reuse the same local credential verifier (`RD-04:88`).

**The Problem:** The RD requires a forced change "before any other action" and says to "allow only the change endpoint", but defines neither the endpoint nor the policy. It also says login returns `{ mustChangePassword: true }`, which omits the CSRF token the client needs to call the change endpoint.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | `POST /v1/auth/password` with `{currentPassword,newPassword}`; min 12 / max 1024, no composition rules; require current password; revoke other sessions and rotate current; allow `/me`, `/logout`, `/password`, `/meta/*` while gated; include full session fields plus `mustChangePassword` | Complete; secure; unblocks the UI | One new endpoint; minor client friction |
| B | Same endpoint but skip current-password during forced change | Less friction | A stolen/unattended session can change the password |
| C | Defer to RD-06/RBAC | No endpoint work now | AC4 cannot pass inside RD-03 |
| D | Add composition rules (upper/lower/digit/symbol) | Familiar policy | Low value; not aligned with modern guidance |

**Recommendation:** Option A. Use NIST-style length rules, require the current password, revoke all other sessions, and return the new session/CSRF in the response.
**Independent Challenger Verdict:** A.
**User Decision:** Resolved — see Decision Summary — password policy is a reserved security-policy decision.

---

### PF-007: Bootstrap provisioning is out of scope, and the deployment docs contradict AR-29 [🟠 MAJOR]

**Dimension:** Dependency Issues / Ordering / Consistency
**Location:** RD-03, lines 35–37 and acceptance criterion 4
**Codebase Evidence:** `ov init` provisioning is RD-11/RD-13 scope (`RD-11:12`, `RD-13:52,159`). `deploy/compose/README.md:23-24,28` says the bootstrap password is printed once, contradicting AR-29 (`requirements/00-ambiguity-register.md:74`) and RD-03's one-time `0600` file rule. The server mounts the data volume read-only (`compose.yaml:61`).

**The Problem:** RD-03 cannot fully prove acceptance criterion 4 without the provisioner, and the deployment documentation tells operators to read the password from logs. Implementing a second bootstrap path inside RD-03 would duplicate RD-11/RD-13 and create a race with `openvault-init`.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | RD-03 implements only the forced-change gate and endpoint; tests seed a bootstrap principal fixture; `ov init` remains RD-11/RD-13; correct the README to a `0600` one-time file and operator read/delete step | Smallest correct scope; no duplicate path | AC4 is split across RDs and needs a cross-RD integration test |
| B | RD-03 implements a startup bootstrap file reader | Self-contained | Duplicates the provisioner; races `openvault-init`; new secret-handling surface |
| C | Move `ov init` into RD-03 | Single owner | Pulls keyring, CA, TLS, and CLI work into auth; large scope expansion |

**Recommendation:** Option A. Record the split in the plan and fix the README. Add a cross-RD integration test in RD-13.
**Independent Challenger Verdict:** A.
**User Decision:** Resolved — see Decision Summary

---

### PF-008: Lockout, per-IP limits, and timing acceptance criteria conflict [🟠 MAJOR]

**Dimension:** Logical Contradictions / Testability / Security
**Location:** RD-03, lines 32–34, 49, and acceptance criteria 2–3
**Codebase Evidence:** WebAFX `rateLimitMiddleware` throws `RateLimitError` (429) after the configured count (`dist/webafx/application/rate-limiter.js:38-58`). The per-IP limit is 5/min. `local_credentials` has `failed_count`, `locked_until`, and `updated_at` but no `last_failed_at` (`schema.ts:91-98`).

**The Problem:** AC3 says the sixth attempt returns 401 without a password check, but the sixth same-IP request in a minute hits the 429 limiter first. AC2 also requires comparable timing for locked accounts, which conflicts with skipping the password check unless a dummy hash runs. The 15-minute failure window has no explicit start timestamp.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Run the account lockout check before the per-IP limiter; dummy verify for unknown/locked; use `updated_at` as the failure-window anchor | Literal AC3 | Database work before the rate limiter; weaker DoS posture |
| B | Keep per-IP limiter first; test the sixth attempt after the 1-minute window or from a second trusted IP, still within the 15-minute lockout; dummy verify for unknown/locked; use `updated_at` | Keeps a strong rate-limit boundary; satisfies both criteria in a realistic test | Test needs clock/IP control; `updated_at` window is approximate |
| C | Relax one of the limits | Simpler | Changes accepted security policy; reopens AR-14 |

**Recommendation:** Option B. Use two WebAFX limiter instances (per-IP 5/min, per-account 10/hour), run the per-IP limiter first, and use a dummy Argon2 verify for unknown, disabled, and locked accounts. Test the sixth attempt after the window or from a second trusted IP. Reset `failed_count` when `locked_until` expires; use one atomic `UPDATE … RETURNING` to avoid lost increments.
**Independent Challenger Verdict:** B.
**User Decision:** Resolved — see Decision Summary

---

### PF-009: CSRF and Origin enforcement need a precise, non-breaking design [🟠 MAJOR]

**Dimension:** Security Blind Spots / Completeness
**Location:** RD-03, lines 46–47 and 105–113
**Codebase Evidence:** WebAFX `csrfMiddleware` compares a header against `expectedToken` in constant time and fails closed when the expected token is absent (`dist/webafx/application/csrf.js:52-82`). It has no Origin or Sec-Fetch-Site check. Applying it globally would reject future bearer/mTLS routes that have no session token.

**The Problem:** RD-03 requires token plus origin checks on all unsafe browser requests, with login and callback exempt. A global token check breaks non-browser routes; an origin check without a session boundary breaks CLI/agent requests; and a missing origin policy leaves cross-site requests accepted.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Wrap `csrfMiddleware`: apply it only when a valid session is attached; add a separate origin guard for cookie-authenticated unsafe requests; require `Origin === baseUrl.origin` or `Sec-Fetch-Site: same-origin`, reject if both absent; exempt `POST /v1/auth/local/login` and `GET /v1/auth/callback` | Correct boundary; future-proof for bearer/mTLS; reuses constant-time compare | Two small middleware pieces |
| B | Apply the WebAFX middleware globally with route exemptions for login/callback and every bearer/mTLS route | One middleware | Brittle exemption list; future routes break |
| C | Implement a custom combined token+origin middleware | One piece | Duplicates security-critical constant-time comparison |

**Recommendation:** Option A. Resolve the session before CSRF so an invalid cookie yields 401, not 403. Apply the origin guard to the local login POST as defense in depth even though the token is exempt.
**Independent Challenger Verdict:** A.
**User Decision:** Resolved — see Decision Summary

---

### PF-010: OIDC state, nonce, returnTo, and failure behavior are underspecified [🟠 MAJOR]

**Dimension:** Security Blind Spots / Edge Cases / Completeness
**Location:** RD-03, lines 82–92
**Codebase Evidence:** `webafx-cache` has no atomic take; `get` + `delete` is not atomic across awaits (`abstract-cache-provider.d.ts:85-102`). The `blendsdk/webafx-cache` main entrypoint imports `ioredis`, which is not installed; the memory subpath avoids it (`dist/webafx-cache/memory.d.ts:1-9`).

**The Problem:** The RD says state is single-use and returnTo is same-origin, but does not define the key, atomic consumption, redirect validation, IdP timeouts, or the response when the IdP is unavailable. A replay or open redirect is possible if these are left to implementation.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Store `{codeVerifier, nonce, returnTo}` by SHA-256 of state with a 600s TTL; consume with an in-flight set; validate returnTo with `new URL(returnTo, baseUrl)`, require same origin, reject `//`, `\`, control chars, and >2048; 5s abort timeouts on discovery/token/UserInfo; generic 503 `oidc_unavailable` and 400 `oidc_callback_failed`; consume state on failure; sanitized logging | Meets RD; safe failure behavior | Small in-flight set; process-local |
| B | Signed cookies for state and returnTo | Stateless | RD says memory cache; exposes verifier to the client; signed is not secret; open-redirect risk |
| C | Use the WebAFX provider's state store | Reuses code | Coupled to the token-storing controller; requires `openid-client`; wrong session model |

**Recommendation:** Option A. Add a global cap on outstanding states to bound memory under a login flood. Log only error classes, never state/code/verifier/nonce/tokens.
**Independent Challenger Verdict:** A.
**User Decision:** Resolved — see Decision Summary

---

### PF-011: API response contracts and input bounds are incomplete [🟠 MAJOR]

**Dimension:** Completeness / Consistency / Integration Points
**Location:** RD-03, lines 29–30, 48, 76–80, 146–165; `docs/reference/api.md:43-61`
**Codebase Evidence:** `@openvault/api-contract` exists and exports Zod schemas (`packages/api-contract/src/ids.ts`); the server already depends on it (`apps/server/package.json:19`). The API reference lists auth routes but no password-change or session-management routes.

**The Problem:** RD-03 names `{user, expiresAt, csrfToken}`, `{mustChangePassword}`, and `{local, oidc}`, but does not define the user object, the refresh response, session-list fields, or input bounds. RD-12 will consume `/me` and the CSRF token, so drift is likely without a shared contract.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Define shared Zod schemas in `@openvault/api-contract` for login/me/refresh/sessions/meta; stable user shape (`id,name,email,authMethod`); ISO timestamps; identifier max 320; password max 1024; new password min 12; strict objects; use them in controllers and tests | Prevents drift; testable; no new dependency | Adds five small schemas to the package |
| B | Keep response shapes inline and document them in `docs/reference/api.md` | Less upfront work | Drift between controllers, tests, and UI |
| C | Return raw database rows | Fast | Leaks password hashes, status, and internal timestamps |

**Recommendation:** Option A. Keep `mustChangePassword` top-level, include the full session fields in the login and `/me` payloads, and add the new routes to the API reference.
**Independent Challenger Verdict:** A.
**User Decision:** Resolved — see Decision Summary

---

### PF-012: JIT provisioning conflicts with RD-06's identity-ownership rule [🟠 MAJOR]

**Dimension:** Logical Contradictions / Dependency Issues
**Location:** RD-03, lines 38–39 and 90–91; RD-06 line 96
**Codebase Evidence:** RD-06 says "Human users are org-level principals; only org-scope `identity.create` creates them." RD-03 requires JIT provisioning when an allowed domain is configured.

**The Problem:** A login-time JIT user is created without an `identity.create` authorization check. Either JIT is a system action outside the RBAC rule, or RD-03's JIT requirement cannot be implemented as written.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Treat JIT as an audited system bootstrap action, limited to `email_verified === true` and an allowed domain; document the RD-06 integration | Preserves JIT and default-deny roles | Needs a cross-RD note and audit event |
| B | Defer JIT to RD-06 and require admin pre-provisioning in v0.1 | Strict RBAC alignment | Removes a Must Have from RD-03; extra admin work |
| C | Let JIT call the RBAC `identity.create` path | Single authorization model | No session exists yet; org admin credentials are absent; circular |

**Recommendation:** Option A. JIT users receive no roles (default deny) and the action is audited by RD-07.
**Independent Challenger Verdict:** A, with the conflict resolved explicitly.
**User Decision:** Resolved — see Decision Summary

---

### PF-013: Session TTL configuration does not match the acceptance criterion [🟡 MINOR]

**Dimension:** Consistency
**Location:** RD-03 line 45; `apps/server/src/config/loader.ts:303`
**Codebase Evidence:** `OPENVAULT_SESSION_TTL_HOURS` defaults to 8 but accepts 1–24. RD-03 hardcodes 8 hours.

**The Problem:** An operator can configure a 24-hour session while the acceptance criterion says 8 hours. The plan must either use the config with the documented default or clamp it.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Use `config.sessionTtlHours`; document the default as 8 and the allowed range as 1–24; update AC to "configured TTL, default 8 hours" | Reuses RD-02 config; operator control | AC wording needs a small amendment |
| B | Clamp to 8 hours | Literal AC | Makes the config setting misleading |

**Recommendation:** Option A.
**User Decision:** Resolved — see Decision Summary

---

### PF-014: Rate-limit primitives exist but are not referenced [🟡 MINOR]

**Dimension:** Codebase Alignment / Consistency
**Location:** RD-03 line 117 (Integration Points)
**Codebase Evidence:** WebAFX provides `rateLimitMiddleware` (`dist/webafx/application/rate-limiter.d.ts`). RD-03 says RD-02 supplies rate-limit primitives, which is true through WebAFX, but the plan should not build a custom limiter.

**The Problem:** Without naming the primitive, the plan could duplicate it.

**Recommendation:** Use two `rateLimitMiddleware` instances: per-IP 5/min and per-account 10/hour keyed by the normalized identifier. No custom limiter.
**User Decision:** Resolved — see Decision Summary

---

### PF-015: Last-login display has no data source [🟡 MINOR]

**Dimension:** Completeness / Data & State
**Location:** RD-03, Should Have line 56
**Codebase Evidence:** `principals` and `local_credentials` have no last-login column. RD-07 owns audit events.

**The Problem:** The Should Have says the UI shows a last-login timestamp and method, but RD-03 does not define where it comes from.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Return the current session's `createdAt` and `authMethod` as `lastLoginAt`/`authMethod`; no schema change | Small; works for v0.1; no RD-07 dependency | It is the current login, not the previous one |
| B | Add `last_login_at` and `last_auth_method` columns | True last-login history | Schema migration; duplicates RD-07 audit data |
| C | Defer the Should Have to RD-07/RD-12 | No work now | Feature not delivered in RD-03 |

**Recommendation:** Option A.
**User Decision:** Resolved — see Decision Summary

---

### PF-016: Documentation and route references are incomplete [🟡 MINOR]

**Dimension:** Consistency / Codebase Alignment
**Location:** `docs/reference/api.md:43-61`, `docs/guide/authentication.md:27-29`, `deploy/compose/README.md:23-28`
**Codebase Evidence:** The API reference omits `/v1/auth/password`, `/v1/auth/sessions`, and `/v1/auth/sessions/:id`. The deployment README says the bootstrap password is printed once, contradicting AR-29.

**The Problem:** Operators and the UI will follow incomplete or unsafe documentation.

**Recommendation:** Add the new routes, the forced-change behavior, the `0600` one-time bootstrap file, and the operator read/delete step. Fix the "printed once" wording.
**User Decision:** Resolved — see Decision Summary

---

### PF-017: Memory rate limiting and sessions are single-instance only [🔵 OBSERVATION]

**Dimension:** Non-functional / Scope
**Location:** RD-03 session store line 100; rate limits line 49
**Codebase Evidence:** WebAFX rate limiter and memory cache are process-local. The Compose reference stack runs one server instance.

**The Problem:** Multi-instance deployments would not share sessions or rate-limit counters. This is acceptable for v0.1 but must be documented.

**Recommendation:** Document the single-instance limitation in `docs/security/limitations.md` and the deployment README. No code change in RD-03.
**User Decision:** Resolved — see Decision Summary

---

## Complexity Escalation Packets

### CE-1: Add `openid-client` for the OIDC flow

**Original goal:** Implement OIDC authorization-code login with PKCE, state, and nonce without storing tokens.
**Extra system or support code:** `openid-client` plus its transitive `oauth4webapi` dependency, used only for discovery, authorization URL construction, code exchange, and UserInfo.
**Why it may be needed:** The built-in WebAFX provider cannot load without it; writing the protocol by hand is a larger security-critical surface.
**Evidence:** `dist/webafx-auth/oidc-auth-provider.js:20` statically imports `openid-client`; `blendsdk@5.68.1` declares neither a dependency nor a peer; the module fails with `ERR_MODULE_NOT_FOUND`.
**Smallest solution that still works:** Implement the flow with native `fetch` + `jose` (already installed). Viable, but requires a custom discovery/token/nonce/UserInfo implementation and a larger fake-IdP test suite.
**Extra cost:** Two production packages, supply-chain review, one additional version surface, and a timed-fetch wrapper (the SDK provider has no request timeout).
**Independent verdict:** **Justified** — B is the safer, smaller security-critical code surface; A remains a viable fallback.
**Recommendation:** Approve `openid-client`.
**Direct user decision:** ✅ Approved — add `openid-client` and use the low-level provider methods.

### CE-2: Password hashing — dependency versus Node baseline

**Original goal:** Verify local passwords with Argon2id at 64 MiB / 3 iterations / 1 lane.
**Extra system or support code:** Option A adds `@node-rs/argon2` plus platform binaries. Option B raises the project Node baseline to 24.7+ and uses built-in `crypto.argon2`.
**Why it may be needed:** No Argon2 implementation is installed. The pure-JS alternative takes ~3.3 s per hash at the mandated parameters and allocates 64 MiB per concurrent login.
**Evidence:** `apps/server/package.json` has no Argon2 dependency; `local_credentials.password_hash` requires the `$argon2id$` prefix (`schema.ts:92`); Node 24.21.0 is already installed at `~/.nvm/versions/node/v24.21.0` and its `crypto.argon2Sync` measured ~260 ms at the mandated parameters.
**Smallest solution that still works:** Node 24.7+ built-in `crypto.argon2` avoids a new production dependency. The cost is a platform-wide baseline change: `engines`, `.nvmrc`, both CI workflows, `@types/node`, and the documented requirements.
**Extra cost:** Option A: one native dependency and binary packages. Option B: Node baseline change across the workspace and CI; no new package.
**Independent verdict:** **Justified** for either option; both preserve the mandated parameters. Option A minimizes platform churn; Option B minimizes dependency surface.
**Recommendation:** The independent challenger preferred Option A, but the user selected Option B to avoid a new native dependency.
**Direct user decision:** ✅ Approved — raise the Node baseline to 24.7+ and use built-in `crypto.argon2`; do not add `@node-rs/argon2`.

---

## Verdict

✅ **PREFLIGHT PASSED** — all 17 findings resolved. The OIDC dependency is approved; password hashing uses the Node 24.7+ built-in `crypto.argon2` instead of a new dependency. The plan must include the Node baseline change and the RD-03 clarifications recorded in the Decision Summary.

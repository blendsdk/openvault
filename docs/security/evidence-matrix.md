# Security evidence matrix

> **Generated file.** Run `pnpm security:evidence` after changing
> `docs/security/evidence-matrix.json`. The `pnpm verify` gate fails when this
> page is stale or a linked test is missing.

Updated: 2026-11-06

## Threat-model coverage

| ID | Threat | Protection | Evidence |
|---|---|---|---|
| T-01 | A network attacker intercepts admin, browser, or agent traffic | TLS 1.2+, HSTS, a separate mTLS agent listener, and a proxy-only admin listener | test: `apps/server/tests/integration/transport.spec.test.ts` — serves health over TLS and rejects a plaintext request<br>test: `apps/server/tests/integration/agent-listener.spec.test.ts` — should allow the certificate project and reject foreign or deleted projects |
| T-02 | Credential stuffing or password guessing against a local account | Argon2id, per-address and per-account limits, lockout, and a generic failure response | test: `apps/server/tests/integration/auth.local.test.ts` — should lock the credential for fifteen minutes after five failures and refuse a correct password<br>test: `apps/server/tests/integration/auth.local.test.ts` — should reject the eleventh attempt for one identifier from separate addresses with a rate-limit error |
| T-03 | A stolen browser session cookie is replayed | Host-scoped HttpOnly Secure SameSite cookie, CSRF token, rotation, and absolute expiry | test: `apps/server/tests/integration/auth.sessions.test.ts` — should rotate the secret and CSRF token on refresh while keeping the session identity<br>test: `apps/server/tests/auth/cookie.impl.test.ts` — should set the host-scoped hardened attributes |
| T-04 | A cross-site request performs a state change with the user's cookie | Origin and Fetch Metadata checks plus a per-session CSRF header on every unsafe method | test: `apps/server/tests/auth/csrf.spec.test.ts` — should reject an unsafe request that omits the CSRF header even when the session is valid<br>test: `apps/web/tests/session.test.tsx` — should add credentials and the CSRF header to unsafe methods |
| T-05 | A stolen CLI access or refresh token is replayed | Short-lived JWTs and rotating refresh tokens with reuse detection and family revocation | test: `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` — should revoke the whole family and reject the current refresh token when a rotated token is reused |
| T-06 | A principal performs an action outside its role, scope, or project | Deny-by-default RBAC with org, project, and object scopes and capability flags | test: `apps/server/tests/integration/rbac-policy.spec.test.ts` — should deny every action when the principal has no assignment<br>test: `apps/server/tests/integration/rbac-policy.spec.test.ts` — should never inherit upward from an object assignment |
| T-07 | A service identity reaches control-plane actions | A service ceiling in the policy engine rejects control-plane actions even with a forged assignment | test: `apps/server/tests/integration/rbac-policy.spec.test.ts` — should deny control-plane actions to a service principal even with a forged row |
| T-08 | A compromised workload reads another project's delivered files | Per-project and per-service host directories, a manifest that cannot change project or root, and a read-only application mount | test: `apps/agent/tests/manifest.spec.test.ts` — should reject a mismatched project, service, or output directory<br>test: `apps/server/tests/scaffold-renderer.impl.test.ts` — should produce distinct per-service and per-project paths |
| T-09 | A stolen agent certificate is used after revocation | Atomic identity revocation, certificate invalidation, listener cache invalidation, and files removed on 401/403 | test: `apps/server/tests/integration/agent-listener.spec.test.ts` — should revoke new, reused, and renewal connections within the process<br>test: `apps/server/tests/integration/agent-revoke.impl.test.ts` — should clear both local caches after an atomic revoke |
| T-10 | A database dump exposes secret or certificate plaintext | AES-256-GCM envelope encryption with a KEK outside the database and per-object AAD | test: `apps/server/tests/integration/secrets-crypto.spec.test.ts` — should encrypt and decrypt through the provider<br>test: `apps/server/tests/integration/schema.spec.test.ts` — should reject invalid secret envelope lengths and oversized ciphertext |
| T-11 | A stolen backup exposes plaintext or is silently corrupted | An age passphrase archive with a checksum manifest and a preflight keyring check | test: `apps/server/tests/integration/ops.spec.test.ts` — should create a verifiable encrypted archive and reject tampering<br>test: `apps/server/tests/integration/ops.spec.test.ts` — should restore into an empty target and verify secrets, audit, CA, and agent certificate |
| T-12 | The keyring is read, replaced, or serialized into a log | Absolute path, exact 0600, no symlinks, status-only serialization, and redacted logs | test: `apps/server/tests/keyring.spec.test.ts` — rejects a keyring file that is not exactly 0600<br>test: `apps/server/tests/keyring.spec.test.ts` — serializes only status fields |
| T-13 | An attacker edits, deletes, or truncates the audit chain | Hash chain, HMAC, checkpoints, and verification that reports the first broken event | test: `apps/server/tests/integration/audit-verify.spec.test.ts` — should detect an edited details value and an edited hash<br>test: `apps/server/tests/integration/audit-verify.spec.test.ts` — should detect a deleted tail even when a newer checkpoint exists |
| T-14 | A secret, token, CSR, or key is written to a log | Pino path redaction, request URL sanitization, and agent event-only logging | test: `apps/server/tests/logging.spec.test.ts` — masks the documented top-level, one-level, and request-body paths<br>test: `apps/server/tests/integration/agent-logging.spec.test.ts` — should log stable outcomes without tokens, CSRs, or key material |
| T-15 | Injection or path traversal reaches SQL, the filesystem, or a route | Parameterized SQL, strict schemas, canonical paths, and malformed-encoding rejection | test: `apps/server/tests/integration/transport.spec.test.ts` — normalises path variants and rejects malformed encodings<br>test: `apps/server/tests/integration/transport.impl.test.ts` — rejects malformed percent encoding at the live listener |
| T-16 | An oversized or malformed body exhausts memory or bypasses a limit | Body limits, decoded-value limits, and bounded CSR and certificate envelopes | test: `apps/server/tests/integration/transport.impl.test.ts` — parses a chunked body once and still applies the secret limit<br>test: `apps/server/tests/agent/csr.impl.test.ts` — should reject empty and oversized envelopes before ASN.1 parsing |
| T-17 | A flood or repeated request bypasses a rate limit | Per-IP, per-account, per-principal, per-family, and per-route buckets with bounded state | test: `apps/server/tests/integration/secrets-http.spec.test.ts` — should limit one principal and keep separate buckets<br>test: `apps/server/tests/agent/rate-limits.impl.test.ts` — should limit joins per source address |
| T-18 | A container escapes its intended privileges or reaches the Docker socket | Non-root users, read-only roots, capability drops, no-new-privileges, resource limits, and no socket mount | script: `scripts/check-compose.mjs` — validateCompose<br>manual: docs/security/hardening.md |
| T-19 | A browser secret value leaks into storage, the URL, or the console | Reveal lives only in component state, clears on blur/navigation/timeout, and is never stored | test: `apps/web/tests/secret-detail.test.tsx` — should mask the value and read it only on reveal<br>test: `apps/web/tests/secrets-list.test.tsx` — should create a secret and clear the value from the dialog |
| T-20 | The admin listener is reachable without the proxy or health source guard | Proxy CIDR allowlist, loopback-only health and readiness, and no published admin port | test: `apps/server/tests/integration/transport.spec.test.ts` — allows health and readiness but not general admin routes<br>test: `apps/server/tests/integration/transport.spec.test.ts` — matches IPv4, IPv4-mapped, and IPv6 peers and rejects mixed families |
| T-21 | A leaked runtime database credential forges credentials, RBAC, OIDC links, or agent identity | Separate openvault_auth control-plane role; app role loses DML on eight identity tables; production startup assertion | test: `apps/server/tests/integration/security/auth-boundary.spec.test.ts` — should deny every write on the eight control-plane tables to the app role<br>test: `apps/server/tests/integration/security/auth-boundary.spec.test.ts` — should reject the startup assertion when the app connection is over-privileged |
| T-22 | Discovery metadata redirects OIDC credentials or tokens to another origin | HTTPS endpoint-origin allowlist and redirect rejection | test: `apps/server/tests/auth/oidc.impl.test.ts` — should reject a cross-origin endpoint for every discovery field<br>test: `apps/server/tests/auth/oidc.impl.test.ts` — should disable redirects on endpoint requests |
| T-23 | An unassigned caller enumerates project or secret names through 403/404 differences | Collection-visibility denials with identical 404 bodies for hidden and missing names | test: `apps/server/tests/integration/security/enumeration.spec.test.ts` — should give an unassigned caller identical 404 bodies for existing and missing secret names<br>test: `apps/server/tests/integration/security/enumeration.spec.test.ts` — should allow an object-scope reader but hide every other name |

## Required specification files

| RD | Files |
|---|---|
| RD-01 | `apps/server/tests/config.spec.test.ts`<br>`apps/server/tests/integration/migrations.spec.test.ts` |
| RD-02 | `apps/server/tests/integration/transport.spec.test.ts`<br>`apps/server/tests/integration/readiness.spec.test.ts` |
| RD-03 | `apps/server/tests/auth/password.spec.test.ts`<br>`apps/server/tests/auth/sessions.spec.test.ts`<br>`apps/server/tests/auth/csrf.spec.test.ts` |
| RD-04 | `apps/server/tests/integration/auth.cli-login.spec.test.ts`<br>`apps/server/tests/integration/auth.cli-refresh.spec.test.ts` |
| RD-05 | `apps/server/tests/integration/agent-join.spec.test.ts`<br>`apps/server/tests/integration/ca-x509.spec.test.ts`<br>`apps/server/tests/integration/service-principals.spec.test.ts` |
| RD-06 | `apps/server/tests/integration/rbac-policy.spec.test.ts`<br>`apps/server/tests/integration/rbac-catalog.spec.test.ts` |
| RD-07 | `apps/server/tests/integration/audit-chain.spec.test.ts`<br>`apps/server/tests/integration/audit-security.spec.test.ts` |
| RD-08 | `apps/server/tests/integration/secrets-crypto.spec.test.ts`<br>`apps/server/tests/integration/secrets-lifecycle.spec.test.ts` |
| RD-09 | `apps/server/tests/integration/certificates-pem.spec.test.ts`<br>`apps/server/tests/integration/certificates-lifecycle.spec.test.ts`<br>`apps/server/tests/integration/certificates-expiry.spec.test.ts` |
| RD-10 | `apps/agent/tests/delivery.spec.test.ts`<br>`apps/agent/tests/join.spec.test.ts`<br>`apps/server/tests/integration/scaffold.spec.test.ts` |
| RD-11 | `apps/cli/tests/commands.spec.test.ts`<br>`apps/server/tests/integration/ops.spec.test.ts` |
| RD-12 | `apps/server/tests/integration/web-ui.spec.test.ts`<br>`apps/web/tests/secret-detail.test.tsx`<br>`apps/web/tests/login.test.tsx` |
| RD-13 | `apps/server/tests/integration/ops.spec.test.ts`<br>`apps/server/tests/integration/roles.spec.test.ts`<br>`apps/cli/tests/doctor.impl.test.ts` |
| RD-14 | `apps/server/tests/integration/rbac-release.spec.test.ts`<br>`apps/server/tests/auth/csrf.spec.test.ts` |

## Named security categories

| Category | Evidence |
|---|---|
| Authorization matrix and service ceiling | `apps/server/tests/integration/rbac-policy.spec.test.ts` — should honor the role matrix and scope eligibility |
| Injection and path traversal | `apps/server/tests/integration/transport.impl.test.ts` — rejects malformed percent encoding at the live listener |
| Oversized bodies | `apps/server/tests/integration/transport.impl.test.ts` — parses a chunked body once and still applies the secret limit |
| Rate limits | `apps/server/tests/integration/auth.local.test.ts` — should reject the sixth login from one address within a minute with a rate-limit error |
| CSRF | `apps/server/tests/auth/csrf.spec.test.ts` — should reject an unsafe request when the Origin does not match the configured origin |
| Session rotation | `apps/server/tests/auth/sessions.spec.test.ts` — should issue a new secret and CSRF token while keeping the public identity and expiry |
| Token reuse | `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` — should allow exactly one of two concurrent refreshes and revoke the family for both tokens |
| mTLS rejection | `apps/server/tests/integration/transport.spec.test.ts` — rejects missing and untrusted client certificates and accepts the trusted one |
| Audit tamper | `apps/server/tests/integration/audit-verify.spec.test.ts` — should detect a deleted middle event at the next retained row |
| Redaction | `apps/server/tests/logging.spec.test.ts` — masks the documented top-level, one-level, and request-body paths |
| Tmpfs isolation | `apps/server/tests/scaffold-renderer.impl.test.ts` — should produce distinct per-service and per-project paths<br>manual: docs/security/hardening.md |
| No secret-value leakage | `apps/web/tests/secret-detail.test.tsx` — should mask the value and read it only on reveal<br>`apps/server/tests/integration/agent-logging.spec.test.ts` — should log stable outcomes without tokens, CSRs, or key material |

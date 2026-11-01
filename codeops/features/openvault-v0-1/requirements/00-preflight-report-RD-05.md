# Preflight Report: RD-05 Service Identities and mTLS

> **Status**: ✅ PASSED — 16 initial findings and 24 re-scan findings resolved; no accepted minors remain
> **Iteration**: 3 (iteration 1 plus two bounded re-scans)
> **Artifact**: Single requirement document at `codeops/features/openvault-v0-1/requirements/RD-05-service-identities-mtls.md`
> **Artifact Ref**: `0f7a0d79c3c36985a185b5cdb571cdd01f0effdd`
> **Codebase Grounded**: 34 source, schema, test, and configuration files examined; 31 references verified, 0 unverifiable
> **Scope**: Strict target. The audit target is RD-05.
> **Authorized Modification Set**: RD-05 plus RD-02, RD-03, RD-04, RD-06, RD-07, RD-10, RD-13, the requirements README, the API/configuration reference, architecture docs, and guides. The user explicitly approved this expanded set on 2026-11-01.
> **Last Updated**: 2026-11-01 11:30
> **Same-Agent Review**: The artifact was drafted in an earlier session. This review is independent of its creation. Because the subject is PKI and mTLS, a human domain-expert review is also recommended before implementation.
> **Auto-Design**: Active. Root invocation ID `rd05-preflight-2026-11-01T0950`; policy version 1. Eligible technical decisions are recorded in the Delegated Decision Record.
> **Commit Authorization**: `--auto-commit` is treated as the user's instruction to apply accepted fixes, verify them, and commit/push them. It does not approve a reserved decision, expand the modification set, or approve extra complexity.

## Codebase Context Summary

**Tech Stack:** pnpm workspace, TypeScript 7, Node.js >= 24.7, Express 5 through BlendSDK WebAFX, PostgreSQL 16/17, Vitest, `jose`, `pino`, and `@openvault/api-contract`.

**Architecture:** The server has typed configuration, separate admin and agent HTTPS listeners, browser and CLI authentication, a symmetric KEK keyring, readiness probes, and PostgreSQL-backed sessions and signing keys. The initial schema already contains `principals(kind, owner_project_id, status)`, `join_tokens`, `workload_certs`, and `consumers`. There is no agent controller, no CA private-key store or signer, no RBAC evaluator, no audit writer, and no X.509/CSR library.

**Key Files Examined:**

- `apps/server/src/transport/secure-application.ts`, `tls.ts`, `scope.ts`, `pre-stack.ts`
- `apps/server/src/config/types.ts`, `loader.ts`, `redact.ts`
- `apps/server/src/main.ts`, `app.ts`, `auth/plugin.ts`, `auth/middleware.ts`, `auth/types.ts`
- `apps/server/src/readiness/service.ts`, `security/keyring.ts`, `security/signing-keys.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/migrations/20261030094203_initial.up.sql`, `20261101000455_cli-auth.up.sql`
- `apps/server/src/database/schema.ts`, `generated-types.ts`
- `apps/server/tests/integration/transport.spec.test.ts`, `schema.spec.test.ts`
- `apps/server/tests/integration/helpers/tls.ts`
- `packages/core/src/keyring.ts`, `crypto.ts`
- `packages/api-contract/src/*.ts`
- `docs/reference/api.md`, `configuration.md`, `roles.md`, `cli.md`
- `docs/architecture/identity.md`, `crypto.md`, `overview.md`
- `docs/guide/authentication.md`, `rotation.md`, `install.md`, `docker-compose.md`
- RD-02, RD-03, RD-06, RD-07, RD-10, RD-13, the requirements README, and the ambiguity register

**Reference Verification:** 31 references mapped to code or documents; 31 verified; 0 unverifiable. The expected absence is the agent implementation, the CA signer, the RBAC evaluator, and the audit writer.

**Key Observations:**

- The data model is mostly present: service principals, project ownership, join tokens, workload certificates, and consumer rows already exist. The missing schema is a CA-key store and a few lifecycle indexes.
- The agent listener is strict mTLS for every path. There is no unauthenticated bootstrap route.
- `OPENVAULT_INTERNAL_CA` is a required public CA PEM file. No CA private key is loaded, stored, or checked for readiness.
- `OPENVAULT_CERT_TTL_DAYS` and `OPENVAULT_JOIN_TOKEN_TTL` are validated configuration but are not used by any workload-certificate code.
- The agent listener has a 15-second keep-alive and no per-request certificate revocation or principal-status check.
- No CSR/X.509 creation library is installed. `node:crypto` parses certificates but cannot build a PKCS#10 CSR or sign an X.509 certificate.
- The initial schema has `workload_certs.revoked_at` and `principals.status`, but nothing ties them together.
- No RBAC evaluator or audit writer exists; only the schema and docs define actions, roles, and events.
- The public API reference lists most admin identity routes but omits `GET /v1/admin/identities/:id`, which RD-05 adds as a Should Have.
- `docs/reference/cli.md` says `ov init` creates the CA; `docs/architecture/crypto.md` says the CA key is wrapped by the KEK; neither has a code path.

## Summary by Dimension

| # | Dimension | Findings | Highest Severity |
|---|---|---|---|
| 1 | Ambiguities | 1 | 🟠 MAJOR |
| 2 | Implicit Assumptions | 0 | — |
| 3 | Logical Contradictions | 2 | 🔴 CRITICAL |
| 4 | Completeness Gaps | 3 | 🟠 MAJOR |
| 5 | Dependency Issues | 2 | 🟠 MAJOR |
| 6 | Feasibility Concerns | 2 | 🔴 CRITICAL |
| 7 | Testability | 1 | 🟡 MINOR |
| 8 | Security Blind Spots | 3 | 🔴 CRITICAL |
| 9 | Edge Cases | 2 | 🟠 MAJOR |
| 10 | Scope Creep Indicators | 0 | — |
| 11 | Ordering & Sequencing | 0 | — |
| 12 | Consistency | 0 | — |
| 13 | Codebase Alignment | 0 | — |

Counts use each finding's primary dimension. Codebase alignment is cited as related evidence throughout.

## Summary by Severity

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 4 | All resolved |
| MAJOR | 8 | All resolved |
| MINOR | 4 | All resolved |
| OBSERVATION | 0 | — |

## Independent Challenge

One independent design challenger reviewed the complete critical/major batch with the codebase context, without the parent's preferred choices. It converged on the parent's recommendation for PF-001 through PF-009 and PF-012. It diverged on PF-010: it preferred splitting or inverting the dependency so RD-06's policy foundation lands before RD-05, while the parent's smaller option is a narrow identity-authorization helper in RD-05. It also diverged on PF-011: it preferred an audit port in RD-05, while the parent prefers moving the audit assertion to RD-07 because a port without a writer does not provide the stated audit guarantee. Both divergences are recorded rather than silently resolved. For PF-012, the challenger returned `Justified` for `@peculiar/x509` and required direct user approval.

`Confidence:` High for PF-003, PF-004, PF-005, PF-006, PF-007, PF-009, PF-012; Med for PF-010 and PF-011. `Hardening:` Challenger converged except PF-010 and PF-011; both divergences are retained in their findings.

## Findings

### PF-001: `/v1/agent/join` is unreachable behind the mandatory client-certificate agent listener [🔴 CRITICAL]

**Dimension:** 3 — Logical Contradictions (related: 6 Feasibility, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:26, 69-72, 123`; `RD-02-transport-config-readiness.md:24-25, 105-106, 163-164`
**Codebase Evidence:** `apps/server/src/transport/secure-application.ts:180-185` sets `requestCert: true`, `rejectUnauthorized: true`, and `ca: [tls.caPem]` for the agent listener. `apps/server/src/transport/scope.ts:86-94` permits `/v1/agent/*` only on that listener; the admin listener explicitly excludes it. `apps/server/tests/integration/transport.spec.test.ts:177-203` proves a missing client certificate is rejected at the TLS handshake.

**The Problem:** A new agent has no certificate, so it cannot reach the endpoint that issues its first certificate. If the listener is relaxed globally, every agent route loses the transport-level guarantee unless a route guard is perfect. If join moves to the admin listener, the documented network split and the agent's `OPENVAULT_URL` at port 8444 are broken. Acceptance 4 cannot pass.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add a dedicated join listener/port, leaving the agent listener strict. | Clean handshake boundary; no unauthenticated path on 8444. | New port, config, Compose surface, readiness, and operational rule. |
| B | Keep 8444, set `rejectUnauthorized: false`, and enforce a verified certificate in middleware for every route except join. | Smallest change; keeps the two-listener network model. | Weakens the handshake-level guarantee; requires exhaustive route tests and a default-deny middleware. |
| C | Serve join on the admin listener behind the proxy. | No new listener. | Contradicts the agent network model; proxy sees all agents as one source address for rate limiting. |

**Recommendation:** Option B. It is the smallest change that preserves the two-listener model, and the per-request agent authentication required by PF-005 already has to run in middleware. The listener must reject any request when `socket.authorized !== true`, except the single join route, and must test every agent route.

**User Decision:** Resolved — User chose Option B (route guard on 8444).

---

### PF-002: The CA private key has no storage, loading, readiness, or backup/rotation path [🔴 CRITICAL]

**Dimension:** 6 — Feasibility Concerns (related: 11 Ordering, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:29, 36-37, 102, 126`; `RD-02-transport-config-readiness.md:79, 117`; `RD-13-backup-rotation-ops.md:28, 96-102`
**Codebase Evidence:** `apps/server/src/transport/tls.ts:78-121` reads only `OPENVAULT_INTERNAL_CA` as a public certificate and keeps only the server leaf key. `apps/server/src/config/loader.ts:259-261` requires the CA file at startup. `apps/server/src/main.ts:12-28` loads TLS material before migrations. No `ca_keys` table exists in `apps/server/migrations/20261030094203_initial.up.sql` or `apps/server/src/database/schema.ts`. `packages/core/src/keyring.ts:22-36` accepts only 32-byte symmetric KEKs. `docs/architecture/crypto.md:5-12, 58-63` and RD-13 say the CA key is wrapped by the KEK and re-wrapped on rotation.

**The Problem:** The server cannot sign a CSR. There is no place to put the CA private key, no component that loads it, and no readiness check that it matches `OPENVAULT_INTERNAL_CA`. The phrase “generated at init” has no owner: `docs/reference/cli.md:21` says `ov init` creates the CA, but `ov init` is RD-11/RD-13, while RD-05 depends only on RD-02/RD-03 and its startup requires the CA file before migrations. A literal implementation must use a plaintext CA-key file, add an undefined database table, or put the key beside the KEK in the keyring file. Each option contradicts either RD-05, RD-02, or RD-13, and `/ready` can stay green while certificate issuance is broken.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add a KEK-wrapped `ca_keys` table and a `CaSigner` service; pre-provision CA material through `ov init`/RD-13 and validate it at startup and readiness. | Matches the documented key hierarchy and the existing `signing_keys` pattern; supports KEK rotation and backup. | New table, signer, readiness probe, init dependency, and backup/restore work. |
| B | Add an encrypted CA-key file and a configuration variable. | Simple; operator-visible. | Not KEK-wrapped; contradicts crypto docs and RD-13; separate backup/rotation path. |
| C | Extend the keyring file with a CA section. | No database table. | Co-locates KEK and CA key; the keyring parser accepts only 32-byte keys; no lifecycle. |

**Recommendation:** Option A, narrowed to RD-05's responsibility: RD-05 owns the `ca_keys` store and `CaSigner`; CA generation/provisioning is a prerequisite owned by the init/operations flow (RD-11/RD-13), and RD-05's acceptance uses a test CA fixture. `OPENVAULT_INTERNAL_CA` remains the public certificate file. The CA profile, startup match check, readiness probe, and RD-13 re-wrap/restore integration must be explicit.

**User Decision:** Resolved — User chose Option A with `ov init`/RD-13 provisioning.

---

### PF-003: The CSR is not bound to the token identity and can request an attacker-shaped certificate [🔴 CRITICAL]

**Dimension:** 8 — Security Blind Spots (related: 1 Ambiguities, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:26-30, 69-70, 121-125, 135-137`
**Codebase Evidence:** `join_tokens.principal_id` and `project_id` are the only identity binding (`apps/server/migrations/20261030094203_initial.up.sql:111-120, 342`). `workload_certs` stores `principal_id`, `serial`, `fingerprint`, and validity (`:195-204`). No CSR/X.509 library is installed; `node:crypto` parses certificates but cannot verify a PKCS#10 CSR or construct an X.509 certificate. RD-10's Compose environment does not give the agent a principal id.

**The Problem:** RD-05 says the CSR CN is the principal id and the SAN URI is `openvault://identity/<id>`, but it does not say whether the server validates, overwrites, or copies the CSR subject, SANs, and extensions. A valid join token for identity A can request identity B's CN/SAN, extra SANs, `CA:TRUE`, or an unknown critical extension. If the server signs the CSR as-is, the certificate can impersonate another principal or become a subordinate CA. The agent also has no defined way to know the principal id before join, so a strict CSR check is impossible. Proof of possession is not required. Fingerprint and serial formats are not specified, and “stores only serial and fingerprint” conflicts with expiry and revocation storage.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Treat the CSR only as a public-key container. Derive CN/SAN/principal from the token, verify the CSR signature, reject requested SAN/CA/EKU extensions, and build a fixed `CA:FALSE`, `clientAuth` profile. Store principal, serial, SHA-256 fingerprint, validity, and revocation; return the assigned identity. | Closes impersonation and subordinate-CA paths; the agent needs no pre-known identity id; one deterministic profile. | Requires a library that can build certificates and explicit validation; standard CSR generators always add a subject. |
| B | Pass the principal id out of band and require exact CSR CN/SAN, while still rejecting dangerous extensions. | Better client validation and error messages. | Two identity sources; the agent needs new configuration; more validation code. |
| C | Sign the CSR as-is after checking CN/SAN. | Smallest. | Attacker-controlled SAN/extensions and no proof of possession; not acceptable. |

**Recommendation:** Option A, with a fixed profile: `CN = token principal`, exactly one SAN URI `openvault://identity/<principal>`, `basicConstraints CA:FALSE` critical, `keyUsage digitalSignature`, `extendedKeyUsage clientAuth`, random 128-bit serial, and SHA-256 fingerprint over DER in lowercase hex. Accept an empty or arbitrary CSR subject, but reject any requested identity, SAN, CA, or EKU extension. Add acceptance tests for another CN/SAN, extra SAN, `CA:TRUE`, an unknown critical extension, a bad CSR signature, and an RSA key.

**Decision:** Resolved — delegated Option A applied (see D-003).

---

### PF-004: Revoking a service identity does not revoke its certificates, and renew can extend a disabled identity [🔴 CRITICAL]

**Dimension:** 8 — Security Blind Spots (related: 3 Contradictions, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:20-23, 31-35, 46, 140`
**Codebase Evidence:** `principals.status` and `disabled_at` are in `apps/server/migrations/20261030094203_initial.up.sql:140-149`; `workload_certs.revoked_at` is separate (`:195-204`). The only foreign key is `ON DELETE CASCADE`; disabling is an update, so no cascade fires. `docs/reference/roles.md:17` defines `identity.revoke` as “Disable an identity and revoke its credentials.” RD-05 makes bulk certificate revocation only a Should Have and says the listener checks certificate revocation, not principal status.

**The Problem:** If revoke sets only `principals.status='disabled'`, every certificate row remains unrevoked and the agent listener accepts the certificate until expiry. Renew also succeeds because it only requires the current certificate. The operator sees “revoked” while the credential remains usable. If the listener checks principal status but not certificates, a certificate-specific problem remains; if it checks certificates but not status, a missed row leaves access. The Must Have five-second revocation guarantee depends on a Should Have and on an implementation choice that is not specified.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Make identity revoke one transaction: disable the principal, revoke every unexpired certificate, and invalidate every unused join token; also check principal status on the listener and renew. | One meaning for revoke; no orphaned credential; defense in depth. | Bulk update; needs `join_tokens.revoked_at` and an index; a partial failure must roll back. |
| B | Keep disable separate and check principal status per request; certificate revocation remains separate. | One-row update; immediate if every route checks status. | Does not revoke the credential itself; `workload_certs.revoked_at` can diverge; re-enable restores old certs. |
| C | Require per-certificate revocation. | Granular. | An identity revoke no longer means revoke; easy to miss a certificate. |

**Recommendation:** Option A, with B as defense in depth. Add `join_tokens.revoked_at`; use one transaction; set `workload_certs.revoked_at` for every unexpired row; reject disabled principals and soft-deleted projects on the listener and renew. Add acceptance tests for a new connection, a renew attempt, and an unused join token after revoke.

**Decision:** Resolved — delegated Option A applied (see D-004).

---

### PF-005: Revocation timing and connection reuse can bypass the five-second guarantee [🟠 MAJOR]

**Dimension:** 9 — Edge Cases (related: 3 Contradictions, 8 Security)
**Location:** `RD-05-service-identities-mtls.md:33-35, 84, 140`
**Codebase Evidence:** `apps/server/src/transport/secure-application.ts:180-185` validates the client certificate only at the TLS handshake. `:56-61` sets the agent listener keep-alive to 15 seconds and request timeout to 30 seconds. There is no application-layer agent middleware. TLS session resumption is not disabled.

**The Problem:** “Immediate,” “the next connection fails,” and “database row + 5-second cache” describe different guarantees. A positive cache populated before revocation can accept a connection made one second after the revocation commits. An already-open keep-alive or resumed connection can keep serving requests for at least 15 seconds, and longer while active, because no per-request revocation check occurs. The requirement does not say whether rejection is a TLS alert or an HTTP 401/403; RD-10 treats 401/403 as “remove files and exit,” while a TLS/network error is treated as transient and keeps last-known-good files.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Check fingerprint, certificate validity, revocation, principal status, and project status on every agent request; cache for at most 5 seconds; invalidate on revoke; define a 401 rejection; disable resumption. | Meets the bound for new and existing connections; covers disabled identities and deleted projects. | Per-request lookup or cache; a new failure mode. |
| B | Cap agent connection lifetime below 5 seconds and disable resumption. | Simpler listener. | More handshakes; an active request can still finish; does not define application rejection. |
| C | Track and destroy sockets by fingerprint on revoke. | Immediate in one process. | Does not cover another process, resumption, or expiry; needs a socket registry. |

**Recommendation:** Option A. Define the guarantee as “no request succeeds more than five seconds after revocation commits,” not “the next connection.” Test a new connection and a reused keep-alive connection. Return a stable 401 `authentication_required`; use 503 on a database/cache failure so the failure mode is explicit and fail-closed. Document the limitation that secrets already delivered cannot be retracted; rotate the values.

**Decision:** Resolved — delegated Option A applied (see D-005).

---

### PF-006: Join-token consumption is not atomic, and the “wrong-project” acceptance case has no input [🟠 MAJOR]

**Dimension:** 9 — Edge Cases (related: 8 Security, 7 Testability)
**Location:** `RD-05-service-identities-mtls.md:24-25, 63-72, 133-134`
**Codebase Evidence:** `join_tokens` has `token_hash`, `used_at`, and `expires_at` (`apps/server/migrations/20261030094203_initial.up.sql:111-120`). The unique `token_hash` index does not make a read-check-update sequence atomic. The join request is `{ token, csr, consumer }` and has no project or identity parameter. `join_tokens(principal_id, project_id)` already references `principals(id, owner_project_id)` (`:342`).

**The Problem:** Two concurrent joins can both read `used_at IS NULL`, both sign, and both insert certificates; one single-use token yields multiple credentials. A crash after signing but before `used_at` leaves the token reusable; a crash after `used_at` leaves an orphan certificate. Acceptance 3 says a “wrong-project” token fails at join, but the join contract has no project input and the composite foreign key already prevents a token from targeting a different identity/project. The meaningful cross-project test belongs to the admin token-issuance route. Join-token log redaction and the generic failure body are also unspecified.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Claim the token with a conditional `UPDATE ... SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING ...` inside the certificate/consumer/audit transaction; return a generic 401 for all token failures; move the cross-project check to issuance; add a captured-log test. | Atomic; one meaning for single use; no token oracle; matches the existing foreign key. | Requires a transaction and a defined token format/hash. |
| B | Add an explicit project/identity claim to the join request and compare it. | Makes “wrong project” explicit. | Redundant with the token binding; more surface; can leak existence. |
| C | Serialize with an application mutex per token. | Simple in one process. | Fails across restarts and multiple processes; not a durable security control. |

**Recommendation:** Option A. Define the token as 32 random bytes encoded as 43-character base64url; store SHA-256 over the decoded bytes; claim it atomically; insert the certificate, consumer row, and audit event in the same transaction; return 401 `join_failed` for unknown/expired/used/revoked/disabled tokens. Reword Acceptance 3 to test expired/used/unknown at join and cross-project token issuance at the admin route. Add a captured-log test with a sentinel token. The acceptance wording change is part of the pending acceptance-alignment decision.

**Decision:** Resolved — atomic claim and generic errors applied; acceptance 3 now uses 200 and moves the cross-project check to issuance.

---

### PF-007: Fixed 30-day validity and 20-day renewal contradict `OPENVAULT_CERT_TTL_DAYS` [🟠 MAJOR]

**Dimension:** 3 — Logical Contradictions (related: 12 Consistency, 7 Testability)
**Location:** `RD-05-service-identities-mtls.md:29, 76, 80, 83, 113, 135-136, 141-142`; `RD-02-transport-config-readiness.md:90`
**Codebase Evidence:** `OPENVAULT_CERT_TTL_DAYS` is validated in `apps/server/src/config/loader.ts:302` with default 30 and range 1–90; `apps/server/src/config/types.ts:52` exposes `certTtlDays`; `docs/reference/configuration.md:29` documents it. RD-05 hardcodes 30 days and 20 days.

**The Problem:** With a 7-day TTL, the 20-day renewal point is after expiry. With a 90-day TTL, day 20 is about 22% of lifetime, not two thirds. Acceptance 4 asserts 30 days even when the operator sets a supported different value. The config is either ignored or the acceptance test fails. The renewal threshold must be derived from the issued certificate's actual validity, not the number 20.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Honor `OPENVAULT_CERT_TTL_DAYS` (default 30); issue `not_after = not_before + ttl`; allow renewal at `not_before + floor((not_after - not_before) × 2/3)`; test 1, 30, and 90 days with an injected clock. | One source of truth; correct for every supported TTL. | Acceptance values become parameterized. |
| B | Remove the configuration and fix agent certificates at 30 days. | Simple. | Removes a documented operator control; requires RD-02/config/docs changes. |
| C | Fix agent certificates at 30 days and scope the config to other certificates. | No RD-05 behavior change. | The config is currently unused elsewhere; misleading name and dead setting. |

**Recommendation:** Option A. The configured default remains 30 days. Use the certificate's actual `not_before`/`not_after` for the renewal gate, and include the 30-second clock-skew allowance from RD-02. Update Acceptance 4 and 8 to assert the configured value and the derived threshold.

**Decision:** Resolved — delegated Option A applied (see D-007).

---

### PF-008: Renewal is underspecified: “current” certificate, fresh key, multiple active certificates, and the agent trigger [🟠 MAJOR]

**Dimension:** 1 — Ambiguities (related: 4 Completeness, 9 Edge Cases)
**Location:** `RD-05-service-identities-mtls.md:31-32, 74-84, 117, 141-143`
**Codebase Evidence:** `workload_certs` has no current flag and allows multiple rows per principal (`apps/server/migrations/20261030094203_initial.up.sql:195-204`; index at `:377`). RD-10 owns agent certificate/key storage and refresh but has no renewal trigger or retry requirement. An expired certificate cannot complete mTLS, so it cannot call renew.

**The Problem:** “Current certificate” can mean the newest issued certificate or any valid certificate. If any valid certificate may renew, a stolen old certificate can renew indefinitely and extend a compromise. If only the newest may renew, a lost renewal response leaves the agent unable to renew again. The request/response shape is missing: fresh CSR or reused key, new consumer metadata, early-renewal error, retry behavior, and expired-certificate recovery. A second join can create another active certificate, and the admin view has no inventory.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Only the newest unexpired, unrevoked certificate may renew; renew carries a fresh EC P-256 CSR/key; the old certificate remains valid for data until expiry but cannot renew; add a retry-safe replay rule for the same public key; assign the agent trigger/retry to RD-10; cap active certificates. | Bounds old-certificate extension; rotates a compromised key; supports retry. | More state and a replay rule; the agent must generate a new key. |
| B | Only the newest certificate may renew, but reuse the current key. | Simpler. | A stolen key persists across renewals; still needs “newest” and replay rules. |
| C | Any valid certificate may renew without a new key. | Simplest. | Stolen old certificates renew forever; not acceptable. |

**Recommendation:** Option A for the server boundary. Define “current” as the newest unexpired, unrevoked `workload_certs` row by `issued_at` (tie-break by id). Renewal requires a fresh CSR and proof of possession; the old certificate remains valid for data until `not_after` but cannot renew. Add a retry-safe replay keyed by the public key for a short window so a lost response does not lock the agent out. RD-10 owns the agent's renewal trigger, jitter, retry/backoff, and atomic key swap; that ownership is part of PF-013. Expired certificates require a new join token.

**Decision:** Resolved — server behavior and replay applied; RD-10 now owns the agent trigger/retry and reuses the pending key.

---

### PF-009: The admin identity lifecycle has no complete contract, and `GET /:id` is absent from the API [🟠 MAJOR]

**Dimension:** 4 — Completeness Gaps (related: 7 Testability, 12 Consistency)
**Location:** `RD-05-service-identities-mtls.md:20-23, 44-46, 58-61, 66, 124`; `docs/reference/api.md:142-145`
**Codebase Evidence:** `docs/reference/api.md:142-145` lists `GET/POST /v1/admin/identities`, `POST /:id/revoke`, and `POST /:id/join-tokens`, but not `GET /:id`. `packages/api-contract/src` has no identity schemas. `principals` has no unique `(owner_project_id, name)` for service identities; only `(id, owner_project_id)`. `consumers` has one row per principal; `workload_certs` allows multiple.

**The Problem:** RD-05 says an administrator can create, read, and revoke an identity and issue a join token, but defines only the join-token route. The create body/response, owner-project input, duplicate-name behavior, list/get response, revoke semantics, token TTL/response, and error codes are undefined. `GET /:id` is a Should Have but is absent from the published API. With multiple active certificates, “certificate serial and expiry” is ambiguous. A second join or scaffold run cannot reliably reuse an identity without a unique name, and a second join may hit the `consumers` unique constraint instead of upserting. The token-once response is not specified.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Define the full contract for create, list, get, revoke, and join-token; add strict schemas to `packages/api-contract`; add a partial unique `(owner_project_id, name) WHERE kind='service' AND status='active'`; return certificate and consumer arrays; add the missing route to the API reference. | Testable; idempotent scaffold; one contract; stable errors. | More requirement and schema work. |
| B | Define only join-token and revoke; leave create/list/get to the plan. | Smaller. | The plan can guess; acceptance 1 and 10 have no contract; docs drift. |
| C | Publish OpenAPI/JSON Schema only. | Strong machine contract. | Does not decide semantics; still needs A's decisions. |

**Recommendation:** Option A. Use `POST /v1/admin/identities {name, projectId}`, `GET /v1/admin/identities` with project scoping, `GET /v1/admin/identities/:id` with `certificates` and `consumer`, `POST /:id/revoke` (idempotent 204), and `POST /:id/join-tokens {ttlSeconds?}` (default `OPENVAULT_JOIN_TOKEN_TTL`, max 24h) returning `{id, token, expiresAt}` once. Return `404 identity_not_found`, `409 identity_name_conflict`, `422 validation_error`, `401/403`, and `429`. Define join-token response and token format. Add the unique active service-name index and upsert behavior.

**Decision:** Resolved — delegated Option A applied (see D-009).

---

### PF-010: RD-05’s authorization and acceptance 11 depend on RD-06, which depends on RD-05 [🟠 MAJOR]

**Dimension:** 5 — Dependency Issues (related: 11 Ordering, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:7, 22-23, 59-61, 103, 144-145`; `RD-06-rbac.md:7, 27-28, 57-58, 94-99, 140`
**Codebase Evidence:** RD-06 depends on RD-05 and owns the 25-action catalog, including `identity.create`, `identity.read`, `identity.revoke`, and `identity.join_token`. No RBAC evaluator exists in `apps/server/src`; only the `role_assignments` schema and docs. `docs/reference/roles.md:51` grants `identity.read` to `auditor`; RD-05 says only org admins and owning project admins can read. RD-05 acceptance 11 duplicates RD-06 acceptance 4. RD-05 line 103 says RD-03 supplies project scoping, but RD-06 owns project scope.

**The Problem:** RD-05 cannot authorize its admin routes or verify the service-identity control-plane ceiling before RD-06, while RD-06 cannot start without RD-05. If RD-05 hardcodes role checks, it duplicates the RBAC oracle and can drift; if it skips them, the routes are unprotected. The auditor read rule conflicts with the published matrix. A project administrator with an org-scope assignment is wrongly limited to one project. No data-plane grant is defined for a scaffolded service identity, so the agent can join and then receive 403 on every fetch.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Keep RD-05 next; add a narrow identity-authorization helper backed by `role_assignments` for `identity.*` and ownership; use the RD-06 matrix for auditor read; move acceptance 11 to RD-06; require the scaffold to grant an object-scope reader assignment. | Smallest; no roadmap reorder; one temporary identity slice. | Duplicates a small policy slice and can drift until RD-06. |
| B | Split RD-06: action catalog/evaluator/identity ownership before RD-05; assignments/grant guards/access-explain after. | One policy oracle; no duplication. | Roadmap split and larger planning change. |
| C | Invert the dependency: move the full RD-06 before RD-05. | Clean one-oracle design. | Large reorder; RD-06 is much larger than RD-05. |
| D | Hardcode org/project-admin checks in RD-05. | Fast. | Duplicates policy without the table or auditor rule; most drift-prone. |

**Recommendation:** Option A for the smallest viable step. Use the existing `role_assignments` table and the documented role matrix for the four identity actions; keep the helper replaceable by RD-06. Move acceptance 11 to RD-06 and the auditor-read test to RD-06. Require the RD-10 scaffold to grant object-scope `secrets.reader` assignments for the manifest entries, or explicitly document project-scope reader if that is the accepted limitation. The challenger preferred a split or inversion of RD-06 for a single policy oracle; the divergence is recorded.

**User Decision:** Resolved — User chose Option A (narrow identity helper; AC11 moved to RD-06).

---

### PF-011: Audit is a later dependency and RD-05 names no audit actions or failure behavior [🟠 MAJOR]

**Dimension:** 5 — Dependency Issues (related: 11 Ordering, 4 Completeness)
**Location:** `RD-05-service-identities-mtls.md:105, 133-134, 146-147`; `RD-07-audit.md:7, 22-24, 102-108, 136`
**Codebase Evidence:** No audit writer exists in `apps/server/src`; `audit_events` is used only by the readiness probe (`apps/server/src/readiness/service.ts:127`). RD-07 depends on RD-06, which depends on RD-05. RD-07’s event list includes identity create/revoke and join/renew, but not consumer changes. RD-05 acceptance 3 requires a failed join to be audited.

**The Problem:** RD-05 cannot satisfy “is audited” in its own phase. It does not name event actions, actor kind, result, reason code, details allowlist, or whether an audit failure fails the operation. The global audit chain serializes writes, and a consumer `last_seen` heartbeat on every refresh could amplify into the chain if it is audited. RD-05 says RD-07 audits consumer changes, but RD-07’s record list omits them and assigns consumer updates to RD-10.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Define an `AuditSink` port and named join/renew/revoke/consumer events in RD-05; RD-05 tests emission; RD-07 owns persistence, chain, and verification; add a same-transaction/fail-closed rule. | Tests the security boundary now; no reorder; event names do not drift. | The production sink does not exist until RD-07; a no-op sink would not audit. |
| B | Move the audit assertion to RD-07; RD-05 asserts only the 401; add event names to RD-07. | Smallest; honest dependency; no duplicate writer. | Failed joins are unaudited until RD-07. |
| C | Move RD-07’s audit writer/chain core before RD-05. | End-to-end evidence in RD-05. | Reorders a later feature; larger change. |

**Recommendation:** Option B for the smallest correct scope, with event names and actor/reason fields added to RD-07 for `agent.join`, `agent.renew`, `identity.create`, `identity.revoke`, `identity.join_token`, and consumer metadata changes. State that `last_seen` heartbeats are not audit events. The challenger preferred Option A to test emission early; Option A is viable if the user wants a recording sink and an explicit “RD-07 persistence pending” note. The parent recommendation remains B because a port without a writer does not provide the stated audit guarantee.

**User Decision:** Resolved — User chose Option B (move the audit assertion to RD-07).

---

### PF-012: PKCS#10 parsing and X.509 issuance require a new production dependency [🟠 MAJOR — COMPLEXITY ESCALATION]

**Dimension:** 6 — Feasibility Concerns (related: 5 Dependency, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:26-30, 125`
**Codebase Evidence:** `apps/server/package.json` has no X.509/CSR library. `apps/server/src/transport/tls.ts:1` uses `X509Certificate` only for parsing. `node:crypto` cannot construct a PKCS#10 CSR or sign an X.509 certificate. The test helper shells out to OpenSSL (`apps/server/tests/integration/helpers/tls.ts`), which RD-05 forbids in the product path.

**The Problem:** The requested feature cannot be implemented with the current dependencies. A custom ASN.1 implementation is unsafe; invoking OpenSSL from the server violates the “no shell” requirement and adds a runtime dependency. A vetted library is necessary, but adding it is a material external support surface. Auto-design cannot approve it.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add pinned `@peculiar/x509` with its ASN.1 peer packages and a thin shared wrapper. | Modern, WebCrypto-based, supports CSR verification and certificate generation; smallest safe option. | About a dozen transitive packages, a Reflect polyfill, ESM constraints, and dependency review. |
| B | Add `node-forge`. | Mature; CSR and certificate support. | Older, larger, CommonJS, its own crypto/ASN.1 surface; worse fit. |
| C | Invoke the OpenSSL CLI. | No new JavaScript tree. | Violates the no-shell rule; process/temp-file/key handling risk; not portable. |
| D | Implement ASN.1/PKCS#10/X.509 in-repo. | No dependency. | Custom crypto/ASN.1 parser is unacceptable for a security product. |

**Recommendation:** Option A. Exact-pin `@peculiar/x509` and its peer packages, import `reflect-metadata` once before any X.509 import, and expose only `parseAndVerifyCsr()` and `issueClientCertificate()` from a small shared module. Do not add a generic PKI framework, chain builder, CMS, CRL, or UI. Add tests for valid CSR, bad signature, wrong curve, extra SAN, `CA:TRUE`, expired CA, and exact profile.

**User Decision:** Resolved — User approved pinned `@peculiar/x509` 3.1.0; Complexity Gate verdict Justified.

#### Complexity Escalation Gate Packet

| Field | Value |
|---|---|
| Original goal | Service identities authenticate agents with short-lived mTLS certificates issued from a single-use join token, and revocation takes effect quickly. |
| Extra system or support code | One production dependency tree (about a dozen packages: `@peculiar/x509`, `@peculiar/asn1-schema`, related ASN.1 packages, `tsyringe`, `@peculiar/utils`, and a Reflect polyfill), plus a thin X.509 wrapper with two operations. The CA signer is separately required by PF-002; the library does not add a service by itself. |
| Why it may be needed | The join and renew flows must parse and verify a PKCS#10 CSR and construct/sign an X.509 certificate. Node’s `crypto` can parse certificates and sign bytes, but it cannot parse PKCS#10 or build X.509 certificates. |
| Evidence | `apps/server/package.json` has no X.509/CSR library; `tls.ts:78-121` parses only the CA certificate and has no signer; `node:crypto` has no CSR builder or certificate signer; RD-05 requires a vetted library and no shell. |
| Smallest solution that still works | Exact-pin `@peculiar/x509@3.1.0`, exact-pin the ASN.1 schema peer, add `reflect-metadata`, use Node `crypto` for EC P-256 keys and random serials, and expose only CSR parse/verify and fixed-profile certificate issuance. |
| Extra cost | Supply-chain review and ongoing CVE/upgrade tracking; a global Reflect polyfill and import-order constraint; ESM-only version constraint; API learning; roughly a dozen packages; plus the CA signer work in PF-002. |
| Independent verdict | **Justified** — the goal cannot be met without X.509 issuance, and a vetted library is the smallest safe solution. Conditions: exact pins, provenance/audit, thin wrapper, no shell, no in-repo ASN.1. |
| Direct user decision | Approved — pinned `@peculiar/x509` 3.1.0 |

---

### PF-013: Consumer metadata and agent-runtime ownership are split across RD-05 and RD-10 without one contract [🟡 MINOR]

**Dimension:** 4 — Completeness Gaps (related: 5 Dependency, 10 Scope)
**Location:** `RD-05-service-identities-mtls.md:38-39, 71, 86-98, 128, 143`; `RD-10-agent-compose.md:40-43, 94-102, 166`
**Codebase Evidence:** `consumers` has required `compose_project`, `compose_service`, `hostname`, `manifest_hash`, a unique `principal_id`, `first_seen`, `last_seen`, and `state` (`apps/server/migrations/20261030094203_initial.up.sql:88-99, 261-268`). RD-05 defines no refresh/heartbeat route. RD-10 owns agent certificate/key storage and refresh; its failure matrix keeps last-known-good files on network/5xx errors and removes files on 401/403.

**The Problem:** RD-05 accepts consumer metadata at join and says one row per identity, but the join sequence never inserts it; renew has no metadata field; “refresh” is not defined in RD-05; and a second join hits the unique constraint unless the handler chooses an upsert that is not specified. The `state` field is never updated. RD-05 also takes ownership of agent-side certificate storage and the `0600` state volume, which belongs to RD-10; a directory with mode `0600` is not traversable. Metadata is self-reported but the admin view does not say so, and `manifestHash` can be mistaken for verified integrity.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | RD-05 owns the strict consumer schema and join/renew upsert (preserve `first_seen`, replace metadata/`last_seen`, server sets principal/project); RD-10 owns agent storage and refresh/heartbeat/state; remove agent-runtime text from RD-05; label metadata self-reported. | Clear ownership; one row; RD-05 completes before RD-10. | Two documents must be updated; RD-10 must carry the refresh contract. |
| B | Add `PUT /v1/agent/consumer` called on join, renew, and refresh; RD-05 owns the route. | Explicit heartbeat; `state` current. | New route and RD-10 change. |
| C | Keep the duplicate text. | No rewrite. | Two owners; tests and behavior drift. |

**Recommendation:** Option A. Define a strict metadata schema with the table’s exact lengths and formats; reject unknown fields and principal/project override attempts with 422; upsert by `principal_id`; preserve `first_seen`; set `last_seen`; treat join/renew as RD-05 and refresh/heartbeat/state as RD-10. State that the state directory is `0700` and the certificate/key files inside are `0600`; move the agent storage and refresh half of Acceptance 9 to RD-10. Label `manifestHash` and consumer metadata as self-reported; do not use them for authorization. This is a consumer-contract change delegated to A; the RD-10 ownership split is pending.

**Decision:** Resolved — consumer contract applied; RD-10/RD-08 own the fetch/heartbeat/state path.

---

### PF-014: The renew rate limit has no numeric value, key, or acceptance test [🟡 MINOR]

**Dimension:** 7 — Testability (related: 1 Ambiguities, 8 Security)
**Location:** `RD-05-service-identities-mtls.md:40, 127, 132-146`
**Codebase Evidence:** AR-14 accepts 10/min join per IP but gives no renewal value. `apps/server/src/auth/login-rate-limits.ts` uses WebAFX `rateLimitMiddleware` for auth routes; no join or renew limiter exists. The limiter is process-local.

**The Problem:** “Renew per certificate” is a key, not a limit. It does not state the count, window, response, or whether certificate rotation resets the bucket. An implementation can omit the Must Have or choose any value, and no acceptance criterion catches it. Keying only by certificate lets an attacker reset the bucket by renewing; keying by principal bounds the amplification.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Join 10/min per source IP; renew 10/min per principal and 60/min per IP; 429 `RATE_LIMIT_EXCEEDED`; count rotation without resetting the principal bucket; add acceptance tests. | Bounds renewal amplification; stable key; testable. | New limiter values are a policy choice. |
| B | Renew 5/min per certificate. | Simple. | Rotation resets the bucket; no principal bound. |
| C | Rely on the renewal window; no limiter. | No code. | The Must Have is false; no abuse bound. |

**Recommendation:** Option A. Use the socket address on the agent listener; do not reuse the admin proxy-trust path. Document that the counters are process-local and reset on restart. Add join and renew 429 acceptance cases.

**User Decision:** Resolved — User approved join 10/min per IP; renew 10/min per principal plus 60/min per IP.

---

### PF-015: A service identity can still receive local, OIDC, browser, or CLI credentials [🟡 MINOR]

**Dimension:** 8 — Security Blind Spots (related: 4 Completeness, 13 Codebase Alignment)
**Location:** `RD-05-service-identities-mtls.md:20, 58-59`; `RD-03-human-auth-sessions.md:42-46, 131-135`
**Codebase Evidence:** `local_credentials`, `oidc_identities`, and `cli_sessions` all reference `principals(id)` with `ON DELETE CASCADE` and no `kind='user'` constraint (`apps/server/migrations/20261030094203_initial.up.sql:77-87, 121-134, 337-345`). RD-03 links OIDC by `(issuer, subject)` and has an admin linking path; RD-04 creates CLI families for any principal that passes local login.

**The Problem:** The requirement defines a service identity as “a principal with no password,” but nothing prevents a local credential, OIDC identity, browser session, or CLI family for a service principal. A bug or an admin path can turn a workload into an interactive account, breaking the non-human invariant and audit attribution. The service principal’s data-plane grants would then be available to a human.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Enforce at the schema/service layer: `local_credentials`, `oidc_identities`, and `cli_sessions` only for `kind='user'`; local/OIDC/CLI login and admin linking reject service principals. | One invariant at every path; testable. | Migration/trigger or application guards; existing bad rows must be cleaned. |
| B | Rely on RD-06’s control-plane cap and allow service principals to have human credentials. | No code. | Breaks the “no password” intent and audit attribution. |
| C | Add a distinct `kind` and block OIDC JIT only. | Partial. | Local/CLI paths remain open. |

**Recommendation:** Option A. Add acceptance tests that creating a local credential, linking an OIDC identity, or creating a CLI family for a service principal fails with 422; a service principal cannot complete browser or CLI login; and the audit actor for an agent is always `kind='service'` from mTLS.

**Decision:** Resolved — delegated Option A applied (see D-015).

---

### PF-016: Join-token and workload-certificate retention/cleanup is undefined [🟡 MINOR]

**Dimension:** 4 — Completeness Gaps (related: 10 Scope)
**Location:** `RD-05-service-identities-mtls.md:24-30, 97`
**Codebase Evidence:** `join_tokens` has only a `principal_id` index; `workload_certs` has only a `principal_id` index (`apps/server/migrations/20261030094203_initial.up.sql:368, 377`). No cleanup job exists. RD-04 established a 30-day/daily cleanup precedent for CLI sessions.

**The Problem:** Every join attempt and renewal leaves a row. A used or expired join token is retained forever; every renewal adds a certificate row. The tables and backups grow without bound. Deleting a revoked certificate before its `not_after` would silently un-revoke it, so a retention rule must be defined.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Join tokens: retain 24 hours after expiry or use, then delete; workload certificates: retain 30 days after `not_after` (or after revocation plus `not_after`, whichever is later), then delete; daily bounded cleanup; add `expires_at`/`not_after` indexes. | Bounded; safe revocation window; follows RD-04 precedent. | New job and indexes. |
| B | Keep forever. | No work. | Unbounded growth. |
| C | Delete inline on use/expiry. | Simple. | Loses history; may delete before `not_after` and un-revoke. |

**Recommendation:** Option A. Add a small retention section and acceptance test. This is a data-retention policy choice and is reserved.

**User Decision:** Resolved — User approved 24-hour token retention and 30-day certificate retention with daily cleanup.

---

## Delegated Decision Record

All rows use `Authority: AI — delegated by --auto-design`, `Policy version: 1`, and `Root invocation ID: rd05-preflight-2026-11-01T0950`. Eligibility is limited to implementation mechanisms inside the confirmed server-side service-identity and mTLS scope. Reserved decisions are not delegated.

| ID | Finding | Decision | Eligibility | Evidence | Rejected alternatives | Strongest counterargument | Confidence | Hardening | Reopen triggers |
|---|---|---|---|---|---|---|---|---|---|
| D-003 | PF-003 | Server-built certificate profile; CSR only proves possession; token is the identity source; SHA-256 fingerprint and random serial | Technical security mechanism within mTLS issuance | `join_tokens` has the only identity binding; `workload_certs` stores principal/fingerprint; no CSR library | Exact-match CSR with out-of-band identity; sign as-is | Standard CSR tools always add a subject; accepting arbitrary subject but rejecting identity/CA/EKU extensions preserves compatibility | High | Challenger converged | A client requires a non-empty subject or SAN in the CSR; a library cannot build a fixed profile |
| D-004 | PF-004 | One revoke transaction disables the principal, revokes every unexpired certificate, invalidates unused join tokens; listener/renew check status | Technical security mechanism within approved revocation scope | `principals.status` and `workload_certs.revoked_at` are independent; role docs define revoke as disable + revoke credentials | Status-only disable with per-request check; per-certificate revocation | A status-only check is simpler and allows re-enable, but leaves credential rows valid and misses routes | High | Challenger converged | A product decision adds a separate disable/re-enable action; a route cannot be covered by the status check |
| D-005 | PF-005 | Per-request fingerprint/revocation/status check with ≤5s cache, invalidate on revoke, stable 401, resumption disabled | Technical security mechanism within approved revocation scope | Agent keep-alive is 15s; listener checks only at handshake | Cap connection lifetime; close sockets only | Per-request cost; mitigated by 5s cache and 600/min data-plane limit | High | Challenger converged | Measured agent traffic makes the lookup too expensive; multi-process requires a shared revocation version |
| D-006 | PF-006 | Atomic conditional token claim in the certificate/consumer/audit transaction; generic 401; SHA-256 token hash | Technical concurrency and error-handling mechanism | `join_tokens.used_at` and unique hash; no transaction specified | Row lock; application mutex; explicit project claim | A row lock is also correct but holds a lock during signing; the conditional update is smaller | High | Challenger converged | A retry-safe join idempotency requirement is added; the token format changes |
| D-007 | PF-007 | Use `OPENVAULT_CERT_TTL_DAYS`; derive two-thirds renewal from actual `not_before`/`not_after`; 30-second skew | Technical consistency correction using existing config | Config default 30, range 1–90; current requirement hardcodes 30/20 | Remove config and fix 30; scope config to other certificates | A fixed 30-day policy is simpler but leaves a validated setting unused and breaks non-default TTLs | High | Challenger converged | Product decision fixes the lifetime at 30 days and removes the setting |
| D-008 | PF-008 | Server-side renewal: newest unexpired/unrevoked cert only; fresh CSR/key; old cert valid for data but cannot renew; retry-safe replay | Technical security mechanism within approved renewal scope | `workload_certs` has no current flag and allows multiple rows; expired cert cannot mTLS | Reuse key; any valid cert may renew | Fresh key adds CSR work and replay state; it bounds a stolen old certificate and key compromise | Med | Challenger converged; replay rule added | The agent cannot rotate keys; the replay window creates a security concern |
| D-009 | PF-009 | Full admin identity API contract; strict schemas; `GET /:id`; partial unique active service name; join-token response | Technical API/schema contract within identity scope | API reference lists most routes but omits `GET /:id`; no identity schemas; no unique service name | Join-token/revoke only; OpenAPI only | Full contract is larger but removes plan-time guessing and makes scaffold idempotent | High | Challenger converged | A roadmap decision defers list/get; the route style changes |
| D-013 | PF-013 | RD-05 owns strict consumer schema and join/renew upsert; RD-10 owns refresh/heartbeat/state; label metadata self-reported | Technical data-contract boundary | `consumers` unique principal; no refresh route; RD-10 owns agent refresh/storage | New `PUT /consumer`; duplicate text in both RDs | Moving refresh to RD-10 leaves `last_seen` stale between renewals; the boundary is still the smallest ownership fix | Med | Challenger converged on the contract; scope split is pending | The UI needs live `last_seen`/state before RD-10; a heartbeat becomes a security requirement |
| D-015 | PF-015 | Reject local/OIDC/browser/CLI credentials for service principals at schema/service layers | Technical enforcement of the approved no-password invariant | No `kind` guard on `local_credentials`, `oidc_identities`, `cli_sessions`; RD-03/04 login paths | Rely on RD-06 cap; OIDC-only guard | DB triggers add migration work; application guards can be bypassed by a future path, so both are preferred | High | No independent challenger needed (security enforcement within approved policy); in-context hardening | A legitimate use case requires a service principal to have an interactive credential |

## Reserved Decisions — Resolved

| Decision | Finding | User ruling |
|---|---|---|
| R1 — Join listener security model | PF-001 | Resolved — Option B: optional certificate on 8444 plus default-deny agent middleware |
| R2 — CA initialization and dependency owner | PF-002 | Resolved — Option A: `ca_keys` + `CaSigner`; `ov init`/RD-13 provisioning |
| R3 — RBAC ordering and scope | PF-010 | Resolved — Option A: narrow identity helper; AC11 moved to RD-06 |
| R4 — Audit acceptance and phase order | PF-011 | Resolved — Option B: audit assertion moved to RD-07 |
| R5 — X.509 dependency | PF-012 | Resolved — `@peculiar/x509` 3.1.0 approved; Complexity Gate Justified |
| R6 — Policy defaults | PF-006/PF-007/PF-013/PF-014/PF-016 | Resolved — agent runtime in RD-10; renew limits; 24h/30d retention; AC alignment |

## Iteration 2 — Bounded Re-scan

The first re-scan verified all 16 initial findings and found 17 follow-on issues. All are now resolved.

| Finding | Severity | Problem | Resolution |
|---|---|---|---|
| PA-201 | 🔴 CRITICAL | The agent had no data-plane fetch route on the agent listener; `last_seen`/state had no path. | The existing `/v1/data/:project/secrets/:name` route is exposed on the agent listener; the certificate principal's project is checked and the handler updates consumer state. |
| PA-202 | 🟠 MAJOR | Replay was evaluated after newest-only, so a lost renewal response could not be recovered; no cached certificate. | A process-local 5-minute replay cache keyed by principal + SHA-256(public key) is checked first; restart/after-window behavior is documented. |
| PA-203 | 🟠 MAJOR | CSR negative rules and acceptance disagreed on SAN/extension handling. | Arbitrary/empty subject accepted; requested SAN, basicConstraints, keyUsage/EKU, and unknown critical extensions are rejected; AC5/docs aligned. |
| PA-204 | 🟠 MAJOR | Org-scoped `project.admin`/auditor semantics were undefined and contradicted RD-06. | Org-scoped assignments cover every identity; project-scoped assignments are limited; RD-05/RD-06 acceptance updated. |
| PA-205 | 🟠 MAJOR | Token issuance/join could race a revoke or use an inactive principal/project. | Issuance/join require active state; join locks the principal and rechecks; revoke uses the same lock order; tests added. |
| PA-206 | 🟠 MAJOR | Readiness required a live agent chain and omitted the sign probe. | Readiness signs and verifies a test certificate; no live agent required; RD-02/docs updated. |
| PA-207 | 🟠 MAJOR | Agent rejection layer and duplicate disabled/project cases were ambiguous. | Protected routes return 401; DB/cache failure returns 503; soft-deleted project covered; no TLS-failure ambiguity. |
| PA-208 | 🟠 MAJOR | The agent retry could generate a new key and bypass replay. | RD-10 reuses the same pending key/CSR on retry and tests a lost response. |
| PA-209 | 🟡 MINOR | AC3 expected 201 while the contract returns 200. | AC3 now expects 200. |
| PA-210 | 🟡 MINOR | Consumer `state` was said to come from the request but is not an allowed field. | Join/renew set `ok`; the fetch path sets `degraded`/`failed`. |
| PA-211 | 🟡 MINOR | Admin consumer shape had no self-reported flag. | `selfReported: true` added to RD-05 and the API reference. |
| PA-212 | 🟡 MINOR | Auth guide said only serial/fingerprint are stored. | Guide now lists principal, serial, fingerprint, validity, and revocation state. |
| PA-213 | 🟡 MINOR | CaSigner exclusivity conflicted with RD-13 KEK re-wrap. | Exclusivity limited to signing; the rotation path may unwrap only to re-wrap. |
| PA-214 | 🟡 MINOR | RD-02 diagram still said the agent listener always requires a certificate. | Diagram now shows the token-join exception. |
| PA-215 | 🟡 MINOR | The rate-limit acceptance could not reach the per-IP renewal bucket. | The AC separates the principal bucket from an IP bucket tested across distinct principals. |
| PA-216 | 🟡 MINOR | Retention acceptance omitted post-expiry revocation. | AC12 includes `revoked_at + 30 days` and a post-expiry case. |
| PA-217 | 🟡 MINOR | RD-07 lacked fixed action strings. | RD-07 names `identity.create`, `identity.revoke`, `identity.join_token`, `agent.join`, `agent.renew`, `consumer.register`, and `consumer.update`. |

## Iteration 3 — Bounded Re-scan

The second re-scan verified all 17 follow-on findings and found seven minor issues. All are fixed; none required another design cycle.

| Finding | Severity | Problem | Resolution |
|---|---|---|---|
| PA-218 | 🟡 MINOR | RD-05/report/roadmap status was stale. | Report, RD-05, and roadmap updated atomically after the pass. |
| PA-219 | 🟡 MINOR | Config text said join-token TTL could only be shorter. | Corrected to “up to 24 hours.” |
| PA-220 | 🟡 MINOR | The data route compared a certificate's owner project (a principal field) to a project name. | Requirements now compare the certificate principal's `owner_project_id` to the id of the project named by `:project`. |
| PA-221 | 🟡 MINOR | The replay-cache restart limitation was not in the limitations list. | Added `docs/security/limitations.md` entry 25. |
| PA-222 | 🟡 MINOR | Failed-join rules omitted inactive principal/project. | RD-05 and RD-07 now include inactive principal/project. |
| PA-223 | 🟡 MINOR | Consumer-change audit acceptance omitted compose project. | RD-07 acceptance 12 now includes compose project. |
| PA-224 | 🟡 MINOR | RD-02 readiness “parsed and match” was undefined across three materials. | Readiness item 3 now separates server TLS key match from CA certificate parsing; item 6 owns the CA-key match. |

## Verdict

**✅ PASSED — all 16 initial findings and 24 re-scan findings are resolved. No accepted minors remain.** RD-05 may advance to `RD Preflighted` and proceed to plan creation.

## Decision Summary

| Finding | Severity | Recommendation | Decision |
|---|---|---|---|
| PF-001 | 🔴 CRITICAL | Optional certificate on 8444 plus default-deny agent middleware | Resolved — Option B |
| PF-002 | 🔴 CRITICAL | KEK-wrapped `ca_keys` + `CaSigner`; init flow owns generation | Resolved — Option A |
| PF-003 | 🔴 CRITICAL | Token-derived fixed certificate profile; CSR only proves possession | Delegated A applied |
| PF-004 | 🔴 CRITICAL | One revoke transaction + status checks | Delegated A applied |
| PF-005 | 🟠 MAJOR | Per-request revocation/status with ≤5s cache | Delegated A applied |
| PF-006 | 🟠 MAJOR | Atomic token claim + generic errors; move wrong-project to issuance | Delegated A applied; AC3 aligned |
| PF-007 | 🟠 MAJOR | Use configured TTL and derive two-thirds renewal | Delegated A applied |
| PF-008 | 🟠 MAJOR | Newest certificate only; fresh CSR; retry-safe replay | Delegated A applied; RD-10 owns agent retry |
| PF-009 | 🟠 MAJOR | Full admin contract + `GET /:id` + unique service name | Delegated A applied |
| PF-010 | 🟠 MAJOR | Narrow identity authorization in RD-05; move AC11 | Resolved — Option A |
| PF-011 | 🟠 MAJOR | Move audit assertion to RD-07; add event names | Resolved — Option B |
| PF-012 | 🟠 MAJOR | Approve `@peculiar/x509`; complexity verdict Justified | Resolved — approved |
| PF-013 | 🟡 MINOR | RD-05 consumer contract; RD-10 agent refresh/storage | Delegated contract applied; RD-10/RD-08 own fetch |
| PF-014 | 🟡 MINOR | Join 10/min IP; renew 10/min principal + 60/min IP | Resolved — approved |
| PF-015 | 🟡 MINOR | Block human credentials on service principals | Delegated A applied |
| PF-016 | 🟡 MINOR | 24h token / 30d certificate retention, daily cleanup | Resolved — approved |

## Next Step

RD-05 is preflighted and the roadmap row is advanced to `RD Preflighted`. Commit the requirements/docs changes on the `docs/rd-05-preflight` branch and open a PR. Create the implementation plan only after the preflight changes are integrated.

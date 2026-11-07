# Preflight Report: RD-02 Transport, Configuration, and Readiness

> **Status**: ✅ PREFLIGHT PASSED — all 18 findings resolved; CI verified in PR #54
> **Merged**: PR #54, commit `7d6fe4f` (2026-11-07)
> **Iteration**: 2 (fix verification and targeted re-scan)
> **Audit target**: `codeops/features/openvault-v0-1/requirements/RD-02-transport-config-readiness.md`
> **Artifact ref**: `sha256:54a72aef9f93b54a001fd5eba833d8ebb9daf52cb34f38f0c27770390613ed88`
> **Artifact git blob**: `cad93a4a2b2157248065337cfa102b03420557a6`
> **Codebase grounded**: 30 source/config/test files examined; 60+ references verified
> **Scope**: Strict target. The audit target is RD-02 only. RD-01, RD-05, RD-07, RD-08, RD-09, RD-13, the RD-02 plan, the API/configuration docs, and the shipped code are context.
> **Authorized modification set**: RD-02 only. PF-003 proposes a small test retarget outside the target; that expansion needs explicit confirmation.
> **Same-agent review**: The requirements document was drafted in an earlier session. The five dimension clusters and the challenger were independent subagents, but the same model family is still a residual bias risk. This is a security-sensitive transport contract; a human domain review is recommended before a production release.
> **Auto-design**: Not active. Findings are presented for user decision.
> **Challenger**: One independent challenger reviewed the Critical/Major batch; its verdicts are recorded in each finding and in the convergence note at the end.
> **User decision**: Apply all findings (2026-11-07)
> **Last Updated**: 2026-11-07

## Codebase Context Summary

**Tech stack:** Node.js >= 24.7, TypeScript 7 (strict ESM), pnpm 12, BlendSDK WebAFX 5.68.1 on Express 5, PostgreSQL 16/17, Zod 4, pino, Caddy 2.10, Docker Compose.

**Architecture:** One WebAFX application with a small `SecureWebApplication` adapter that owns two HTTPS listeners. The admin listener is proxy-CIDR guarded and serves `/v1/*` plus the static SPA. The agent listener accepts `POST /v1/agent/join` without a certificate and requires a live client certificate for every other route. The pre-stack installs correlation, CSP, scope, source, media-type, body-limit, parser, and error-mapping middleware before WebAFX routing. Readiness is a root `/ready` controller backed by parallel probes. The keyring is a plaintext JSON file with mode `0600`; the CA signing key is a KEK-wrapped `ca_keys` row.

**Key files examined:**

- `apps/server/src/config/{loader,types,parse,cidr,redact,webafx}.ts`
- `apps/server/src/transport/{secure-application,pre-stack,scope,proxy,tls}.ts`
- `apps/server/src/readiness/service.ts`, `apps/server/src/controllers/ready.ts`
- `apps/server/src/security/{keyring,clock,ca,x509,signing-keys}.ts`
- `apps/server/src/agent/{agent-middleware,agent-authenticator,agent-runtime,agent-join-service}.ts`
- `apps/server/src/controllers/{secrets,certificates,agent}.ts`, `apps/server/src/app.ts`, `apps/server/src/main.ts`
- `packages/core/src/{keyring,crypto}.ts`
- `deploy/compose/compose.yaml`, `deploy/compose/Caddyfile`
- `docs/reference/configuration.md`, `docs/reference/api.md`
- `apps/server/tests/config.spec.test.ts`, `tests/integration/{transport,readiness,agent-listener,agent-join,secrets,certificates-http}.spec.test.ts`, `tests/deploy.spec.test.mjs`

**Key observations:**

- WebAFX returns `{ success: false, error: { code, message, statusCode, timestamp, requestId, path } }`; `requestId` and `path` are inside `error`, not top-level.
- The shipped proxy default is loopback (`127.0.0.1/32,::1/128`), not the RD's `172.16.0.0/12`. Compose pins `172.30.0.2/32` on `admin_net`.
- The real secret and certificate routes are under `/v1/data`; `/v1/secrets` and `/v1/certificates` are not registered. The `/v1/data*` parser cap is 512 KiB; decoded product limits are 64 KiB for secrets and 128 KiB for certificate chains plus 16 KiB for private keys.
- The agent authenticator caches positive certificate state for 5 seconds; RD-05 explicitly approves the 5-second revocation bound.
- `CaSigner.load` validates `ca_keys` at startup (presence, unwrap, public-key match, CA constraints). `/ready` only runs a sign/verify probe with the loaded key; it does not re-read the row.
- The loader caps `OPENVAULT_SECRET_MAX_BYTES` at 65,536 and `OPENVAULT_CERT_MAX_BYTES` at 131,072; the RD advertises 1 MiB and 2 MiB.

## Summary by Dimension

| # | Dimension | Findings | Highest severity |
|---|---|---|---|
| 1 | Ambiguities | 2 | MINOR |
| 2 | Implicit Assumptions | 0 | — |
| 3 | Logical Contradictions | 6 | MAJOR |
| 4 | Completeness Gaps | 4 | MAJOR |
| 5 | Dependency Issues | 2 | MAJOR |
| 6 | Feasibility Concerns | 1 | MINOR |
| 7 | Testability | 5 | MAJOR |
| 8 | Security Blind Spots | 5 | MAJOR |
| 9 | Edge Cases | 2 | MINOR |
| 10 | Scope Creep Indicators | 2 | MAJOR |
| 11 | Ordering & Sequencing | 2 | MINOR |
| 12 | Consistency | 5 | MAJOR |
| 13 | Codebase Alignment | 4 | MAJOR |

## Summary by Severity

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 5 | All resolved |
| MINOR | 11 | All resolved |
| OBSERVATION | 2 | All resolved |

---

## MAJOR Findings

### PF-001: Default proxy CIDR is an unsafe trust boundary 🟠 MAJOR

**Dimension:** 8 — Security Blind Spots; 12 — Consistency; 13 — Codebase Alignment
**Location:** RD-02 lines 27–28, 92–93, 148, 173
**Codebase evidence:** `apps/server/src/config/loader.ts:20-23` (`DEFAULT_PROXY_CIDRS = "127.0.0.1/32,::1/128"`); `apps/server/src/transport/proxy.ts:10-15` (`BROAD_PROXY_DEFAULT`); `apps/server/src/transport/pre-stack.ts:345-350` (production warning if the broad range is configured); `docs/reference/configuration.md:47`; `deploy/compose/compose.yaml:177` (`172.30.0.2/32`).

**The Problem:** The RD documents `172.16.0.0/12` as the default. That range covers common Docker networks and can include `db_net` and `vault_net`. A peer inside it would be trusted for forwarded headers and direct admin traffic. If the RD were implemented literally, a compromised database or agent container could reach admin routes, spoof `X-Forwarded-For`/`Proto`/`Host`, and poison audit attribution. The shipped code deliberately defaults to loopback and warns when the broad range is selected, so there is no current runtime vulnerability — but the RD prescribes the unsafe behavior and is the normative artifact for a rebuild.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Change the RD default to `127.0.0.1/32,::1/128`; require an explicit proxy CIDR for multi-container deployments; add a negative AC for a peer inside `172.16.0.0/12` but outside the configured list | Matches code, docs, and Compose; preserves the admin boundary; fail-closed on misconfiguration | An operator who omits the variable in a multi-container deployment gets 403 until they set it |
| B | Keep `172.16.0.0/12` with a production warning | Preserves the old compatibility promise | Trusts the Docker private range, including database and agent containers; undermines the RD's own anti-spoofing rationale |

**Recommendation:** Option A. The warning is not a control; the RD must not prescribe trust of a range that includes the database network. **Confidence: High.** **Challenger:** severity MAJOR, not CRITICAL, because the shipped default is already loopback; resolution A is sound. **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-002: Error envelope shape contradicts WebAFX 🟠 MAJOR

**Dimension:** 3 — Logical Contradictions; 12 — Consistency
**Location:** RD-02 lines 34–36 and 187 (line 131 is already nested)
**Codebase evidence:** `apps/server/node_modules/blendsdk/dist/webafx/application/error-handler-middleware.js:20-31`; `docs/reference/api.md:13-24`; `apps/server/tests/integration/transport.spec.test.ts:24-31,199`.

**The Problem:** The RD shows a failure envelope with `requestId` and `path` after the `error` object on lines 34–36, implying top-level fields; line 131 already uses the nested form. WebAFX places both inside `error` and has no top-level copies. A client written from the RD reads `body.requestId` and gets `undefined`. The RD also contradicts its own AC 11 ("match the WebAFX envelopes") and the reference API doc.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Rewrite the RD to `{ success: false, error: { code, message, statusCode, timestamp, requestId, path } }` | Matches WebAFX, docs, and tests; one contract | None |
| B | Add top-level duplicates in a custom renderer | More ergonomic for clients | Forks the framework envelope and creates two sources of truth |

**Recommendation:** Option A. **Confidence: High.** **Challenger:** MAJOR as a client-contract defect; resolution A sound. **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-003: Body-limit contract is false for the real routes and the parser hard cap is 1 MiB 🟠 MAJOR

**Dimension:** 4 — Completeness Gaps; 7 — Testability; 8 — Security Blind Spots
**Location:** RD-02 lines 31–32, 150, 182–183
**Codebase evidence:** `apps/server/src/transport/pre-stack.ts:22-24,146-176`; `apps/server/src/app.ts:530-531`; `apps/server/src/controllers/secrets.ts:180`; `apps/server/src/secrets/envelope.ts:66-68`; `apps/server/src/certificates/pem.ts:89-95`; `apps/server/tests/integration/transport.spec.test.ts:398-430`.

**The Problem:** The RD says 64 KiB for secret routes and 128 KiB for certificate routes. The real routes are `/v1/data/:project/secrets...` and `/v1/data/:project/certificates...`; both receive the `DATA_BODY_LIMIT` of 512 KiB at the transport boundary. The 64 KiB branch applies only to the legacy `/v1/secrets*` path, which has no registered route; there is no certificate-specific transport branch. ST-22 posts to `/v1/secrets/x` and `/v1/certificates/x`; its "accepted" case asserts 404, proving only that nothing is mounted. The decoded product limits (64 KiB secret, 128 KiB certificate chain, 16 KiB private key) are enforced later by the services, so the data is still bounded, but the stated transport guardrail and its dedicated test are a false oracle. Separately, `express.json({ limit: "1mb" })` is the hard parser cap; a chunked request has no `Content-Length`, passes the precheck, and is buffered up to 1 MiB before the `verify` callback throws. Body parsing is before authentication, so this is unauthenticated buffering. The 512 KiB value is deliberate for worst-case JSON escaping of a 64 KiB value, but the 1 MiB hard cap is 2× the intended guard.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Update the RD to the layered model (512 KiB `/v1/data*` parser cap, 128 KiB other `/v1`, 64/128 KiB decoded product limits) and retarget ST-22 to the real routes | Matches shipped behavior and the documented rationale; the AC becomes a true oracle | Requires a test change outside the RD target |
| B | Enforce literal 64/128 KiB raw-body caps on the real paths | Closer to the current Must Have text | Rejects valid 64 KiB secrets with worst-case JSON escaping and valid certificate imports; breaks RD-08's sizing decision |
| C | A plus lower the parser hard cap from 1 MiB to 512 KiB and add a chunked-body test | Removes the unauthenticated 1 MiB buffer | Small code and test change; must confirm no route needs 512 KiB–1 MiB |

**Recommendation:** Option A for the RD finding, with the ST-22 retarget as a small, explicitly authorized test change; consider Option C as a separate hardening task if a 512 KiB hard cap is acceptable for every route. **Confidence: High** on the mismatch; **Medium** on the practical DoS severity (bounded, but 1 MiB × 1,024 connections is meaningful). **Challenger:** MAJOR, the strongest finding; do not treat AC8 as a true oracle; Option A is sound but incomplete without the test retarget; Option C is optional hardening. **Owner:** RD and tests; code only for Option C.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-004: Dependency and ownership are incomplete and circular 🟠 MAJOR

**Dimension:** 5 — Dependency Issues; 10 — Scope Creep; 11 — Ordering & Sequencing
**Location:** RD-02 lines 7, 24–25, 106–111, 121–129, 174–181
**Codebase evidence:** RD-05 line 8 (`Depends On: RD-02, RD-03`); RD-05 lines 246–262 (`ca_keys`, `CaSigner`, CA readiness); RD-08 line 7 and line 142 (secret handler); `apps/server/migrations/20261103141309_service-identities.up.sql:6` (`ca_keys`); `apps/server/src/main.ts:89-97`; `apps/server/src/agent/agent-runtime.ts:125-130`; `apps/server/src/app.ts:530-539`; `apps/server/src/readiness/service.ts:141-153`.

**The Problem:** RD-02 declares only RD-01, but it requires behavior owned by later RDs: `ca_keys`/`CaSigner` readiness (RD-05), the agent data route and project match (RD-08), per-request certificate policy (RD-05), and the age passphrase keyring (RD-13). RD-05 declares `Depends On: RD-02`, so the documented relationship is circular. The audit-table probe itself is not an RD-07 dependency because `audit_events` is created by RD-01's initial migration. As written, AC5 and AC7 cannot be satisfied when RD-02 is the current RD; the RD-02 plan explicitly deferred these items. The detailed certificate checks are also dual-owned with RD-05, which invites divergence.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Keep RD-02 as the transport/config RD; add a `Staged delivery` / `Integrates` table naming RD-05 (`ca_keys`, certificate policy), RD-08 (data route), and RD-13 (age/passphrase), with AC ownership; move policy sentences to references | Accurate, preserves the roadmap order, removes the cycle, keeps one owner per behavior | Requires careful cross-references |
| B | Add RD-05/RD-07/RD-08 to `Depends On` | Simple header change | Creates a cycle with RD-05 and contradicts the roadmap order |
| C | Split RD-02 into transport/config and readiness/agent parts | Clean separation | Over-splits a cohesive transport RD and adds a new artifact |

**Recommendation:** Option A. It is the smallest accurate correction and preserves the existing roadmap. **Confidence: High.** **Challenger:** MAJOR for traceability, no runtime impact; Option A sound; do not add a cycle. **Owner:** RD-02 plus cross-references in RD-05/RD-08/RD-13.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-005: TLS material invariants are missing from the requirement 🟠 MAJOR

**Dimension:** 4 — Completeness Gaps; 8 — Security Blind Spots; 13 — Codebase Alignment
**Location:** RD-02 lines 77–79, 125–126
**Codebase evidence:** `apps/server/src/transport/tls.ts:127-192`; `apps/server/src/config/loader.ts:430-438`; `docs/reference/configuration.md:21,94`.

**The Problem:** The RD says only "readable PEM certificate", "readable PKCS#8 key", and "readable PEM CA certificate". The shipped `TlsMaterial.load` additionally requires the leaf to be currently valid, signed by `OPENVAULT_INTERNAL_CA`, include the `openvaultd` DNS name, and cover the `OPENVAULT_BASE_URL` host; the CA must be currently valid, `CA:TRUE`, and self-verifying; the private key must match the certificate. An operator using a public/ACME certificate for the admin listener fails startup with rules the RD never states. The RD also says PKCS#8, while `createPrivateKey` accepts any PEM private-key format; the check is matching, not format.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add the invariants to the RD and change "PKCS#8" to "any readable PEM private key that matches the certificate"; document the internal-CA-only limitation | Matches code; prevents surprise startup failures; preserves the proxy trust design | Operators cannot bring a public certificate to the admin listener; document as deliberate |
| B | Relax the code to accept any valid leaf | Easier for public/ACME certificates | Breaks the proxy's internal-CA trust and the documented topology; weakens the boundary |
| C | Add a public-certificate trust path | Flexible | New config/deployment surface; out of scope for v0.1 |

**Recommendation:** Option A. **Confidence: High.** **Challenger:** MAJOR as an operator/provisioning contract; fail-closed, no security hole; also fix the PKCS#8 wording in the configuration reference. **Owner:** RD and docs.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

## MINOR Findings

### PF-006: `/ready` is said to re-check the wrapped CA key, but startup owns that check 🟡 MINOR

**Dimension:** 3 — Logical Contradictions; 7 — Testability
**Location:** RD-02 lines 121–129 (items 2, 3, 6), 179–181 (AC 7)
**Codebase evidence:** `apps/server/src/main.ts:51,89,122`; `apps/server/src/security/ca.ts:310-493`; `apps/server/src/readiness/service.ts:141-153`; `docs/reference/configuration.md:263-271`; `apps/server/tests/integration/readiness.spec.test.ts:127-148`.

**The Problem:** Item 6 and AC 7 imply `/ready` re-checks that the wrapped CA key is present, unwraps, and matches the public certificate. In production, a missing or mismatched row prevents startup; if the row is deleted after boot, `/ready` stays 200. The keyring probe can only fail after `destroy()`, so the "missing keyring" part of AC 7 is also unreachable. Only the PostgreSQL case is directly observable. The 2-second parallel timeout is not stated in the RD.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Reword readiness: startup is fail-closed for presence, unwrap, and match of the keyring and CA; `/ready` re-checks the loaded keyring, TLS objects, and sign/verify probe; document the 2 s parallel timeout and state that missing/mismatched material maps to startup failure | Matches shipped design; truthful; no new I/O | Runtime row deletion is not detected until restart |
| B | Add a `ca_keys` row probe to `/ready` (presence/status/lengths), without re-unwrapping | Detects row deletion at runtime | Adds a DB query to readiness; does not detect all mismatches |
| C | Re-unwrap and re-read files on every probe | Deepest check | Expensive, adds KEK access to the public readiness path, and contradicts the documented design |

**Recommendation:** Option A, with B as an optional deep-readiness enhancement. **Confidence: High.** **Challenger:** MINOR, not MAJOR; startup fails closed and the sign probe is the right runtime question; A sound. **Owner:** RD-02; cross-reference RD-05/RD-13 where the CA/keyring owners live.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-007: Configuration ranges and table are stale 🟡 MINOR

**Dimension:** 3 — Logical Contradictions; 12 — Consistency
**Location:** RD-02 lines 68–94 (especially 85–86)
**Codebase evidence:** `apps/server/src/config/loader.ts:475-476`; RD-08 lines 26,91,122,142; `docs/reference/configuration.md:9,28,35`.

**The Problem:** The RD allows `OPENVAULT_SECRET_MAX_BYTES` up to 1,048,576 and `OPENVAULT_CERT_MAX_BYTES` up to 2,097,152; the loader caps them at 65,536 and 131,072, matching RD-08's fixed 64 KiB secret value and the certificate chain bound. The table also omits `ENV_MODE`, which controls production error output and was added during the RD-02 plan's own correction. Later-RD variables (migration/auth/purge DB URLs, `OPENVAULT_RUN_MIGRATIONS`, certificate expiry, OIDC endpoint origins) are not marked as staged additions.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Narrow the ranges to 1024–65536 and 1024–131072; add `ENV_MODE`; mark later-RD variables as staged | Matches code and RD-08/RD-09; prevents rejected settings | Table grows |
| B | Widen the loader and database to the RD values | Honors the RD literally | Breaks RD-08's 64 KiB cap and the database constraints; weakens the DoS posture |

**Recommendation:** Option A. **Confidence: High.** **Challenger:** MINOR; fail-closed with a keyed error; A sound. **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-008: "Every request" ignores the approved 5-second positive cache 🟡 MINOR

**Dimension:** 3 — Logical Contradictions; 12 — Consistency
**Location:** RD-02 lines 108–110
**Codebase evidence:** `apps/server/src/agent/agent-authenticator.ts:9-12,131-140,194-197`; RD-05 lines 57–59, 281–286, 300, 463–464.

**The Problem:** The RD says fingerprint, expiry, revocation, principal status, and project status are checked "on every request". The authenticator caches a positive result for 5 seconds; misses are never cached. RD-05 explicitly approves the cache and states the observable guarantee: no request succeeds more than 5 seconds after revocation commits. The RD-02 wording overstates the guarantee and contradicts its owning RD.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Reword RD-02 to "checked on every request subject to the RD-05 ≤5 s positive cache; no request succeeds more than 5 s after revocation" | Matches code and RD-05; preserves the approved tradeoff | None |
| B | Remove the cache | Stronger immediate revocation | Adds a DB query per agent request; contradicts RD-05's approved decision |

**Recommendation:** Option A. **Confidence: High.** **Challenger:** MINOR; A sound. **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-009: Keyring passphrase is documented as supported but fails closed 🟡 MINOR

**Dimension:** 3 — Logical Contradictions; 10 — Scope Creep
**Location:** RD-02 lines 41–42, 76
**Codebase evidence:** `apps/server/src/config/loader.ts:409-429`; `docs/reference/configuration.md:19,259-261`; `packages/core/src/keyring.ts:117-132`; RD-13 lines 88,151.

**The Problem:** The table lists `OPENVAULT_KEYRING_PASSPHRASE_FILE` as an optional `0600` file, implying age-encrypted keyrings are supported. The loader rejects every value as unsupported until age encryption is implemented. The v0.1 keyring is plaintext JSON protected by `0600` and the host/backup boundary. "Zeroizes keys on rotation" is also misleading: rotation is an offline CLI operation with the server stopped; the server zeroes on shutdown or failed startup.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Mark the variable "reserved; must be unset in v0.1; setting it fails closed"; state that the v0.1 keyring is not encrypted at rest; reword zeroization to "on shutdown/failure; rotation is offline" | Honest; matches docs and code; keeps fail-closed | None |
| B | Implement age-encrypted keyrings now | Delivers the feature | New crypto dependency and scope; RD-13 owns it |

**Recommendation:** Option A. **Confidence: High.** **Challenger:** MINOR; fail-closed is safe but the RD is misleading. **Owner:** RD-02; RD-13 owns age encryption.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-010: Admin listener is not reachable only from the proxy 🟡 MINOR

**Dimension:** 3 — Logical Contradictions; 9 — Edge Cases
**Location:** RD-02 lines 23, 44–45, 104–105, 173
**Codebase evidence:** `apps/server/src/transport/pre-stack.ts:87-95`; `deploy/compose/compose.yaml:194-200`; `docs/reference/configuration.md:293-294`.

**The Problem:** The RD says the admin listener is reachable only from the reverse proxy and AC 4 says a connection outside the proxy CIDR is rejected. The source guard allows any loopback peer to call `/health` and `/ready` for container health checks. The exception is deliberate and low-risk (generic bodies, local only), but it is undocumented in the RD and AC 4 is literally false.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Document "loopback peers may call only `/health` and `/ready`" in the Listeners section and AC 4; state which listener owns `/health` | Truthful; preserves health checks | Slight wording complexity |
| B | Remove the exception and route health checks through the proxy | Stricter | Breaks the loopback Compose healthcheck and adds moving parts |

**Recommendation:** Option A. **Confidence: High.** **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-011: Port precedence and agent-port collision are undefined 🟡 MINOR

**Dimension:** 1 — Ambiguities; 12 — Consistency
**Location:** RD-02 lines 71–72
**Codebase evidence:** `apps/server/src/config/loader.ts:488-509,531-533`; `docs/reference/configuration.md:11-12,49-50`.

**The Problem:** The table presents `PORT` and `OPENVAULT_ADMIN_PORT` as independent variables that both default to 8443, with no statement that they control the same listener or that a differing pair is an error. It also does not say `OPENVAULT_AGENT_PORT` must differ from the resolved admin port.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Mark `PORT` as a compatibility alias that must match `OPENVAULT_ADMIN_PORT`; a conflict is an error; state the agent-port collision rule | Matches code and docs; removes ambiguity | None |
| B | Make them independent admin ports | Flexibility | Contradicts the single-admin-listener scope |

**Recommendation:** Option A. **Confidence: High.** **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-012: Clock-skew acceptance criterion is not observable for certificates 🟡 MINOR

**Dimension:** 7 — Testability; 9 — Edge Cases
**Location:** RD-02 lines 39–40, 189
**Codebase evidence:** `apps/server/src/security/clock.ts:1-25`; `apps/server/src/auth/cli-jwt.ts:140-165`; `apps/server/src/security/x509.ts:17-18,228-230`; `apps/server/src/agent/agent-authenticator.ts:146-153`.

**The Problem:** AC 13 says a token or certificate with more than 30 seconds of clock skew is rejected. CLI JWTs use an inclusive ±30 s window. Issued agent certificates are backdated 30 seconds at issuance, but certificate validity is evaluated against the server/DB clock with no additional grace. No endpoint accepts a client clock, so "a certificate with >30 s skew" has no observable input. The implemented contract is asymmetric.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Reword AC 13 to the actual contract: JWT ±30 s; agent certificates backdated 30 s at issuance and validated against server time with no extra grace; NTP required; move token/cert boundary tests to RD-04/RD-05 | Truthful and testable | Cross-RD references |
| B | Add a client-clock input to certificate validation | Enables the literal test | New attack surface; no protocol carries it |

**Recommendation:** Option A. **Confidence: High.** **Owner:** RD-02 with RD-04/RD-05 cross-references.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-013: Startup ordering and partial-bind cleanup are not requirements 🟡 MINOR

**Dimension:** 4 — Completeness Gaps; 11 — Ordering & Sequencing
**Location:** RD-02 lines 168–172
**Codebase evidence:** `apps/server/src/main.ts:49-58,89-134`; `apps/server/src/transport/secure-application.ts:241-250,294-333`.

**The Problem:** The RD only requires config/TLS failures to exit before binding. The shipped order is config → keyring → TLS → migrations → DB/runtimes including CA → prepare → bind admin then agent; a failed agent bind closes both servers and destroys the keyring; a failed after-start hook calls `stop()`. Because the order and cleanup are absent, the safety property "no half-bound listener, no half-loaded keyring" is not a requirement.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add one outcome AC: no listener binds until config/keyring/TLS/migrations/CA succeed; a failed start exits non-zero and leaves no bound listener; the keyring is zeroed | Testable; protects against future reordering | Does not prescribe internal order (good) |
| B | Leave the exact order to the plan | Less RD detail | The safety property remains implicit |

**Recommendation:** Option A (outcome-level, not a brittle sequence). **Confidence: High.** **Challenger:** MINOR/OBSERVATION; A is a small outcome AC. **Owner:** RD.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-014: `ov config show --redacted` is orphaned 🟡 MINOR

**Dimension:** 4 — Completeness Gaps; 5 — Dependency Issues
**Location:** RD-02 line 54
**Codebase evidence:** `apps/cli/src/commands/index.ts:20-38` (no `config` command group); `apps/server/src/config/redact.ts:21` (`toRedactedConfig` exists); `apps/server/src/ops/config.ts:40`; the RD-02 plan defers the CLI surface to RD-11; RD-11 does not claim it.

**The Problem:** A Should Have requirement has no owner and no implementation. The redacted-config function exists and is tested, and the backup manifest uses it, but the promised CLI surface was never added. The requirement silently disappears.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add a thin `ov config show --redacted` command using `toRedactedConfig(loadConfig(process.env))` | Delivers the support workflow; small | Adds a CLI command outside the RD target |
| B | Move the requirement to RD-11 or RD-13 and record that the backup manifest is the current support dump | Keeps RD-02 focused; no code | The promised command remains absent |

**Recommendation:** Option B for the RD-02 audit; Option A if the support workflow still needs a standalone command. **Confidence: Medium-High.** **Owner:** RD-02 and RD-11/RD-13.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-015: Agent listener scope admits all `/v1/data/*` methods 🟡 MINOR

**Dimension:** 8 — Security Blind Spots; 13 — Codebase Alignment
**Location:** RD-02 lines 106–107
**Codebase evidence:** `apps/server/src/transport/scope.ts:93-99`; `apps/server/src/controllers/secrets.ts:121-131`; `apps/server/src/app.ts:530-531`.

**The Problem:** The RD says the agent listener serves the agent-scoped `GET /v1/data/:project/secrets/:name` route. The listener scope actually permits the entire `/v1/data` and `/v1/data/*` namespace for every method, including certificate import/delete/purge and secret list/create/update/delete. Today there is no bypass because the controllers call `principal(req)` without `allowAgent` for every route except the value read, so an agent certificate gets 401. But the restriction is a controller-level convention, not the listener scope table; a future route that omits the convention would be exposed on the agent listener.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Narrow the scope table to `GET /v1/data/:project/secrets/:name` (plus the exact join and health routes) | Defense in depth; the boundary is explicit | Needs a pattern matcher and tests |
| B | Keep the prefix and add a negative test that every other `/v1/data` route rejects an agent certificate; document the convention | Small; catches regressions | The scope table remains broader than the RD |

**Recommendation:** Option B now; Option A if the scope table is extended. **Confidence: High** on the gap; **Medium** on urgency. **Owner:** RD and tests; code optional.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-016: Acceptance coverage is incomplete and some tests skip silently 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** RD-02 AC 4, 10, 14, 15
**Codebase evidence:** `apps/server/tests/integration/transport.spec.test.ts:182-207,373-396` (`it.skipIf(trustedHost === undefined)`); `transport.spec.test.ts:464-491` (ST-24 covers malformed JSON and unknown route, not a thrown internal error); `apps/server/tests/keyring.spec.test.ts:78-115` (serialization/inspection, not zeroization); no production 500 leak test.

**The Problem:** AC 4 and AC 6 are conditional tests that silently pass with zero assertions on loopback-only hosts. AC 10 has no direct test for a thrown internal error; ST-24 does not assert a production 500 body lacks stack/SQL/path. AC 14's zeroization half is code-review only; the destroy test asserts `loaded === false`, not that the captured key buffer is zeroed. AC 15 is a summary sentence that cannot fail independently and names no verification.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add deterministic tests: non-proxy source 403, loopback health 200, production 500 body has no sentinel, captured key buffer zeroed after destroy; replace AC 15 with "verified by the RD-14 suite plus AC1–AC14" | Each AC becomes a true oracle | Test work outside the RD target |
| B | Narrow the ACs and rely on RD-14 for the cross-cutting checks | Smaller | Leaves gaps untested |

**Recommendation:** Option A for the testable gaps; cross-reference RD-14 for the release-wide security suite. **Confidence: High** for AC10/AC14; **Medium** for AC15. **Owner:** tests and RD-14.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

## OBSERVATION Findings

### PF-017: CSP profiles are not documented 🔵 OBSERVATION

**Dimension:** 8 — Security Blind Spots; 1 — Ambiguities
**Location:** RD-02 lines 29–30, 184–185
**Codebase evidence:** `apps/server/src/transport/pre-stack.ts:307-335`; `docs/reference/configuration.md:139-141`.

**The Problem:** The RD says "Helmet defaults plus a strict CSP" but does not state that the implementation uses `useDefaults: false` and has two profiles. API-only mode is `default-src 'none'` (stricter than Helmet defaults). UI-enabled mode adds `script-src 'self'`, `style-src 'self' 'unsafe-inline'` for Fluent UI Griffel, `img-src 'self' data:`, `connect-src 'self'`, and `form-action 'self'`. `crossOriginEmbedderPolicy` is disabled. A reader cannot tell that inline styles are permitted in UI mode.

**Recommendation:** Document both profiles and the reason for `style-src 'unsafe-inline'`; keep `script-src 'self'` and no `unsafe-eval`. **Confidence: High.** **Owner:** RD-02/RD-12.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

### PF-018: Agent middleware invariants are implicit 🔵 OBSERVATION

**Dimension:** 13 — Codebase Alignment; 7 — Testability
**Location:** RD-02 lines 112–114
**Codebase evidence:** `apps/server/src/app.ts:266-268,525-540`; `apps/server/src/agent/agent-middleware.ts:41-68`; `apps/server/src/transport/scope.ts:46-78,132-147`.

**The Problem:** The challenger found no protected-route bypass. The middleware is mounted globally before controller registration; the scope middleware rejects an unmarked listener before the agent middleware runs; the join exception is the exact `POST` plus normalized `/v1/agent/join`; `/health` on the agent listener requires mTLS; and path-normalization differences fail closed. The RD does not state the invariants: global mount before routing, exact join method/path exemption, unmarked listener denies, and a negative test for a newly added protected route.

**Recommendation:** Add the invariants to the RD and a negative test; no code change required today. **Confidence: Medium** (analysis-based; no exploit found). **Owner:** RD and tests.

**User Decision:** Resolved — user chose "Apply all findings" (2026-11-07); see Iteration 2 Evidence.

---

## Iteration 2 Evidence

All 18 findings were applied. The RD, the preflight report, the configuration/CLI docs, the body-limit parser, and the affected tests changed.

| Finding | Applied change | Verification |
|---|---|---|
| PF-001 | RD proxy default is loopback; explicit multi-container pin; AC4 negative case | `transport.spec.test.ts` trust predicate: `172.16.1.1` is not trusted by a `172.30.0.2/32` pin; `config.spec.test.ts` default CIDR assertion |
| PF-002 | RD error envelope nests `requestId`/`path` inside `error` | RD inspection; WebAFX envelope test |
| PF-003 | RD layered limits; parser hard cap 512 KiB; ST-22 retargeted to `/v1/data` and `/v1/agent/join`; chunked-body tests | `transport.spec.test.ts` 524,289/524,288 and 131,073/131,072 cases; `transport.impl.test.ts` chunked case |
| PF-004 | RD header adds `Integrates`; Staged Ownership table with one owner per behavior | RD inspection; no cycle with RD-05 |
| PF-005 | RD TLS invariants; docs say any matching PEM key, not PKCS#8 | RD and `docs/reference/configuration.md` inspection |
| PF-006 | Readiness wording splits startup fail-closed from `/ready` sign/verify; 2 s timeout documented | `readiness.spec.test.ts` 200/503/500/timeout cases |
| PF-007 | RD ranges narrowed to 1024–65536 and 1024–131072; `ENV_MODE` added; later-RD variables marked | `config.spec.test.ts` defaults and bounds |
| PF-008 | RD references the RD-05 ≤5 s positive cache and 5 s post-revocation guarantee | RD inspection |
| PF-009 | Passphrase reserved/fail-closed; rotation described as offline; shutdown zeroization clarified | RD and configuration-reference inspection |
| PF-010 | Loopback `/health`/`/ready` exception documented in the listener section and AC4 | `transport.spec.test.ts` loopback health/readiness cases |
| PF-011 | RD documents `PORT` as an alias and the admin/agent port collision rule | `config.spec.test.ts` port precedence cases |
| PF-012 | RD states the asymmetric clock contract; token/certificate owners cross-referenced | `clock.spec.test.ts` and RD inspection |
| PF-013 | RD adds an outcome AC for fail-before-bind and partial-start cleanup | `startup`/transport tests and RD inspection |
| PF-014 | `ov config show --redacted` implemented; CLI reference and configuration docs updated | `apps/cli/tests/commands.spec.test.ts` redacted output and missing-flag cases |
| PF-015 | RD documents the controller-level value-read restriction; negative agent-data-route tests added | `agent-listener.spec.test.ts` 401 cases for secret create and certificate import |
| PF-016 | Production 500 leak sentinel test; keyring destroy zeroization test; trust-predicate unit test; AC5 assigns the secret response to RD-08/RD-10; AC15 cross-references RD-14 | `readiness.spec.test.ts`, `keyring.spec.test.ts`, `transport.spec.test.ts`; RD AC5/AC15 inspection |
| PF-017 | RD documents API-only and UI CSP profiles and the Griffel inline-style exception | RD inspection |
| PF-018 | RD states global mount-before-routing, exact join exemption, and unmarked-listener denial; negative data-route tests | `agent-listener.spec.test.ts` and RD inspection |

### Verification Results

| Check | Result |
|---|---|
| Server unit tests | 261 passed |
| Root policy tests | 25 passed |
| Core tests | 55 passed |
| CLI tests | 98 passed |
| PostgreSQL 16 integration | 730 passed, 11 skipped; the role-boundary suite adds 11 passed with `OPENVAULT_TEST_DISPOSABLE_ROLES=1` |
| Config suites | 37 passed |
| Typecheck: server, core, CLI, api-contract, test-support, agent, web | Pass |
| Biome | 832 files checked, no fixes |
| API contract check | `CLEAN` |
| Artifact, React, Compose checks | Pass |
| Security evidence, claims, release gate | Pass (30 threats, 14 RDs; 17 claims; alpha gate) |
| Docs build | Passed in CI on PR #54. |
| CI (PR #54) | Verify, Integration (16), Integration (17), Audit, CodeQL, Gitleaks, Review dependency changes, and Build documentation all passed. |

Local environment note: `pnpm verify` could not run as one command because its pre-run install tried to modify the root-owned `node_modules`. The equivalent checks were run individually with a temporary WASI rolldown binding. CI then ran the full `pnpm verify` and docs build successfully on PR #54.

## Rejected or Corrected Leads

| Lead | Outcome |
|---|---|
| `audit_events` is an RD-07 dependency | Rejected: it is created by RD-01's initial migration. The audit probe is not blocked on RD-07; RD-07 owns the writer/semantics. |
| Critical severity for the proxy default | Corrected to MAJOR by the challenger: the shipped default is loopback and fails closed; only the RD is stale. |
| MAJOR severity for config ranges | Corrected to MINOR: fail-closed with a keyed error; defaults match. |
| MAJOR severity for readiness CA | Corrected to MINOR: startup fails closed; `/ready` probes the live signing capability. |
| MAJOR severity for the agent cache | Corrected to MINOR: RD-05 explicitly approves the 5-second bound. |
| MAJOR severity for clock skew | Corrected to MINOR: no behavior defect; the AC is unverifiable as written. |
| MAJOR severity for startup ordering | Corrected to MINOR: AC1/AC2 already require fail-before-bind; a small outcome AC is enough. |
| A protected-route bypass in the agent middleware | No bypass found; the residual gap is specification precision and a missing negative test. |

## Convergence Note

The five cluster auditors returned 10 + 10 + 10 + 10 + 10 raw findings. After deduplication and the independent challenger's severity review, the merged set is 5 MAJOR, 11 MINOR, and 2 OBSERVATION. The challenger's strongest agreement is PF-003: the body-limit acceptance criterion and its test are a false oracle against dead legacy paths, while the real `/v1/data` routes accept 512 KiB and the parser buffers up to 1 MiB before `verify`. The challenger's strongest correction is PF-001: the unsafe proxy default is a MAJOR requirements defect, not a CRITICAL runtime vulnerability, because the shipped code already defaults to loopback.

## Completion

The user authorized "Apply all findings" on 2026-11-07. All 18 findings are resolved, and the verification results above are recorded. The RD is marked `Preflighted`. The roadmap row remains `Done` because the feature was already implemented; this audit reconciled the owning requirements with the shipped code.

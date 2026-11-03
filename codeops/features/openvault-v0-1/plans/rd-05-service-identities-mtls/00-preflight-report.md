# Preflight Report: RD-05 Service Identities and mTLS Plan

> **Status**: ✅ PASSED — all 16 initial and 22 follow-on findings resolved; no accepted minors remain
> **Iteration**: 4 verification passes (five-cluster scan, two remediation re-scans, final residual check)
> **Artifact**: Full implementation plan at `codeops/features/openvault-v0-1/plans/rd-05-service-identities-mtls/`
> **Artifact Ref**: `90da6b3ac1255ae6b2d4dec6b02ee758c4d8c7fccd72ecd9fc83fe5cf9aa298a` (final plan manifest hash)
> **Codebase Grounded**: 34 source, schema, test, and configuration files examined; 31 references verified; 0 unverifiable
> **Scope**: Strict. The audit target is the plan folder. RD-05, its preflight report, RD-02/03/04/06/07/08/10/13, the public docs, and the server code are context.
> **Last Updated**: 2026-11-02 00:35
> **Same-Agent Review**: ⚠️ The plan was created in this session. Five independent auditor packets and one independent design challenger were used to reduce same-session bias. A fresh-session review is recommended for the final execution gate.

## Codebase Context Summary

**Tech Stack:** pnpm workspace, TypeScript 7, Node.js >= 24.7 (verification under 24.21.0), Express 5 through BlendSDK WebAFX 5.68.1, PostgreSQL 16/17, Vitest, `jose`, pino, and the approved `@peculiar/x509` 3.1.0 dependency.

**Architecture:** The server has typed configuration, two HTTPS listeners, browser/CLI authentication, a KEK keyring, PostgreSQL-backed sessions/signing keys, readiness probes, and generated migrations. The schema already has service principals, workload certificates, join tokens, consumers, and role assignments. There is no agent controller, CA key/signer, X.509 parser, data handler, audit writer, or full RBAC evaluator.

**Key Files Examined:**

- `apps/server/src/transport/secure-application.ts`, `scope.ts`, `tls.ts`, `pre-stack.ts`
- `apps/server/src/app.ts`, `main.ts`, `types/express.d.ts`
- `apps/server/src/auth/plugin.ts`, `middleware.ts`, `credentials.ts`, `oidc/identity.ts`, `cli-sessions.ts`
- `apps/server/src/security/keyring.ts`, `signing-keys.ts`
- `apps/server/src/readiness/service.ts`, `controllers/*.ts`
- `apps/server/src/database/schema.ts`, `generated-types.ts`, `ctypes.ts`, migrations
- `apps/server/tests/integration/transport.spec.test.ts`, `transport.impl.test.ts`, `readiness.spec.test.ts`, `tests/logging.spec.test.ts`
- `apps/server/tests/integration/helpers/*`
- `packages/api-contract/src/*`
- `docs/reference/*`, `docs/architecture/*`, `docs/guide/*`
- RD-05, the RD-05 preflight report, RD-02/03/04/06/07/08/10/13

**Reference Verification:** 31 plan claims mapped to code or docs; 31 verified; 0 unverifiable. The expected absences are the agent implementation, CA signer, X.509 library, `/v1/data` handler, audit writer, and RBAC evaluator.

**Plan Readiness Proof:**

| Check | Result |
|---|---|
| Required documents | Present: AR, 00, 01, 02, 03-01…03-04, 07, 99 |
| Links | Pass — the AR-12 anchor is fixed |
| Ambiguity Register | Passed: 25/25 resolved; no open material item |
| Task inventory | 69 unique tasks; phase table 14/14/19/14/8; 0/69 progress |
| Specification-first ordering | Pass — Phases 1–4 have spec tests → red → implementation → green → impl tests; Phase 5 is hardening/release |
| Specialist outcome | Recorded: existing catalog reviewers; no project-specific specialist |
| Later-RD ownership | RD-08/RD-10/RD-13/RD-07/RD-06 boundaries recorded, but some acceptance wording overclaims coverage (PF-014) |

## Summary by Dimension

| Dimension | Findings | Highest Severity |
|---|---:|---|
| 1 Ambiguities | 0 | — |
| 2 Implicit Assumptions | 0 | — |
| 3 Logical Contradictions | 0 | — |
| 4 Completeness Gaps | 1 | 🟠 MAJOR |
| 5 Dependency Issues | 0 | — |
| 6 Feasibility Concerns | 0 | — |
| 7 Testability | 4 | 🟠 MAJOR |
| 8 Security Blind Spots | 4 | 🔴 CRITICAL |
| 9 Edge Cases | 1 | 🟠 MAJOR |
| 10 Scope Creep | 0 | — |
| 11 Ordering & Sequencing | 1 | 🔴 CRITICAL |
| 12 Consistency | 1 | 🟡 MINOR |
| 13 Codebase Alignment | 3 | 🟠 MAJOR |

Counts are the iteration-1 primary dimensions. Follow-on findings are listed in the iteration
sections below; related dimensions are cited in each finding.

## Summary by Severity

| Severity | Count | Status |
|---|---:|---|
| CRITICAL | 1 | All resolved |
| MAJOR | 12 | All resolved |
| MINOR | 3 | All resolved |
| OBSERVATION | 0 | — |

## Independent Challenge

One independent design challenger reviewed all high-stakes findings and converged on the
recommended direction for every finding. It added two refinements:

1. **PF-003 ordering:** the replay cache must be checked first; on a miss, reject a CSR key equal
   to the authenticating certificate key. This preserves the idempotent same-key retry while
   enforcing fresh key rotation outside the replay window.
2. **PF-004:** keep the middleware guard cheap, but resolve the path project to its id before
   comparing; register the test-only route before `prepare()` on the real agent listener.

`Confidence:` High for PF-001, PF-002, PF-005, PF-006, PF-007, PF-008, PF-009, PF-010; Medium-High
for PF-003, PF-004, PF-011, PF-012. `Hardening:` Challenger converged; the two refinements are
incorporated into the recommendations. The user accepted the complete recommended remediation
batch.

## Findings

### PF-001: Agent listener is relaxed before the authenticator is installed and can bind fail-open [🔴 CRITICAL]

**Dimension:** 11 — Ordering & Sequencing (related 8 Security, 13 Codebase Alignment)
**Location:** `99-execution-plan.md` Phase 3 tasks 3.2.6–3.2.10 and Phase 4 tasks 4.2.1–4.2.8; `03-03-join-renew-consumer.md` §Agent controller; `03-04-agent-listener-revocation.md` §Listener options, §Runtime composition
**Codebase Evidence:** `apps/server/src/transport/secure-application.ts:180-185` currently uses strict `rejectUnauthorized:true`; `apps/server/src/app.ts:104-110` creates a prepared admin-marked test app; `apps/server/src/auth/plugin.ts` has no agent middleware; `main.ts` is the only production entry point.

**The Problem:** Phase 3 adds the join/renew controller and real HTTP tests, but `AgentAuthContext`, `requireAgent`, the authenticator, middleware, and listener exception are Phase 4. Phase 3 cannot compile or pass its own tests. Phase 4 also flips `rejectUnauthorized` before installing the middleware, and `startTransport` can bind the agent listener when no runtime/authenticator is supplied. A per-task commit can leave an unauthenticated `/health` or `/v1/data` route. This is an execution-order and security-boundary defect.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A+ | Move minimal agent context, DB authenticator, default-deny middleware, listener flip, and runtime requirement into Phase 3 before the controller; keep cache/revoke/retention/readiness in Phase 4; one atomic listener+middleware task; `startTransport` fails closed without an authenticator. | Real HTTP tests pass; no open intermediate; fail-closed invariant. | Larger Phase 3; task renumbering. |
| B | Keep Phase 3 service-only; move join/renew controllers and all real HTTP tests to Phase 4 after the full listener boundary. | Smaller Phase 3. | Phase 3 no longer proves the HTTP contract; join/renew verification delayed. |
| C | Temporary deny-all middleware. | No open window. | Dead security path; still needs removal. |

**Recommendation:** Option A+. It is the only option that keeps the plan's real-HTTPS strategy, prevents an open intermediate commit, and makes fail-closed behavior structural. Update phase modification sets and task numbering.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-002: Phase gates do not run the integration specifications, and DB tests sit in the unit suite [🟠 MAJOR]

**Dimension:** 7 — Testability (related 4 Completeness)
**Location:** `99-execution-plan.md` task 1.3.3, 2.3.3, 3.3.4, 4.3.3 and every phase `Verify` line; `07-testing-strategy.md` test-file tables; `01-requirements.md` acceptance criteria 1–4
**Codebase Evidence:** `package.json` `verify` runs build/typecheck/lint/`test`/artifact/React/docs; `test` is `test:unit && test:root`; `apps/server/vitest.config.ts` excludes `tests/integration/**`; `apps/server/package.json` has a separate `test:integration`; CI runs it separately.

**The Problem:** All RD-05 behavioral spec tests are under `tests/integration/`, so `pnpm verify` executes none of them. A phase can be marked green with broken schema, identity, CA, join, renewal, listener, or retention tests. Several DB-backed implementation tests are placed under `tests/` (unit) rather than `tests/integration/`, contradicting the no-mock/real-PostgreSQL policy.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add `TEST_DATABASE_URL=... OPENVAULT_TEST_DB=1 pnpm test:integration` to every phase gate; move DB-backed `*.impl.test.ts` under integration. | Honest phase gates; matches project harness. | Requires a database for each phase. |
| B | Add a root `verify:all` script and use it. | One command. | Changes project script surface. |
| C | Rely on CI only. | No inner-loop DB. | Phase green is blind; spec-first loop not enforced. |

**Recommendation:** Option A. Keep `pnpm verify` as the project verify command (AR-25) and add the integration gate explicitly. Update `01`, `07`, and every phase `Verify`.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-003: Renewal does not enforce a fresh key; the replay and reused-key tests conflict [🟠 MAJOR]

**Dimension:** 8 — Security Blind Spots (related 7 Testability, 9 Edge Cases)
**Location:** `03-03-join-renew-consumer.md` §Renewal; `03-04-agent-listener-revocation.md` §Agent context; `07-testing-strategy.md` ST-57/ST-64
**Codebase Evidence:** `workload_certs` stores serial/fingerprint/validity, not a public-key hash (`apps/server/src/database/schema.ts:168-185`). `AgentAuthContext` has serial/fingerprint but no public-key hash. The renewal sequence checks the replay cache before newest-only but never compares the CSR key with the authenticating/current certificate key.

**The Problem:** An agent can renew with the same private key after the five-minute replay window or after a restart, defeating fresh-key rotation. ST-57 expects a same-key retry inside five minutes to return 200; ST-64 calls a reused public key a 422 without defining the window. The plan is internally contradictory and does not enforce AC-8.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add `publicKeySha256` (SPKI DER) to `AgentAuthContext` from the authenticated peer certificate; check replay cache first; on a miss, reject a CSR key equal to the authenticating/current key; then newest/threshold. Clarify ST-57/ST-64. | No schema change; enforces fresh key; preserves idempotent replay. | Requires peer-cert public key hashing. |
| B | Store a public-key hash on `workload_certs`. | Durable history. | Schema change and migration. |
| C | Treat fresh key as RD-10 client behavior and remove ST-64. | Smaller. | Weakens AC-8 and rotation. |

**Recommendation:** Option A with the replay-first order. Add same-key-outside-replay 422 and same-key-inside-replay 200 tests.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-004: Data-route guard compares a name, not the required project id, and the test-only route cannot exercise the agent boundary [🟠 MAJOR]

**Dimension:** 13 — Codebase Alignment (related 7 Testability, 12 Consistency)
**Location:** `03-04-agent-listener-revocation.md` §Middleware, §Test seams; `07-testing-strategy.md` ST-70; `03-04` test-only route instruction
**Codebase Evidence:** RD-05 and the RD-05 preflight require the certificate principal's `owner_project_id` to equal the id of the project named by `:project`; the plan compares `projectName !== context.projectName`. `createTestApplication` calls `prepare()` before returning; WebAFX mounts the 404 handler during prepare; a route added after prepare is unreachable. The test app is marked `admin`, so the agent middleware skips.

**The Problem:** The guard can accept/reject on a name rather than the stated id invariant, and the planned test-only data route is either 404 or bypasses the agent middleware. The central boundary test cannot run.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Resolve `:project` to the active project row and compare `context.projectId`; register a test-only route/controller before prepare on the real agent listener (or use the existing createApplication/registerController/startTransport pattern). | Matches requirement; real boundary test. | One project lookup; test helper change. |
| B | Make the path parameter a project id and compare directly; add a pre-prepare test route. | Cheapest guard. | Changes public route contract from RD-08. |
| C | Keep name comparison and revise requirements. | No code. | Contradicts preflighted RD-05. |

**Recommendation:** Option A. Add 401/403/200 cases and a soft-deleted-project case.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-005: Join-token issuance cannot supply `created_by` and is not serialized with revoke [🟠 MAJOR]

**Dimension:** 9 — Edge Cases (related 8 Security, 4 Completeness)
**Location:** `03-03-join-renew-consumer.md` §Join-token creation; `03-01-contracts-schema-authorization.md` §Admin routes; `03-04` §Revocation transaction
**Codebase Evidence:** `join_tokens.created_by` is NOT NULL with a foreign key to `principals` (`apps/server/src/database/schema.ts:194,465-470`); the issue interface is `issue(identity, ttlSeconds?)` with no actor. Token issuance performs an active-project check and insert without the principal lock used by join/renew/revoke.

**The Problem:** Every admin token insertion fails the NOT NULL/FK check, and a concurrent revoke can commit between the check and insert, leaving an unused token for a disabled identity and returning 201. AC-7 requires every unused token revoked.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | `issue(identity, ttlSeconds, createdBy)`; one transaction locks the principal and active project, rechecks, inserts. | Consistent lock order; closes race. | One extra transaction. |
| B | One `INSERT ... SELECT` from active principal/project, map zero rows to 409. | Smallest atomic insert. | Subtle under READ COMMITTED; less explicit. |
| C | Accept the race. | No code. | AC-7 false; latent token. |

**Recommendation:** Option A. Add `createdBy` and a concurrent issue/revoke test.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-006: A `principals.kind` flip can leave human credentials and live sessions [🟠 MAJOR]

**Dimension:** 8 — Security Blind Spots (related 4 Completeness, 13 Codebase Alignment)
**Location:** `03-01-contracts-schema-authorization.md` §Schema and migration, §Error handling; `07-testing-strategy.md` ST-13/ST-14; `99` Phase 1/2 tasks
**Codebase Evidence:** The trigger guards only `BEFORE INSERT OR UPDATE OF principal_id` on `local_credentials`, `oidc_identities`, and `cli_sessions`. The `principals` schema has no kind-immutability rule. `findStatus`, `findByPrincipalId`, and `findActiveContext` do not filter `kind='user'`; a browser/CLI session can survive a user→service flip.

**The Problem:** A direct update or future admin path can turn a user into a service principal while retaining a local credential or live session. The database trigger never fires, and CLI/browser read paths still authenticate the principal. ST-14 cannot pass as written.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add a `BEFORE UPDATE OF kind ON principals` trigger rejecting user↔service changes; make credential-table guards full-row; add `kind='user'` filters to `findStatus`, `findByPrincipalId`, `findActiveContext`, and OIDC linkage; test all paths. | Structural invariant; covers future paths. | More trigger/test code. |
| B | Service-layer checks only. | Smaller. | Direct SQL bypass; AR-14 not enforced. |
| C | Narrow ST-14 and accept residual. | No code. | Invariant weakens. |

**Recommendation:** Option A. Reject all kind changes; use full-row credential guards or deferred constraints; add read filters regardless.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-007: Runtime composition has two identity owners, no logger, and no disposal [🟠 MAJOR]

**Dimension:** 13 — Codebase Alignment (related 5 Dependency, 4 Completeness)
**Location:** `03-04-agent-listener-revocation.md` §Runtime composition; `99` Phase 2 task 2.2.7 and Phase 4 task 4.2.8; `03-02` `CaSigner.destroy()`
**Codebase Evidence:** WebAFX rejects duplicate service names. `createApplication` creates the pino provider internally; `createAgentRuntime` has no logger option. `AgentMaintenanceService` needs a logger; `AgentRuntime` has no dispose, so the maintenance timer and CA `CryptoKey` are never released. `CaSigner.destroy()` is dead.

**The Problem:** Phase 2 and Phase 3/4 can both own `IdentityService`, causing duplicate registration or two instances with different caches. The runtime cannot use the application logger. Shutdown does not stop maintenance or drop CA references.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | `identity-runtime` remains the single owner; agent runtime accepts it; create one logger provider in main and pass it; add `AgentRuntime.dispose()` and register it. | One identity/cache; captured logs; graceful shutdown. | Slightly larger composition root. |
| B | Only agent-runtime constructs identity; Phase 2 tests use a test factory. | One production owner. | Phase 2 app wiring changes. |
| C | Distinct service names. | No duplicate crash. | Two caches; revoke invalidation bypass. |

**Recommendation:** Option A. Add a composition/disposal test.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-008: Existing transport/readiness/logging tests and ST-41/ST-78 phases are not updated [🟠 MAJOR]

**Dimension:** 7 — Testability (related 11 Ordering)
**Location:** `99` Phase 3/4 tasks; `03-04` §Test seams; `07-testing-strategy.md` ST-41, ST-78; `00-index` Related Files
**Codebase Evidence:** `transport.spec.test.ts:177-204` expects handshake rejection for missing/untrusted certs; `transport.impl.test.ts:187-237` registers an agent EchoController and expects 200 with a client cert; `readiness.spec.test.ts` expects `/ready` 200 with no CA runtime/row; the redaction suite is `apps/server/tests/logging.spec.test.ts`, not `tests/integration/logging.spec.test.ts`.

**The Problem:** The plan claims existing suites remain green but assigns no tasks to update `transport.spec`, `transport.impl`, `readiness.spec`, or the real logging suite. ST-41 (`/ready` CA probe) is scheduled in Phase 3 but the probe wiring is Phase 4. ST-78 captured logs are scheduled in Phase 4 but the redaction paths are Phase 5. The same test file is assigned twice.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add explicit Phase 4 tasks for all four existing suites; conditionally add the CA probe when the runtime exists; split ST-41 CA-method vs `/ready`; move end-to-end ST-78 to Phase 5; use the real logging path. | Honest test story. | More tasks. |
| B | Leave old tests; fix failures at Phase 5. | Fewer plan edits. | Hidden breakage; late rework. |
| C | Delete old assertions. | Fast. | Loses coverage. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-009: CA serial/probe/duplicate-current test cases require impossible or undefined seams [🟠 MAJOR]

**Dimension:** 7 — Testability (related 6 Feasibility, 9 Edge Cases)
**Location:** `03-02-ca-x509-issuance.md` §Certificate profile, §`CaSigner.load()`, §Readiness; `03-03` join flow; `07-testing-strategy.md` ST-33/ST-40/ST-41
**Codebase Evidence:** `ca_keys_current_idx` is a unique partial index, so two current rows cannot exist. `workload_certs.serial` is unique; PostgreSQL aborts the transaction on a unique violation, so a retry in the CA layer cannot re-insert without a savepoint/restart. A loaded signer holds a non-extractable key; later row corruption is not observed. There is no serial injection seam.

**The Problem:** ST-33's duplicate-current load case is impossible; ST-40 cannot force collisions or perform the promised retry; ST-41 cannot corrupt a loaded signer. The retry is also assigned to no service.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Inject a test serial source; own collision retry in join/renew with a SAVEPOINT or transaction restart; remove the duplicate-current case and assert the index instead; split load-failure vs loaded-signer probe; test readiness with a fake failing probe. | Testable; real behavior. | More test seam code. |
| B | Drop retry and duplicate-current tests; map collision to 503. | Smallest. | Less resilience; ST-40/33 rewritten. |
| C | Add a dedicated test-only CA seam. | Isolates. | More test machinery. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-010: PostgreSQL 16/17, migration, and generated-type verification have no executable command sequence [🟠 MAJOR]

**Dimension:** 7 — Testability (related 4 Completeness, 5 Dependency)
**Location:** `99` Phase 1 task 1.3.3, Phase 5 tasks 5.1.4/5.1.5; `07` ST-16, verification checklist; `01` acceptance 2–3
**Codebase Evidence:** `pnpm verify` does not run `test:integration` or `db:types:check`; `apps/server/scripts/generate-db-types.ts` requires `OPENVAULT_DB_URL`; `db:types:check` regenerates types but does not apply migrations. The repo has `deploy/compose/compose.test.yaml` profiles pg16/5433 and pg17/5434, and CONTRIBUTING commands.

**The Problem:** Phase 1 cannot prove ST-16 on both versions; Phase 5 names `db:types:check` without a migrate/DB URL; the plan is not executable as written.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Phase 1 uses one DB; Phase 5 owns PG16/17 with explicit compose/migrate/test:integration/db:types:check commands. | Executable; cross-version at release. | Some cross-version delay. |
| B | Add a matrix task in Phase 1. | Early evidence. | Slower inner loop. |
| C | Rely on CI. | No plan commands. | Local execution blind. |

**Recommendation:** Option A. Add the command block to `07` and reference it.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-011: The five-second guarantee is admission-time, not delivery-time; caches need bounds/invalidation [🟠 MAJOR]

**Dimension:** 8 — Security Blind Spots (related 9 Edge Cases, 12 Consistency)
**Location:** `03-04` §Revocation, §Agent authenticator; `03-03` §Renewal replay; `07` ST-57/ST-63/ST-72/ST-73; `00-index` key decision
**Codebase Evidence:** The middleware checks only before routing; a slow data handler can send after the bound. The auth cache TTL starts after the DB read, so a read that starts before revoke can cache a stale active row for five seconds after completion. The renewal replay cache is not invalidated by revoke and can return a certificate to an already-admitted renew request.

**The Problem:** The plan promises “no agent request succeeds more than five seconds after revoke” but only enforces admission. A secret can be delivered after the bound. The replay cache can survive a revoke. On a cache hit, `notAfter` is not rechecked.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Define RD-05 guarantee as admission-time; require RD-08 to revalidate immediately before sending; invalidate replay cache on revoke; start cache TTL at read start; check `notAfter` on hits. | Honest; secure data boundary. | RD-08 obligation; more tests. |
| B | Add a response-time recheck middleware in RD-05. | Uniform. | Async DB per response; Express complexity. |
| C | Cap handler time below five seconds. | Simple. | Fragile; no proof. |

**Recommendation:** Option A, with a cross-RD obligation in `01`/AR-21. Add a slow test-only data-route case.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-012: Browser/CLI middleware still runs on the agent listener [🟠 MAJOR]

**Dimension:** 8 — Security Blind Spots (related 13 Codebase Alignment)
**Location:** `03-04` §Agent context; `02-current-state.md` auth/plugin line; `99` modification sets/tasks
**Codebase Evidence:** `createAuthPlugin` installs CLI/session resolution, password-change gate, Origin, and CSRF on every request. The plan says agent credentials never participate in browser/CLI rules but does not modify `auth/plugin.ts` or `auth/middleware.ts`.

**The Problem:** A browser cookie or CLI bearer on the agent listener can attach `req.auth`, trigger browser-only guards, or expose a browser/CLI context to a future data handler. The “never participate” claim is false.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Make the resolvers listener-aware: skip browser/CLI resolution on the agent listener; add mixed-credential tests. | One listener, one credential type; simple. | Auth plugin change. |
| B | Document that contexts may attach but agent routes ignore them. | No code. | Claim remains false; future misuse. |
| C | Separate Express stacks per listener. | Strong isolation. | Larger transport refactor. |

**Recommendation:** Option A. Skip the resolvers (ignore) rather than reject mixed credentials; add `auth/plugin.ts`/`auth/middleware.ts` to the modification set.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-013: CA implementation details need correction before execution [🟡 MINOR]

**Dimension:** 13 — Codebase Alignment (related 6 Feasibility)
**Location:** `03-02` §CA load, §Certificate profile; `07` ST-38/ST-40/ST-42; `03-02` test fixture
**Codebase Evidence:** `@peculiar/x509` 3.1.0 exposes `BasicConstraintsExtension`/`KeyUsagesExtension`; `X509Certificate` has no `ca`/`pathLength`/`keyUsages`. `X509CertificateGenerator` normalizes leading-zero serials. The planned “zero the JWK `d`” is not possible for a string. The test fixture also imports the library and needs `reflect-metadata` first.

**The Problem:** A literal implementation can reject a valid CA, store a serial that differs from the certificate, or claim zeroization it cannot achieve. The test fixture can fail at import.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Use extension classes for CA checks; return `cert.serialNumber`; zero only mutable buffers and document the JWK-string limitation; import `reflect-metadata` first in the fixture and state the test-only import exception. | Correct and honest. | Minor plan corrections. |
| B | Keep prose only. | No code. | Implementation ambiguity. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-014: API/authorization consistency needs correction [🟡 MINOR]

**Dimension:** 12 — Consistency
**Location:** `03-01` §Narrow identity authorization, §Admin routes, §Error handling; `03-03` §Join-token creation; `01` acceptance mapping
**Codebase Evidence:** `docs/reference/roles.md` says `org.admin` is org-scope only; the plan grants project-scoped `org.admin`. WebAFX uses `FORBIDDEN` for `ForbiddenError`; docs use `access_denied`; the plan invents `forbidden`. Existing controllers use `400 validation_error` for strict body failures; the plan alternates 400/422. `principals` requires `status='disabled'` when `disabled_at` is set; one plan section omits status. Token TTL seconds vs config milliseconds is implicit. `01` says fetch state uses the test probe, but AR-21 defers it. The name regex misses C1 controls.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Filter `org.admin` to org scope; use `access_denied` for policy denial; 400 for schema failures/422 for semantics; set `status='disabled'` + `disabled_at`; convert TTL explicitly; change `01` to “guard only”; use `\p{Cc}`; update tests/docs. | Consistent and executable. | Several small edits. |
| B | Keep plan wording and adjust docs/RD-06. | No plan churn. | Contradicts public matrix; weaker. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-015: Phase modification sets and test inventory omit files the tasks modify [🟠 MAJOR]

**Dimension:** 4 — Completeness (related 7 Testability)
**Location:** `99` Phase 3/4 modification sets; `99` tasks 3.2.3/3.2.9/4.2.8; `07` test-file tables
**Codebase Evidence:** Phase 3's set omits `agent-token-service.ts`, `app.ts`, `main.ts`; Phase 4's set omits `agent-runtime.ts`; tasks modify them. `07` omits several `*.impl.test.ts` files created by `99`, assigns ST-8 to two files, and names a logging test path that does not exist. The plan uses strict scope.

**The Problem:** An executor following the modification set cannot complete the tasks; one following tasks violates strict scope. The test coverage map is not a single inventory.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Add omitted files to each phase set; make `07` list every test file; correct logging paths; give ST-8 one owner. | Executable; traceable. | Plan edits. |
| B | Remove file lists from tasks; make sets authoritative. | Less duplication. | Less precise task packets. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

---

### PF-016: Small documentation/test-edge corrections remain [🟡 MINOR]

**Dimension:** 7 — Testability (related 12 Consistency)
**Location:** `00-index` AR-12 anchor; `03-01` migration header; `07` ST-34/ST-57/ST-64; `03-01` name regex
**Codebase Evidence:** The AR-12 link targets a heading that does not exist. The manual migration block omits the five-line BlendSDK header. ST-34 says arbitrary subject but not empty; ST-57 does not say the old certificate authenticates; ST-64 conflicts with replay. The C1 control gap is in PF-014.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Fix the anchor, add the migration header, extend ST-34 with empty subject, extend ST-57 with old certificate, clarify ST-64 outside the replay window. | Small, complete. | Plan edits. |
| B | Leave and accept. | No work. | Broken link/ambiguous tests. |

**Recommendation:** Option A.

**User Decision:** Resolved — user accepted the recommended remediation.

## Verdict

**❌ BLOCKED — 1 critical and 12 major findings are unresolved; 3 minor findings are also pending.**
The plan must not advance to `Plan Preflighted` or execution until the critical/major findings are
resolved and every remaining minor is explicitly accepted.

## User Rulings

| Finding | Ruling |
|---|---|
| PF-001 | Resolved — accepted Option A+: agent boundary in Phase 3; fail-closed listener; atomic flip. |
| PF-002 | Resolved — accepted integration gates and DB-test reclassification. |
| PF-003 | Resolved — accepted peer-certificate SPKI hash and replay-first fresh-key check. |
| PF-004 | Resolved — accepted project-id guard and pre-prepare data probe. |
| PF-005 | Resolved — accepted createdBy and principal/project lock. |
| PF-006 | Resolved — accepted principal-kind trigger, full guards, and read filters. |
| PF-007 | Resolved — accepted one identity runtime, one logger, and disposal. |
| PF-008 | Resolved — accepted existing-suite updates and ST phase splits. |
| PF-009 | Resolved — accepted serial seam/retry, unique-current test, and probe split. |
| PF-010 | Resolved — accepted one-DB Phase 1 and PG16/17 Phase 5 matrix. |
| PF-011 | Resolved — accepted admission-time guarantee, revalidate, cache invalidation, and read-start TTL. |
| PF-012 | Resolved — accepted listener-aware auth resolvers and mixed tests. |
| PF-013 | Resolved — accepted extension-class checks, parsed serial, zeroization limitation, and fixture import/variants. |
| PF-014 | Resolved — accepted authorization/status/unit/control consistency corrections. |
| PF-015 | Resolved — accepted phase-set and test-inventory corrections. |
| PF-016 | Resolved — accepted anchor, migration header, and ST edge corrections. |

## Iteration 2 — Remediation Re-scan

The second pass found 14 follow-on issues. All are resolved.

| Finding | Severity | Resolution |
|---|---|---|
| PA-201 | CRITICAL | `createTestApplication` supplies a deny-all authenticator by default; explicit fixture authenticator wins; production fails closed; transport tests updated in Phase 3. |
| PA-202 | MAJOR | Phase 3 returns `AgentRuntimeCore`; Phase 4 extends it with maintenance/dispose; project resolver is Phase 3. |
| PA-203 | MAJOR | Production agent runtime constructs the single identity runtime; Phase 2 uses the test factory; app accepts either, never both. |
| PA-204 | MAJOR | `projectId` optional/service 422; TTL range service 422; agent token status service 401; body/consumer schema 422; mapping documented. |
| PA-205 | MINOR | List denial uses `access_denied`. |
| PA-206 | MAJOR | ST-29 and Phase 2 2.3.2 cover concurrent token issue/revoke. |
| PA-207 | MAJOR | Missing test files added; ST-78 has one end-to-end owner; ST-82 read-path coverage. |
| PA-208 | MAJOR | Phase 4 4.2.3 no longer touches `agent-middleware`; resolver is Phase 3. |
| PA-209 | MAJOR | ST-16 one version; ST-83 explicit Phase 5 matrix. |
| PA-210 | MINOR | ST-70 covers soft-deleted path project. |
| PA-211 | MINOR | Issued serial is parsed from the certificate. |
| PA-212 | MINOR | AR-21 records acceptance 7/8 later-RD obligations. |
| PA-213 | MINOR | Verification block builds before migration. |
| PA-214 | MINOR | `AgentTokenService` owns token SQL; identity repository has no token insert. |

## Iteration 3 — Bounded Re-scan

The third pass found 7 residuals. All are resolved.

| Finding | Severity | Resolution |
|---|---|---|
| PA-301 | MAJOR | ST-78 is Phase 5; ST-80 is listener; ST-81 is retention; Phase 4 green gate ranges corrected. |
| PA-302 | MAJOR | ST-13/14 are Phase 1 schema tests; service-principals owns ST-82. |
| PA-303 | MAJOR | Contract accepts integer TTL; service returns 422 for range; ST-5 contract and ST-84 service split; token status split. |
| PA-304 | MINOR | `schema.spec`/`migrations.spec` inventoried; ST-83 is explicit Phase 5 matrix. |
| PA-305 | MINOR | `AgentTokenService.revokeUnused()` owns the revoke update. |
| PA-306 | MINOR | Phase 4 test-harness, readiness, runtime, and CLI tasks have distinct responsibilities. |
| PA-307 | MINOR | `createApplication` accepts IdentityRuntime or AgentRuntimeCore; explicit authenticator wins over deny-all. |

## Final Residual Check

The final fresh-context check found one minor status-wording exception: empty/over-long token
envelopes are 400, while in-bound bad tokens are 401. The contract, 03-01 summary rows, 03-03 error
table, and ST-85 now state that distinction. No open findings remain.

## Verdict

**✅ PASSED — all 16 initial findings and 22 follow-on findings are resolved. No accepted minors
remain.** The plan may advance to `Plan Preflighted`.

## Decision Summary

| Finding | Severity | Ruling |
|---|---|---|
| PF-001–PF-016 | 1 critical, 12 major, 3 minor | All recommended remediations accepted and applied. |
| PA-201–PA-214 | 1 critical, 7 major, 6 minor | All re-scan findings resolved. |
| PA-301–PA-307 | 2 major, 5 minor | All bounded re-scan findings resolved. |
| PA-501 | 1 minor | Status-code wording fixed; no open findings. |

## Next Step

Plan preflight is passed. Advance the roadmap row to `Plan Preflighted` and use the `exec-plan`
skill for implementation.

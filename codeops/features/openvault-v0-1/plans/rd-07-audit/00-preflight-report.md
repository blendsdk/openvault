# Preflight Report: RD-07 Audit Implementation Plan

> **Status**: ✅ PREFLIGHT PASSED — all 29 findings resolved
> **Iteration**: 2 (first scan + corrective re-scan)
> **Artifact**: Implementation plan at `codeops/features/openvault-v0-1/plans/rd-07-audit/`
> **Scan-start `00-index.md` blob**: `a7a831033dc87efc2a78bac214a350be7b9d5216`
> **Post-fix `00-index.md` blob**: `386be25e26dbe9a7f143b10013143d8ebba49dd1`
> **Codebase Grounded**: 28 source, test, schema, and documentation files examined; 44 references mapped
> **Last Updated**: 2026-11-04 08:49

> ⚠️ **SAME-SESSION REVIEW**: This artifact was created earlier in the current session. Same-agent bias risk is elevated. An independent challenger reviewed the critical/major batch and confirmed every finding; a fresh-session audit is still recommended before execution for maximum independence.

## Audit Target and Context

| Boundary | Content |
|---|---|
| **Audit target** | The 10 documents in `plans/rd-07-audit/` |
| **Context documents** | RD-07 requirements; RD-06 plan and requirements; `docs/architecture/crypto.md`; `docs/security/limitations.md`; `docs/reference/api.md`, `configuration.md`, `cli.md`, `roles.md`; repository manifests and CI |
| **Modification set** | The audit target and the roadmap rows; no implementation code was changed by this preflight |
| **Scope mode** | Strict; no optional additions were proposed |
| **Domain lenses** | Web application; distributed and concurrent; data and migration; security (`auth-protocol`, `tenant-isolation`) |

## Codebase Context Summary

**Repository:** OpenVault — self-hosted secret and certificate store.

**Tech Stack:** TypeScript 7, Node.js 24.21.0, WebAFX 5, PostgreSQL 16/17, `pg`, Vitest 5, Zod 4.6.7, pnpm 12.

**Architecture:** `apps/server` contains WebAFX controllers, an authentication plugin, a fixed-action RBAC policy engine, identity and agent runtimes, a local CA, TLS listeners, and a PostgreSQL adapter. `packages/api-contract` owns Zod contracts; `packages/core` owns the keyring and envelope crypto. The audit tables and append-only triggers already exist; no audit writer or `/v1/audit` routes exist yet.

**Key files examined:**

- `apps/server/src/database/schema.ts:397-455` — audit tables, checks, indexes.
- `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27,124-133` — append-only and TRUNCATE triggers.
- `apps/server/src/rbac/audit.ts:9-170` — policy audit port and logger adapter.
- `apps/server/src/rbac/policy-service.ts:80-83,219-329,614-623,782-804` — decision engine, list visibility, audit mapping.
- `apps/server/src/rbac/assignment-service.ts:150-350` — decision and mutation transaction flow.
- `apps/server/src/identity/identity-authorizer.ts:29-124`, `identity-service.ts:98-270` — identity authorization and duplicated decisions.
- `apps/server/src/auth/local-login.ts:98-144`, `auth/credentials.ts:172-227` — failure reasons and lockout result.
- `apps/server/src/controllers/auth.ts:66-109`, `cli-auth.ts:60-87`, `oidc.ts:86-170` — login issuance and revalidation order.
- `apps/server/src/agent/agent-join-service.ts:75-180`, `agent-renew-service.ts:195-328`, `consumer-repository.ts:73-124`, `errors.ts:1-33` — join/renew failure flow and consumer upsert.
- `apps/server/src/app.ts:40-235`, `transport/secure-application.ts:42-60`, `agent/agent-runtime.ts:96-172`, `rbac/runtime.ts:39-55` — composition.
- `apps/server/tests/integration/helpers/fixtures.ts:45-203`, `test-database.ts:86-241` — test harness and synthetic audit rows.
- `packages/api-contract/src/rbac.ts:15-41`, `index.ts:1-98` — action catalog and exports.
- `docs/reference/api.md:339-345`, `docs/guide/audit.md`, `docs/reference/configuration.md:27`, `docs/reference/cli.md:32,70`, `docs/security/limitations.md:13-14`.

**Reference verification:** 44 references mapped. All existing-file references resolve. The new `apps/server/src/audit/*` files are planned, not present; their names and responsibilities are internally consistent. The preflight report and this report are the only new documents.

## Summary by Dimension

| # | Dimension | Findings | Highest severity |
|---|---|---|---|
| 1 | Ambiguities | 1 | 🟠 MAJOR |
| 2 | Implicit Assumptions | 0 | — |
| 3 | Logical Contradictions | 2 | 🟠 MAJOR |
| 4 | Completeness Gaps | 3 | 🟠 MAJOR |
| 5 | Dependency Issues | 2 | 🟡 MINOR |
| 6 | Feasibility Concerns | 2 | 🟠 MAJOR |
| 7 | Testability | 2 | 🟡 MINOR |
| 8 | Security Blind Spots | 0 (covered by 13) | — |
| 9 | Edge Cases | 1 | 🟡 MINOR |
| 10 | Scope Creep Indicators | 0 | — |
| 11 | Ordering & Sequencing | 0 | — |
| 12 | Consistency | 7 | 🟡 MINOR |
| 13 | Codebase Alignment | 9 | 🔴 CRITICAL |

## Summary by Severity

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 4 | ✅ all resolved |
| MAJOR | 8 | ✅ all resolved |
| MINOR | 13 | ✅ all resolved |
| OBSERVATION | 4 | ✅ all resolved |

---

## Findings

### PF-001: The first retained anchor event is not content-checked [🔴 CRITICAL]

**Dimension:** Codebase Alignment
**Location:** `03-02-audit-api.md` §Verify Service step 2, second bullet, and step 4
**Codebase Evidence:** `03-01-audit-core.md:395-402` creates a checkpoint at the first event; `apps/server/src/database/schema.ts:430-432` stores `hash` and `hmac` separately from the row content.

**The Problem:** When a checkpoint exists at `firstId`, the verifier verified the checkpoint HMAC and compared the row's stored `hash` to `last_hash`, then started **after** that event. Editing the anchor event's `details`, `result`, `ts`, or `auditKeyId` while leaving its stored `hash` unchanged was not detected. Because the first-event checkpoint is created normally, this affected the common small-chain case and violated RD-07 acceptance 2.

**Resolution:** The verifier now anchors **at** `firstId` and includes that event in the walk. It recomputes the canonical hash and HMAC from the row and treats the checkpoint's `last_hash` as the expected value. ST-35 now edits the first retained event; ST-36/37 cover other positions.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: verification algorithm inside the RD's tamper-detection requirement · Objective: detect edits at every retained event · Decision: include the anchor event in the walk · Evidence: plan checkpoint-at-first-event plus separate hash/HMAC columns · Rejected: trust the stored row hash (current, fails acceptance 2); verify only the anchor hash without HMAC (partial) · Strongest counterargument: including the anchor duplicates the checkpoint check; mitigation: it is the only way to bind content to the checkpoint · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a verifier design that no longer anchors at the first event.

### PF-002: An empty event table with a surviving checkpoint is reported as a clean chain [🔴 CRITICAL]

**Dimension:** Codebase Alignment
**Location:** `03-02-audit-api.md` §Verify Service step 3 and §Error Handling
**Codebase Evidence:** `apps/server/src/database/schema.ts:448-455` keeps checkpoints independent of events; `apps/server/migrations/20261030094203_initial.up.sql:330-331` has no `last_event_id` foreign key; the pruner trigger permits event deletion.

**The Problem:** The plan returned `ok: true`, `reason: "empty_chain"` whenever `audit_events` was empty, even when checkpoints proved events had existed. A database administrator could delete every event and verification would report a clean chain, violating acceptance 4.

**Resolution:** An empty table with at least one checkpoint now returns `ok: false`, `reason: "tail_truncated"`. `empty_chain` is reserved for a truly empty chain with no checkpoints. ST-41 covers the truly empty case; ST-96 covers the checkpoint case.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: verification failure semantics · Objective: no clean verdict after evidence deletion · Decision: checkpoint present implies `tail_truncated` · Evidence: checkpoint table survives event deletion · Rejected: always `empty_chain` (current, hides truncation); 503 (turns tamper into an outage) · Strongest counterargument: a checkpoint could be orphaned by a legitimate full prune; mitigation: a legitimate full prune writes a prune event or leaves a boundary anchor, and the operator can export checkpoints off-box · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a schema change that couples checkpoints to live events.

### PF-003: A newer checkpoint can mask an older deleted-tail checkpoint [🔴 CRITICAL]

**Dimension:** Codebase Alignment
**Location:** `03-02-audit-api.md` §Verify Service step 5
**Codebase Evidence:** `03-01-audit-core.md:395-402` allows many checkpoints; `apps/server/src/database/schema.ts:448-455` has no single-chain-tip constraint.

**The Problem:** The plan checked only the greatest valid checkpoint at or after `firstId`. After deleting a tail event, a later `audit.verify` event can create a new checkpoint at the new tail (age or count cadence), and the next verification would use that newer checkpoint and ignore the older checkpoint that references the missing event. Tail deletion would then pass. The same applies to a missing event with a checkpoint in the middle.

**Resolution:** The verifier now checks **every** checkpoint with `last_event_id >= firstId`: key, HMAC, referenced event existence, and hash equality. Any failure returns `key_unavailable`, `checkpoint_mismatch`, or `tail_truncated`. A newer checkpoint cannot mask an older one. ST-39 now deletes the tail and adds a newer checkpoint before verifying.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: verification algorithm · Objective: every checkpoint remains an integrity claim · Decision: check all checkpoints at/after the retained window · Evidence: checkpoints coexist and are append-only · Rejected: greatest-only (current, maskable); stop at first valid (same defect) · Strongest counterargument: checking every checkpoint costs more; mitigation: checkpoints are sparse and verification is rate-limited · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a checkpoint-compaction design.

### PF-004: Prune deletes evidence without verifying the retained chain [🔴 CRITICAL]

**Dimension:** Codebase Alignment
**Location:** `03-04-retention-operations.md` §Prune Service
**Codebase Evidence:** `apps/server/src/database/schema.ts:430-432` stores hashes separately; `03-01-audit-core.md:342-345` writes a checkpoint from the boundary's stored hash; the append-only trigger blocks writes but does not verify content.

**The Problem:** Prune exported, checkpointed at the boundary's stored hash, and deleted the prefix without verifying the chain. A tampered prefix event, or a tampered boundary event whose hash was left unchanged, would be exported and then deleted; the checkpoint would anchor the stored hash and verification would pass. The plan's own ST-74 only verified after the destructive delete.

**Resolution:** `AuditPruneOptions` now requires an `AuditVerifier`; prune calls `verify()` before export, checkpoint, or delete and aborts on any failure. The boundary checkpoint must match the boundary event's hash. ST-97 adds a tampered-prefix abort test. This also closes the laundering path for a tampered boundary event.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: destructive maintenance flow inside the accepted retention model · Objective: never delete unverified evidence · Decision: pre-prune verification gate plus boundary hash check · Evidence: `verify()` recomputes content and checkpoints; the trigger does not · Rejected: verify after delete (too late); trust checkpointAt (current, launders tamper); no verification (current) · Strongest counterargument: full verification lengthens maintenance; mitigation: prune is explicit and offline; correctness wins · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: an incremental verifier with equivalent coverage.

### PF-005: The hash function contract can double-encode the canonical string [🟠 MAJOR]

**Dimension:** Ambiguities
**Location:** `03-01-audit-core.md` §Hash and HMAC
**Codebase Evidence:** No writer/verifier exists; the plan is the only contract. ST-8 already says `SHA-256(prevHashBytes || canonicalUtf8)`.

**The Problem:** The signature was `computeEventHash(canonical: string, prevHash)` but the formula wrote `canonicalJson(canonical)`. If `canonical` was already the serialized string, the function would serialize it again (adding quotes), producing a hash that only the same buggy writer/verifier pair could reproduce. If it was an object, the type was wrong.

**Resolution:** The parameter is named `canonicalJson`, is already serialized, and is hashed as UTF-8 after the raw previous-hash bytes. ST-8 now includes a fixed primitive vector so the contract cannot drift: canonical `{"a":1}`, 32 zero previous-hash bytes, key `0x01`; hash `b06a…ccb1`, HMAC `8c7b…93e0`.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: hash interface · Objective: byte-stable hashing across writer and verifier · Decision: serialized string in, raw hash out · Evidence: ST-8 and the RD formula · Rejected: object-and-serialize inside (viable but a larger signature change); ambiguous current form (fails) · Strongest counterargument: callers can pass the wrong string; mitigation: one call site and a fixed vector · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a cross-language verifier.

### PF-006: The pruner role grant is insufficient for `DELETE ... WHERE id <= ...` [🟠 MAJOR]

**Dimension:** Codebase Alignment
**Location:** `03-04-retention-operations.md` §Test Role Provisioning and §Deployment Prerequisite
**Codebase Evidence:** `apps/server/src/database/schema.ts:411` defines `id` as `bigserial`; PostgreSQL requires SELECT on columns read in the DELETE predicate. A live probe on the test cluster returned `42501 permission denied for table tmp_audit_probe` with DELETE only and succeeded with SELECT+DELETE.

**The Problem:** The plan granted only `DELETE` on `audit_events`. The prune delete reads `id` in its WHERE clause, so the command would fail at runtime with a permission error, and the test helper would not reproduce a working pruner.

**Resolution:** Grant `SELECT, DELETE ON audit_events` in the test helper, deployment prerequisite, and docs. ST-81 uses the `SELECT, DELETE` grant; the testing requirements include a DELETE-only denial probe.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: least-privilege grant set · Objective: the prune connection can delete its prefix · Decision: SELECT on the predicate column plus DELETE · Evidence: live PostgreSQL probe and `id` column definition · Rejected: DELETE only (fails); GRANT ALL (too broad) · Strongest counterargument: SELECT exposes audit metadata to the maintenance role; mitigation: the role already reads the prefix through the application connection and is a trusted maintenance role · Confidence: High · Hardening: independent challenger confirmed; live probe · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a delete predicate that does not read a table column.

### PF-007: Checkpoint cadence contradicts ST-15 and ST-39 [🟠 MAJOR]

**Dimension:** Logical Contradictions
**Location:** `03-01-audit-core.md` §Checkpoints; `07-testing-strategy.md` ST-15 and ST-39
**Codebase Evidence:** No writer exists; the conflict is internal to the artifact.

**The Problem:** The cadence counted events with `id > latest.last_event_id` and fired at `>= 1,000`. With the first-event checkpoint at id 1, that fires at id 1,001, but ST-15 expected a checkpoint at event 1,000 and ST-39 recorded only 1,000 events so the latest checkpoint would anchor the tail. The spec test and the prose could not both be satisfied.

**Resolution:** The prose is retained as the literal "1,000 further events" rule. ST-15 now records 1,001 events and expects checkpoints at 1 and 1,001 (none at 1,000); ST-39 records 1,001 events. The checkpoint section states the 1,001 consequence explicitly.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: checkpoint cadence mechanism · Objective: one testable cadence · Decision: keep further-events semantics; update tests to 1,001 · Evidence: first-event checkpoint at id 1 plus `id >` count · Rejected: inclusive count at 1,000 (creates a 999-event first interval); unspecified cadence (fails) · Strongest counterargument: "every 1,000 events" could mean checkpoint ids 1,000, 2,000; mitigation: the first-event checkpoint is a special anchor, and the prose says further events · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a requirement that checkpoints land on round event counts.

### PF-008: Renewal failure evidence would roll back with the transaction [🟠 MAJOR]

**Dimension:** Completeness Gaps
**Location:** `03-03-audit-emitters.md` §Renew failure
**Codebase Evidence:** `apps/server/src/agent/agent-renew-service.ts:227-323` throws not-current, not-due, inactive, and CA failures inside `withTransaction`; the join section already specifies an independent failure write.

**The Problem:** The normative renew section defined actor and reason but not ordering. An event written inside the failing transaction would disappear, so a denied renewal could leave no evidence, contrary to one event per attempt and the fail-closed model.

**Resolution:** Every renewal failure is recorded through an independent write after rollback, mirroring join. If the error is already `AuditUnavailableError`, rethrow it; otherwise write one failure event; if that write fails, return 503. Pre-transaction CSR and replay failures use the same path. ST-73 asserts the event survives rollback.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: failure and transaction design · Objective: one durable event per renewal attempt · Decision: independent failure write after rollback · Evidence: renew throws inside the transaction · Rejected: write inside the transaction (rolls back); best effort (loses evidence) · Strongest counterargument: an independent write after a rollback can itself fail; mitigation: 503 replaces the original error · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a renew transaction that never rolls back.

### PF-009: A login can record an allow event and still return 401 [🟠 MAJOR]

**Dimension:** Logical Contradictions
**Location:** `03-03-audit-emitters.md` §Local login result and §Browser and CLI
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:85-92` creates a session, then `revalidate` can fail and return 401; `apps/server/src/controllers/cli-auth.ts:81-84` returns 401 when `cliAuth.login` yields `credential_changed`. The plan's table already lists post-issuance hash mismatch as a failure reason.

**The Problem:** The plan wrote the allow event before session/token issuance and said "if creation fails, the allow event remains." A credential race after verification would therefore produce an allow event for a login that returned 401. That breaks event accuracy and the "one event per attempt" rule.

**Resolution:** Browser login revalidates before writing the allow event and before creating the session. CLI writes the allow event only after `cliAuth.login` returns `issued`; a `credential_changed` result writes one deny, returns 401, and revokes the unopened family. OIDC writes the allow event after identity resolution and before session creation. If the CLI allow write fails, the family is revoked and the client gets 503. ST-98 covers the credential race.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: event ordering and credential issuance mechanism · Objective: the event reflects the final credential outcome · Decision: allow after recheck and before delivery; deny on credential change · Evidence: controller revalidation and CLI `credential_changed` paths · Rejected: allow before issuance (current, false allow); two events (breaks exact-one) · Strongest counterargument: a session-creation failure after authentication no longer has a deny event; mitigation: authentication succeeded, and the allow event is accurate; delivery failure is a separate operational error · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a session service that can report a credential change after issuance.

### PF-010: A writer on an empty table starts a zero-hash fork [🟠 MAJOR]

**Dimension:** Codebase Alignment
**Location:** `03-01-audit-core.md` §Writer step 6 and `previousHash`; `03-04-retention-operations.md` failure note
**Codebase Evidence:** Checkpoints survive event deletion; the plan's writer used zero bytes when no event existed and only honored `previousHash` when the prune caller supplied it.

**The Problem:** If all events were deleted (for example, a prune-event write failed after a successful delete), the next normal event used a zero `prev_hash` while the boundary checkpoint hash was non-zero. Verification then reported `prev_hash_mismatch`, contradicting the plan's claim that the retained chain was still valid. A concurrent audited write between the delete and the prune event had the same effect.

**Resolution:** When no retained event exists, the writer uses `options.previousHash` if provided, otherwise the latest checkpoint's `last_hash`, otherwise zero. The prune event still supplies the boundary hash explicitly; every other first event links to the retained anchor automatically. ST-95 extends to a subsequent normal event.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: chain continuation mechanism · Objective: no fork after a full prune or failed prune event · Decision: automatic latest-checkpoint fallback · Evidence: checkpoints survive deletion; zero-hash fork breaks verification · Rejected: fail closed until operator repair (viable but blocks login/audit indefinitely); zero hash (current, breaks chain) · Strongest counterargument: automatic fallback can make a truncation look like a prune; mitigation: the verifier reports truncation before the first new event, and off-box checkpoints are the external anchor · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a durable chain-tip row outside checkpoints.

### PF-011: Audit failures are not mapped to 503 across existing controllers [🟠 MAJOR]

**Dimension:** Completeness Gaps
**Location:** `03-03-audit-emitters.md` §Error Handling; `03-02-audit-api.md` §Error Mapping
**Codebase Evidence:** `apps/server/src/controllers/auth.ts:30-31,80-92`, `cli-auth.ts:29-32,81-84`, `oidc.ts:29-42`, and `agent.ts:15-25` map only their domain errors; `transport/pre-stack.ts:213-217` maps unknown errors to 500.

**The Problem:** The plan promised 503 for audit unavailability, but on the login, OIDC, and agent success paths an `AuditUnavailableError` would fall through to 500. The audit controller had a 503 mapping; the other surfaces did not.

**Resolution:** A shared controller helper maps `AuditUnavailableError` and its key subclass to 503 `service_unavailable`. Audit service methods wrap driver failures as `AuditUnavailableError` while leaving `AuditInputError` and `CanonicalJsonError` as 500 programmer errors. Auth, CLI, OIDC, identity, assignment, agent, and audit controllers use the helper. Forced-failure tests cover every emitter.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: HTTP error mapping inside the accepted fail-closed policy · Objective: consistent 503 without changing existing domain errors · Decision: shared mapping helper plus service-level wrapping · Evidence: current controller catch blocks and pre-stack fallback · Rejected: 500 (contract violation); per-controller ad hoc branches (drift) · Strongest counterargument: a shared helper can hide unexpected errors; mitigation: it matches only audit error classes · Confidence: High · Hardening: independent challenger confirmed · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a new error type that should not map to 503.

### PF-012: The export schema derivation throws under Zod 4 [🟠 MAJOR]

**Dimension:** Feasibility Concerns
**Location:** `03-02-audit-api.md` §Public Contracts
**Codebase Evidence:** `packages/api-contract/package.json:21` pins Zod 4.6.7. A live probe of `.omit()` on a `.superRefine()` object returned: `omit() cannot be used on object schemas containing refinements`.

**The Problem:** `auditExportQuerySchema = auditQuerySchema.omit({ limit: true, cursor: true })` would throw while the module was loading, taking down the API contract package.

**Resolution:** The plan now defines one `auditFilterShape` and one `validateAuditFilters` function, then builds `auditQuerySchema` and `auditExportQuerySchema` separately from that shape. No `.omit()` is used on a refined schema. The same validation (including `objectId` requiring `objectType`) applies to both.

**Delegated provenance:** Authority: AI — delegated by --auto-design · Eligibility: schema construction mechanism · Objective: list and export contracts load and share validation · Decision: shared shape plus shared refinement function · Evidence: Zod 4 probe · Rejected: `.omit()` (throws); duplicate shape without shared validation (drift) · Strongest counterargument: two schemas can diverge; mitigation: one shape and one validator · Confidence: High · Hardening: independent challenger confirmed with a live probe · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a Zod upgrade that permits `.omit()` after refinement.

### PF-013: Assignment mutation events have no object fields [🟡 MINOR]

**Dimension:** Completeness Gaps
**Location:** `03-01-audit-core.md` §Persistent Policy Adapter; `07-testing-strategy.md` ST-53
**Codebase Evidence:** `apps/server/src/rbac/audit.ts:47-72` has no object fields; `apps/server/src/database/schema.ts:421-425` allows null object columns.

**The Problem:** The mutation mapping added `projectId`, action, result, and details but never defined `objectType` or `objectId`. Assignment events could not be filtered by the public object filters, and the event shape was incomplete.

**Resolution:** Mutation events now use `objectType: "assignment"` and `objectId: assignmentId`. ST-53 asserts both.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: event mapping · Decision: assignment object identity · Rejected: leave null (unfilterable); use principal id (not the mutation object) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-014: `AuditQueryExecutor` and the audit error classes have no owner [🟡 MINOR]

**Dimension:** Dependency Issues
**Location:** `03-01-audit-core.md` signatures; `00-index.md` Related Files
**Codebase Evidence:** No audit directory exists; `apps/server/src/identity/identity-repository.ts` owns a `QueryExecutor` that audit should not import.

**The Problem:** `AuditQueryExecutor` appeared throughout the signatures but was never defined. Seven error classes appeared in behavior tables without an owning module. Implementers could import the identity layer or scatter errors.

**Resolution:** `03-01` defines a minimal `AuditQueryExecutor` and an `apps/server/src/audit/errors.ts` hierarchy. Task 1.2.2 and the related-files list include it.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: internal interface · Decision: local narrow executor and one error module · Rejected: import identity repository (layering violation); scatter errors (drift) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-015: Existing agent service tests break on required audit/context parameters [🟡 MINOR]

**Dimension:** Codebase Alignment
**Location:** `03-03-audit-emitters.md` §Agent Join and Renewal; `99-execution-plan.md` tasks 3.2.8/3.2.9
**Codebase Evidence:** `apps/server/tests/integration/agent-join.impl.test.ts:111,162,183,208`, `agent-renew.impl.test.ts:120`, and `agent-renew.spec.test.ts:397` construct services; `service.join({...})` is called with one argument.

**The Problem:** Adding a required audit recorder and context parameter would break these direct constructions and calls, so `pnpm typecheck` would fail before the new tests ran. The plan did not list them.

**Resolution:** Context is optional with an internal default; isolated tests use `RecordingAudit` or a no-op recorder. The existing test files are listed in tasks 3.2.8/3.2.9 and the related-files list; production never omits the recorder.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: test-harness impact · Decision: optional context plus explicit test updates · Rejected: required context (breaks tests); optional audit in production (weakens fail-closed) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-016: `SecureApplicationDependencies` needs an audit runtime but is not listed [🟡 MINOR]

**Dimension:** Dependency Issues
**Location:** `00-index.md` Related Files; `03-03-audit-emitters.md` §Composition
**Codebase Evidence:** `apps/server/src/transport/secure-application.ts:42-60` defines the dependency contract used by `createApplication`.

**The Problem:** Passing the audit runtime into `createApplication` requires an optional field on `SecureApplicationDependencies`; the plan did not mention the file, so the composition change was impact-blind.

**Resolution:** Add `apps/server/src/transport/secure-application.ts` to the related files and task 3.2.13, with an optional `auditRuntime` field.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: composition interface · Decision: optional dependency field · Rejected: global singleton (hidden coupling); cast (unsafe) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-017: Writer validation and ST-86 disagree on over-long user agents [🟡 MINOR]

**Dimension:** Testability
**Location:** `03-01-audit-core.md` §Writer step 1; `07-testing-strategy.md` ST-86
**Codebase Evidence:** `apps/server/src/database/schema.ts:428` enforces `length(user_agent) <= 512`; `03-03` truncates the request header; the policy adapter slices.

**The Problem:** Step 1 said "validate" the user agent and did not say truncate or reject, while ST-86 expected truncation. The writer also did not validate `scopeId`, `projectId`, or `actorId` against the public schema, so it could store a row that the API response schema rejects.

**Resolution:** The writer truncates `userAgent` to 512 and validates the other public bounds (`requestId`, `scopeId`, `objectType`, `objectId`, ULID fields). ST-86 states truncated storage; the chain still verifies.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: input validation within the event contract · Decision: truncate user agent, validate bounded fields · Rejected: reject user agent (turns a header into 503); skip validation (response parse failure) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-018: Export contract, filter normalization, and event semantics conflict [🟡 MINOR]

**Dimension:** Consistency
**Location:** `03-02-audit-api.md` §Controller, §Authorization, §Export Service
**Codebase Evidence:** The list schema defaults `limit` and allows `cursor`; the export streams the full range.

**The Problem:** Export parsed the list schema and said it ignored `limit` but still rejected out-of-range limits. The `audit.export` details used a "normalized filters" object that was never defined, and the text said "after a successful export" while the event was written before headers. A mid-stream failure left an allow event for an invalid file.

**Resolution:** Export uses `auditExportQuerySchema` (no `limit`/`cursor`). `normalizeAuditFilters` is the single filter object for cursor binding and details. `audit.export` is defined as an attempt event written after authorization and before headers; a mid-stream failure leaves it and writes no second event.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: HTTP contract and event semantics · Decision: separate export schema, normalized filters, attempt event · Rejected: reuse list schema (limit/cursor confusion); success-only event (cannot know before streaming) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-019: The plan claims an objectId index that the schema does not have [🟡 MINOR]

**Dimension:** Codebase Alignment
**Location:** `02-current-state.md`, `03-01-audit-core.md`, `00-ambiguity-register.md` AR-24
**Codebase Evidence:** `apps/server/src/database/schema.ts:444` defines `audit_events_object_idx` on `(object_type, object_id)`; there is no standalone `object_id` index.

**The Problem:** The plan said existing indexes cover all filters and RD-07 Should Have asks for an `objectId` index. An `objectId`-only query cannot use the leading column of the composite index efficiently.

**Resolution:** The API now rejects `objectId` without `objectType` (422), so the supported object filter uses the existing composite index. The plan states the paired-filter rule and drops the false "all filters covered" claim; no migration is added.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: query contract and performance mechanism · Decision: require paired object filters; no migration · Evidence: composite index order · Rejected: add a standalone index migration (larger surface for a Should Have with no current data route); allow scan (unbounded) · Strongest counterargument: a client with only an object id cannot query; mitigation: audit clients know the object type from the route or event context, and the error is explicit · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a data-plane client that needs objectId-only queries.

### PF-020: Checkpoint-level verify failures have no defined event id or range [🟡 MINOR]

**Dimension:** Testability
**Location:** `03-02-audit-api.md` §Verify Service and ST-40/ST-92
**Codebase Evidence:** `AuditVerifyResult` is a new contract; no implementation exists.

**The Problem:** The result contract allowed nullable `firstBrokenEventId` and `checkedRange`, but the plan did not say what to set for a bad checkpoint HMAC, an unavailable key, a missing checkpoint, or an empty table with a checkpoint. ST-40 and ST-92 used different implied values.

**Resolution:** The report defines: event-level failure → that event's ULID; checkpoint-level failure → null unless the failed anchor is the first retained event, then `firstId`; `checkedRange` is null when no event was successfully walked. ST-92 and ST-96 state the expected values.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: response contract · Decision: explicit null/event-id rules · Rejected: null always (ambiguity); firstId always (misattributes checkpoint failure) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-021: `sourceIp` is described as both raw and normalized [🟡 MINOR]

**Dimension:** Consistency
**Location:** `03-03-audit-emitters.md` §Shared Request Context; `03-01-audit-core.md` §Writer
**Codebase Evidence:** `apps/server/src/database/schema.ts:427` uses `inet`; `pg` returns canonical text without a mask (live probe: `2001:0db8::1` → `2001:db8::1`).

**The Problem:** `03-03` said the value was stored unchanged, while `03-01` said the writer normalizes it through `inet`. The hash must use the same canonical text on write and read.

**Resolution:** The helper returns raw `req.ip`; the writer normalizes through `SELECT CAST(:ip AS inet)` before hashing and persisting. ST-91 covers the canonical IPv6 value.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: serialization detail · Decision: raw input, writer normalization · Rejected: store raw text (hash drift on read); normalize in every caller (duplication) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-022: The prune CLI depends on the full server environment [🟡 MINOR]

**Dimension:** Feasibility Concerns
**Location:** `03-04-retention-operations.md` §CLI
**Codebase Evidence:** `apps/server/src/config/loader.ts` validates base URL, database URL, keyring, TLS certificate/key, internal CA, and other server settings before returning a config.

**The Problem:** The plan said the prune command loads the normal server config. A maintenance host without TLS/CA files could not run it, even though prune only needs the database, keyring, and retention.

**Resolution:** The plan documents that prune and checkpoint export run on the vault host or with the full server environment. This keeps one validated configuration contract and avoids a second partial loader. Revisit if a separate maintenance host becomes a requirement.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: CLI configuration surface · Decision: reuse the server environment and document it · Rejected: add a partial maintenance loader (new surface); weaken validation (unsafe) · Confidence: Medium — depends on deployment topology · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: an operator requirement to prune from a host without server TLS files.

### PF-023: An existing boundary checkpoint is not compared to the boundary event hash [🟡 MINOR]

**Dimension:** Consistency
**Location:** `03-04-retention-operations.md` §Prune Service step 7
**Codebase Evidence:** `checkpointAt` uses `ON CONFLICT (last_event_id) DO NOTHING`; an existing row could have a different `last_hash`.

**The Problem:** The plan verified the existing checkpoint's HMAC but did not require its `last_hash` to equal the boundary event's hash. A valid HMAC over a different hash would let prune delete the event and leave a mismatched anchor.

**Resolution:** Step 7 now requires both the HMAC and the hash equality; any mismatch aborts before delete. ST-93 covers a bad existing checkpoint.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: checkpoint verification · Decision: HMAC plus hash equality · Rejected: HMAC only (current, insufficient) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-024: A renewal replay writes no event, but the rule was unstated [🟡 MINOR]

**Dimension:** Edge Cases
**Location:** `03-03-audit-emitters.md` §Renew success
**Codebase Evidence:** `apps/server/src/agent/agent-renew-service.ts:209-211` returns a cached response before the transaction; `:313` populates the cache.

**The Problem:** The plan said one event per attempt but did not define whether a replay hit is a new attempt. The implementation returns a certificate without a new audit event, so a reader could treat it as missing coverage.

**Resolution:** A replay is the same issuance attempt, not a new one. The original `agent.renew` event is the evidence; no second event is written. ST-70 asserts the replay behavior.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: event semantics · Decision: no duplicate event for a replay · Rejected: audit every replay (duplicate noise); leave undefined (test ambiguity) · Confidence: Medium — depends on the intent of "attempt" · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001` · Reopen triggers: a requirement to count every HTTP request.

### PF-025: An object-scoped decision would violate the project-id check [🟡 MINOR]

**Dimension:** Codebase Alignment
**Location:** `03-01-audit-core.md` §Persistent Policy Adapter decision mapping
**Codebase Evidence:** `apps/server/src/database/schema.ts:436-438` requires `project_id` for `scope_type IN ('project','object')`; `apps/server/src/rbac/audit.ts:27` allows an `object` scope; `apps/server/src/rbac/policy-service.ts:136-149` currently returns project scope for secret/certificate resources, so no current emitter triggers it.

**The Problem:** The adapter derived `projectId` only when `scopeType === "project"`. A future object-scoped decision would write null and fail the database check. The type contract admitted the case, so the plan was latently unsafe.

**Resolution:** `PolicyDecisionEvent` gains `projectId`; `PolicyService.#toEvent` sets it from the evaluated resource; the adapter uses it for every scope. Current project-scoped decisions are unchanged; object scope is now correct.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: persistence mapping · Decision: carry projectId on decisions · Rejected: reject object scope (narrows the policy contract); derive from scopeId (not the project id) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-026: Writer step numbering repeats `7.` [🔵 OBSERVATION]

**Dimension:** Consistency
**Location:** `03-01-audit-core.md` §Writer
**The Problem:** Two consecutive steps were numbered `7`, which makes cross-references ambiguous.

**Resolution:** Renumbered: 7 insert, 8 checkpoint, 9 return, 10 zero.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: document formatting · Decision: sequential numbering · Rejected: leave as is (ambiguous) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-027: The action catalog code block was a misleading subset [🔵 OBSERVATION]

**Dimension:** Consistency
**Location:** `03-01-audit-core.md` §Action Catalog
**Codebase Evidence:** `packages/api-contract/src/rbac.ts:15-41` defines the 25 policy actions.

**The Problem:** The prose said all 25 RBAC actions were included, but the code block showed a subset and omitted `identity.read`. A literal implementation could fail ST-85.

**Resolution:** The catalog now derives `AUDIT_ACTIONS` from `RBAC_ACTIONS` plus `BUSINESS_AUDIT_ACTIONS`, so drift is structurally impossible. ST-85 remains the guard.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: naming catalog · Decision: derive from the policy catalog · Rejected: duplicate list (drift); subset block (fails ST-85) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-028: The security limitations text is broader than the verifier behavior [🔵 OBSERVATION]

**Dimension:** Consistency
**Location:** `docs/security/limitations.md:13-14` (context); `03-04-retention-operations.md` §Documentation
**The Problem:** The limitation said audit truncation is detected if a checkpoint survives. A prefix deleted at a prune boundary leaves a surviving boundary checkpoint and is treated as a legitimate prune; only an off-box anchor distinguishes it. The plan did not update the text.

**Resolution:** The documentation task now updates `docs/security/limitations.md` to distinguish tail truncation (detected by checkpoints) from prefix truncation at a prune boundary (requires an off-box anchor).

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: documentation accuracy · Decision: update the limitation · Rejected: leave broad text (misleads operators) · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

### PF-029: "No checkpoint change" on a no-op prune is ambiguous [🔵 OBSERVATION]

**Dimension:** Consistency
**Location:** `07-testing-strategy.md` ST-76; `03-04-retention-operations.md` §Prune Service
**The Problem:** A no-op prune still appends `audit.prune`; the writer may also create a due cadence checkpoint. "No checkpoint change" could be read as forbidding any checkpoint.

**Resolution:** ST-76 now says "no boundary checkpoint change"; the cadence checkpoint behavior is unchanged.

**Provenance:** Authority: AI — delegated by --auto-design · Eligibility: test wording · Decision: boundary-specific wording · Rejected: ambiguous blanket statement · Confidence: High · Policy version: 1 · Root invocation ID: `rd-07-audit-preflight-20261104-001`.

---

## Iteration 2 Verification

The corrective edits were checked against the unchanged audit target:

| Check | Result |
|---|---|
| Required plan documents | 10/10 present; preflight report added |
| Internal links | All resolve |
| Execution tasks | 73 unique; phases 17/17/24/15; header 0/73 |
| Specification cases | 98 unique and contiguous (1–98) |
| Ambiguity register | 28/28 resolved; 0 open or deferred; preflight revisions recorded |
| Specification-first ordering | Phase 1/2/3/4 all place spec tests before implementation |
| Trailing whitespace / `git diff --check` | Clean |
| Zod 4 export-schema probe | Corrected shape avoids the `.omit()` runtime failure |
| Pruner privilege probe | DELETE-only denied with 42501; SELECT+DELETE succeeded |
| Status | Planning Complete; no task checkboxes marked complete |

**No new critical/major findings were introduced.** The four observations are documentation/wording fixes only.

## Pass Verdict

**✅ PREFLIGHT PASSED — all 29 findings resolved.**

All critical and major findings are resolved in the plan documents. The remaining observations are resolved as wording/consistency edits. A fresh-session or human security review is still recommended before execution because the same session created and reviewed the plan and the hash-chain verification path is security-critical.

## Next Steps

| Action | Owner |
|---|---|
| Execute RD-07 with `exec-plan` | Next session |
| Run a fresh-session review of the verification algorithm and prune gate | Security reviewer |
| Start with Phase 1 spec tests (ST-1–ST-22, ST-91) and keep the red phase evidence | Executor |

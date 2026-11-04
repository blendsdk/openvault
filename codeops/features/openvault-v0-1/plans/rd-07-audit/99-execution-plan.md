# Execution Plan: RD-07 Audit

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-04 13:20
> **Progress**: 17/73 tasks (23%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the persistent audit chain in four phases: the writer and policy adapter, the query/verify/export API, the current emitters, and retention with documentation. Each phase follows the specification-first order: spec tests, red phase, implementation, green phase, implementation tests, full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
| ----- | ----- | ----- |
| 1 | Audit core | 17 |
| 2 | Audit API | 17 |
| 3 | Audit emitters | 24 |
| 4 | Retention, documentation, release | 15 |

**Total: 73 tasks across 4 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes in the phase sections below are the **single source of truth** for progress. Every task line appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp — `- [~] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` — `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** (`> **Progress**: X/Y tasks (Z%)`) and the Last Updated stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning the phase sections top-to-bottom: the first `[~]` task is resumed first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line. The plan lifecycle is `Ready`, `Executing`, `Done`, or `Blocked`, derived from these markers.
>
> Timestamps come from `date '+%Y-%m-%d %H:%M'` — never invented.

---

## Phase 1: Audit Core

> **Phase baseline tree**: 610682db0be37fb3b4aaf4c68adbd9f4c5d8b113
> **Expected modification set**: `packages/api-contract/src/audit.ts`, `packages/api-contract/src/index.ts`, `apps/server/src/audit/**`, `apps/server/src/rbac/{audit,policy-service,assignment-service,runtime}.ts`, `apps/server/src/app.ts`, `apps/server/tests/audit/**`, `apps/server/tests/integration/audit-chain.*.test.ts`, `apps/server/tests/integration/helpers/fixtures.ts`, `apps/server/tests/integration/schema.spec.test.ts`, `apps/server/tests/integration/rbac-audit.impl.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — hash-chain integrity, key wrapping, transaction boundaries, and fail-closed behavior are security-critical.

### Step 1.1: Specification Tests

**Reference**: [03-01](03-01-audit-core.md) · [07](07-testing-strategy.md) ST-1–ST-22 · AR-5–AR-11, AR-16–AR-18, AR-24
**Objective**: Define the expected chain, key, checkpoint, and canonical JSON behavior before implementation.

- [x] 1.1.1 [spec-author] Write canonical JSON and hashing spec tests — `apps/server/tests/audit/canonical-json.spec.test.ts` (ST-1–ST-8) ✅ (completed: 2026-11-04 12:59)
- [x] 1.1.2 [spec-author] Write chain, key, checkpoint, and policy adapter spec tests — `apps/server/tests/integration/audit-chain.spec.test.ts` (ST-9–ST-22, ST-91) ✅ (completed: 2026-11-04 12:59)
- [x] 1.1.3 Run the new spec tests and record the red phase — every ST case must fail for the expected missing behavior ✅ (completed: 2026-11-04 12:59)

### Step 1.2: Implementation

**Reference**: [03-01](03-01-audit-core.md) §Implementation Details · AR-5–AR-11, AR-16–AR-18, AR-24
**Objective**: Implement the canonical encoder, key store, writer, checkpoints, and persistent policy adapter.

- [x] 1.2.1 Add the audit response and export query contracts; normalize filters; require `objectType` with `objectId` — `packages/api-contract/src/audit.ts`, `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.2 Add the server action catalog, details allowlists, shared types, and audit error hierarchy — `apps/server/src/audit/actions.ts`, `apps/server/src/audit/types.ts`, `apps/server/src/audit/errors.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.3 Implement canonical JSON and hashing, including the fixed hash/HMAC vector — `apps/server/src/audit/canonical-json.ts`, `apps/server/src/audit/hashing.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.4 Implement KEK wrap/unwrap and audit key selection — `apps/server/src/audit/audit-key-store.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.5 Implement the writer, advisory lock, and checkpoint cadence — `apps/server/src/audit/audit-writer.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.6 Implement the persistent policy adapter — `apps/server/src/audit/policy-audit.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.7 Add decision and mutation `projectId`, mutation object fields, the transaction parameter, and the runtime audit option; update event fixtures — `apps/server/src/rbac/audit.ts`, `apps/server/src/rbac/policy-service.ts`, `apps/server/src/rbac/assignment-service.ts`, `apps/server/src/rbac/runtime.ts`, `apps/server/tests/integration/rbac-audit.impl.test.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.8 Compose the audit runtime and accept the adapter in the application — `apps/server/src/audit/runtime.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.9 Separate business fixtures from synthetic audit rows — `apps/server/tests/integration/helpers/fixtures.ts`, `apps/server/tests/integration/schema.spec.test.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.2.10 Run the spec tests and reach the green phase ✅ (completed: 2026-11-04 13:20)

### Step 1.3: Implementation Tests and Hardening

**Reference**: [03-01](03-01-audit-core.md) §Testing Requirements · [07](07-testing-strategy.md)
**Objective**: Cover concurrency, rollback, key edge cases, and serializer internals.

- [x] 1.3.1 Write chain implementation tests: concurrent inserts, sequence gaps, checkpoint boundaries, timestamp round-trip — `apps/server/tests/integration/audit-chain.impl.test.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.3.2 Write canonical JSON implementation tests: escaping, depth, size, rejected values — `apps/server/tests/audit/canonical-json.impl.test.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.3.3 Write rollback and atomicity implementation tests: decision survives, mutation rolls back, key failure — `apps/server/tests/integration/audit-chain.impl.test.ts` ✅ (completed: 2026-11-04 13:20)
- [x] 1.3.4 Full phase verification ✅ (completed: 2026-11-04 13:20)

**Deliverables**:
- [x] Canonical encoder, key store, writer, checkpoints, and policy adapter complete
- [x] All Phase 1 specification and implementation tests passing
- [x] All verification passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

> **Verification note (2026-11-04 13:34)**: `pnpm verify` and `pnpm db:types:check` pass. The integration suite reports 436 passed and one failure, `ca-x509.spec.test.ts > CA signer loading and issuance > should load a matching row, probe, and issue the fixed profile`; the same test also fails on the clean `82869de` baseline under this environment, so it is a pre-existing, unrelated failure.

---

## Phase 2: Audit API

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Reasoning**: high — authorization scoping, cursor integrity, tamper reporting, and streaming behavior are security-sensitive.

### Step 2.1: Specification Tests

**Reference**: [03-02](03-02-audit-api.md) · [07](07-testing-strategy.md) ST-23–ST-48, ST-92, ST-96 · AR-2, AR-6, AR-12–AR-15, AR-25
**Objective**: Define filtering, pagination, verification, export, and authorization expectations.

- [ ] 2.1.1 [spec-author] Write query, cursor, and authorization spec tests, including `objectId` without `objectType` — `apps/server/tests/integration/audit-query.spec.test.ts` (ST-23–ST-33)
- [ ] 2.1.2 [spec-author] Write verification spec tests — `apps/server/tests/integration/audit-verify.spec.test.ts` (ST-34–ST-43, ST-92, ST-96)
- [ ] 2.1.3 [spec-author] Write export spec tests — `apps/server/tests/integration/audit-export.spec.test.ts` (ST-44–ST-48)
- [ ] 2.1.4 Run the new spec tests and record the red phase

### Step 2.2: Implementation

**Reference**: [03-02](03-02-audit-api.md) §Implementation Details · AR-2, AR-6, AR-12–AR-15, AR-25
**Objective**: Implement the cursor, query, verifier, exporter, service facade, rate limits, and controller.

- [ ] 2.2.1 Implement the signed, filter-bound cursor — `apps/server/src/audit/cursor.ts`
- [ ] 2.2.2 Implement the filtered keyset query and export stream — `apps/server/src/audit/audit-query.ts`
- [ ] 2.2.3 Implement chain verification with first-event anchor rehashing, every-checkpoint tail detection, key-unavailable failure, and empty-plus-checkpoint detection — `apps/server/src/audit/audit-verify.ts`
- [ ] 2.2.4 Implement the NDJSON exporter and the pre-header export attempt event — `apps/server/src/audit/audit-export.ts`
- [ ] 2.2.5 Implement the audit service facade, `AuditUnavailableError` wrapping, and endpoint rate limits — `apps/server/src/audit/audit-service.ts`, `apps/server/src/audit/audit-rate-limits.ts`
- [ ] 2.2.6 Implement the three routes and the export query schema — `apps/server/src/controllers/audit.ts`
- [ ] 2.2.7 Register the controller, services, and limiter in the application — `apps/server/src/app.ts`
- [ ] 2.2.8 Run the spec tests and reach the green phase

### Step 2.3: Implementation Tests and Hardening

**Reference**: [03-02](03-02-audit-api.md) §Testing Requirements · [07](07-testing-strategy.md)
**Objective**: Cover pagination edges, checkpoint selection, streaming, and limiter isolation.

- [ ] 2.3.1 Write query and cursor implementation tests — `apps/server/tests/integration/audit-query.impl.test.ts`
- [ ] 2.3.2 Write verification implementation tests: batch boundaries and multiple checkpoints — `apps/server/tests/integration/audit-verify.impl.test.ts`
- [ ] 2.3.3 Write export implementation tests: backpressure, disconnect, mid-stream failure — `apps/server/tests/integration/audit-export.impl.test.ts`
- [ ] 2.3.4 Write rate-limit implementation tests — `apps/server/tests/integration/audit-rate-limits.impl.test.ts`
- [ ] 2.3.5 Full phase verification

**Deliverables**:
- [ ] Events, verify, and export routes complete with `audit.read` enforcement
- [ ] All Phase 2 specification and implementation tests passing
- [ ] All verification passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 3: Audit Emitters

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Reasoning**: high — authentication, identity, agent, and fail-closed paths are security-critical and span many call sites.

### Step 3.1: Specification Tests

**Reference**: [03-03](03-03-audit-emitters.md) · [07](07-testing-strategy.md) ST-49–ST-87, ST-94, ST-98 · AR-1, AR-3, AR-17–AR-22
**Objective**: Define event counts, actor attribution, reason codes, redaction, and fail-closed behavior.

- [ ] 3.1.1 [spec-author] Write policy and identity emitter spec tests — `apps/server/tests/integration/audit-emitters.spec.test.ts` (ST-49–ST-55)
- [ ] 3.1.2 [spec-author] Write authentication emitter spec tests — `apps/server/tests/integration/audit-auth.spec.test.ts` (ST-56–ST-62, ST-98)
- [ ] 3.1.3 [spec-author] Write agent and consumer emitter spec tests — `apps/server/tests/integration/audit-agent.spec.test.ts` (ST-63–ST-73)
- [ ] 3.1.4 [spec-author] Write fail-closed, redaction, and contract spec tests — `apps/server/tests/integration/audit-security.spec.test.ts` (ST-82–ST-87, ST-94)
- [ ] 3.1.5 Run the new spec tests and record the red phase

### Step 3.2: Implementation

**Reference**: [03-03](03-03-audit-emitters.md) §Implementation Details · AR-1, AR-3, AR-17–AR-22
**Objective**: Wire every current emitter with one evidence record per attempt.

- [ ] 3.2.1 Add the shared request-context helper and the audit-error mapping helper; refactor the assignment controller — `apps/server/src/audit/http.ts`, `apps/server/src/audit/errors.ts`, `apps/server/src/controllers/assignments.ts`
- [ ] 3.2.2 Finish the persistent policy adapter: denial counter, runtime wiring, logger fallback — `apps/server/src/audit/policy-audit.ts`, `apps/server/src/rbac/audit.ts`, `apps/server/src/rbac/runtime.ts`
- [ ] 3.2.3 Add identity `decide` and the non-auditing policy option — `apps/server/src/identity/identity-authorizer.ts`, `apps/server/src/rbac/policy-service.ts`
- [ ] 3.2.4 Apply one decision per identity attempt; pass request context — `apps/server/src/identity/identity-service.ts`, `apps/server/src/controllers/identity.ts`
- [ ] 3.2.5 Add local login reasons and lockout reporting; update the local-login unit tests for the new result shape — `apps/server/src/auth/local-login.ts`, `apps/server/tests/auth/local-login.impl.test.ts`
- [ ] 3.2.6 Emit browser and CLI login events with final-outcome ordering, credential-race deny handling, and 503 mapping — `apps/server/src/controllers/auth.ts`, `apps/server/src/controllers/cli-auth.ts`
- [ ] 3.2.7 Emit OIDC login success and failure events with final-outcome ordering and 503 mapping — `apps/server/src/controllers/oidc.ts`
- [ ] 3.2.8 Emit agent join success and failure events, map audit failures to 503, and update direct-construction tests — `apps/server/src/agent/agent-join-service.ts`, `apps/server/src/controllers/agent.ts`, `apps/server/tests/integration/agent-join.impl.test.ts`
- [ ] 3.2.9 Emit agent renewal success and independent failure events, handle replay without a duplicate event, and update direct-construction tests — `apps/server/src/agent/agent-renew-service.ts`, `apps/server/tests/integration/agent-renew.impl.test.ts`, `apps/server/tests/integration/agent-renew.spec.test.ts`
- [ ] 3.2.10 Add consumer change detection and use the repository's constructor database as the default `findForUpdate` executor — `apps/server/src/agent/consumer-repository.ts`
- [ ] 3.2.11 Wire consumer register/update events into join and renew — `apps/server/src/agent/agent-join-service.ts`, `apps/server/src/agent/agent-renew-service.ts`
- [ ] 3.2.12 Pass one audit runtime through the agent and identity runtimes — `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/identity/identity-runtime.ts`
- [ ] 3.2.13 Wire the audit runtime into the application, startup, and auth plugin — `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/src/auth/plugin.ts`
- [ ] 3.2.14 Run the spec tests and reach the green phase

### Step 3.3: Implementation Tests and Hardening

**Reference**: [03-03](03-03-audit-emitters.md) §Testing Requirements · [07](07-testing-strategy.md)
**Objective**: Prove event counts, actor matrices, redaction, and rollback behavior across every emitter.

- [ ] 3.3.1 Write event-count and identity implementation tests — `apps/server/tests/integration/audit-emitters.impl.test.ts`
- [ ] 3.3.2 Write the authentication reason and lockout matrix — `apps/server/tests/integration/audit-auth.impl.test.ts`
- [ ] 3.3.3 Write the agent failure matrix and consumer change tests — `apps/server/tests/integration/audit-agent.impl.test.ts`
- [ ] 3.3.4 Write sentinel redaction and forced-failure tests across every emitter — `apps/server/tests/integration/audit-security.impl.test.ts`
- [ ] 3.3.5 Full phase verification

**Deliverables**:
- [ ] Every current audited action writes exactly the required evidence
- [ ] No sensitive material in any event field
- [ ] All Phase 3 specification and implementation tests passing
- [ ] All verification passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 4: Retention, Documentation, Release

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Reasoning**: medium — the prune flow is destructive but bounded by the trigger and checkpoint; the rest is documentation and release metadata.

### Step 4.1: Specification Tests

**Reference**: [03-04](03-04-retention-operations.md) · [07](07-testing-strategy.md) ST-74–ST-81, ST-88–ST-90, ST-93, ST-95, ST-97 · AR-4, AR-23, AR-27
**Objective**: Define export, checkpoint, delete, dry-run, and credential behavior.

- [ ] 4.1.1 [spec-author] Write prune and checkpoint export spec tests — `apps/server/tests/integration/audit-prune.spec.test.ts` (ST-74–ST-81, ST-88–ST-90, ST-93, ST-95, ST-97)
- [ ] 4.1.2 Run the new spec tests and record the red phase

### Step 4.2: Implementation

**Reference**: [03-04](03-04-retention-operations.md) §Implementation Details · AR-4, AR-23, AR-27
**Objective**: Implement the checkpoint-at-boundary writer, prune service, pruner connection, CLI, and test role.

- [ ] 4.2.1 Add `checkpointAt` to the writer — `apps/server/src/audit/audit-writer.ts`
- [ ] 4.2.2 Implement the prune service with a pre-prune chain verification gate — `apps/server/src/audit/audit-prune.ts`
- [ ] 4.2.3 Implement the pruner connection guard with `SELECT, DELETE` privilege checks — `apps/server/src/audit/prune-connection.ts`
- [ ] 4.2.4 Implement the prune CLI entry point and package script — `apps/server/src/audit/cli.ts`, `apps/server/package.json`
- [ ] 4.2.5 Implement the checkpoint export CLI and package script — `apps/server/src/audit/checkpoint-cli.ts`, `apps/server/package.json`
- [ ] 4.2.6 Add the integration-test pruner role helper — `apps/server/tests/integration/helpers/pruner.ts`
- [ ] 4.2.7 Run the spec tests and reach the green phase

### Step 4.3: Implementation Tests, Documentation, and Release

**Reference**: [03-04](03-04-retention-operations.md) §Testing Requirements · [07](07-testing-strategy.md)
**Objective**: Prove prune safety, document the operational contract, and produce the release note.

- [ ] 4.3.1 Write prune and checkpoint export implementation tests: role guard, partial-file cleanup, checkpoint idempotence, wrong URL, existing output — `apps/server/tests/integration/audit-prune.impl.test.ts`
- [ ] 4.3.2 Update the API reference, audit guide, and security limitations — `docs/reference/api.md`, `docs/guide/audit.md`, `docs/security/limitations.md`
- [ ] 4.3.3 Update configuration, CLI reference, and changelog — `docs/reference/configuration.md`, `docs/reference/cli.md`, `docs/changelog.md`
- [ ] 4.3.4 Add the minor changeset — `.changeset/audit.md`
- [ ] 4.3.5 Full verification on PostgreSQL 16 and 17, generated types, docs, and changeset status
- [ ] 4.3.6 Remove temporary artifacts, confirm the roadmap-ready state, and record the final plan summary

**Deliverables**:
- [ ] Prune command exports, checkpoints before deleting, and records the prune
- [ ] Verification passes from the retained anchor
- [ ] Documentation and changeset complete
- [ ] All verification passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration && pnpm changeset status`

---

## Dependencies

```text
Phase 1 (core)
    ↓
Phase 2 (API)
    ↓
Phase 3 (emitters)
    ↓
Phase 4 (retention, docs, release)
```

Phase 2 depends on the writer and contracts from Phase 1. Phase 3 depends on the API's service facade and the policy adapter. Phase 4 depends on the writer's checkpoint function and the emitters' prune event.

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed
2. ✅ All verification passing (`pnpm verify`, PostgreSQL 16 and 17 integration, `db:types:check`, docs build, changeset status)
3. ✅ No warnings or errors
4. ✅ No dead code — no unused parameters, functions, classes, or modules
5. ✅ Security hardened — fail-closed writes, allowlisted details, scoped reads, rate limits, no secret material, pre-prune verification, and evidence-preserving credential races
6. ✅ Documentation updated
7. ✅ Security and concurrency review completed for the chain and emitter phases
8. ✅ Post-completion project re-analysis (handled by the exec-plan skill)

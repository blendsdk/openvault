# Execution Plan: RD-08 Projects and Secrets

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-04 17:35
> **Progress**: 19/65 tasks (29%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement RD-08 in four phases: contracts and projects, secret core read/write with
idempotency, lifecycle with purge and consumers, then documentation and release. Each phase
follows the specification-first order: spec tests, red phase, implementation, green phase,
implementation tests, full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Contracts, crypto, and projects | 19 |
| 2 | Secret core and idempotency | 18 |
| 3 | Lifecycle, expiry, consumers, and purge | 15 |
| 4 | Documentation and release | 13 |

**Total: 65 tasks across 4 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes in the phase sections below are the **single source of truth** for progress. Every task line appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp — `- [~] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` — `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** and Last Updated stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning top-to-bottom: the first `[~]` task is resumed first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line.

---

## Phase 1: Contracts, Crypto, and Projects

> **Phase baseline tree**: 00b8ed0e77237fc8b7640a25b48bbf34991e1c2e
> **Expected modification set**: `packages/api-contract/src/{projects,secrets,index}.ts`, `packages/api-contract/tests/{projects,secrets}.*.test.ts`, `packages/core/src/{crypto,keyring}.ts`, `packages/core/tests/`, `apps/server/src/security/keyring.ts`, `apps/server/src/projects/**`, `apps/server/src/rbac/{audit,policy-service,policy-repository,assignment-service}.ts`, `apps/server/src/audit/policy-audit.ts`, `apps/server/src/audit/audit-writer.ts`, `apps/server/src/controllers/projects.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/projects.*.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — the contracts, keyring port, and AAD bind the security boundary for every later secret operation.

### Step 1.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-1..27 · [03-01](03-01-contracts-crypto.md) · [03-02](03-02-projects.md) · AR-1..4, AR-7, AR-26, AR-27
**Objective**: Define contracts, envelope behavior, and project lifecycle before code.

- [x] 1.1.1 [spec-author] Write project contract specification tests — `packages/api-contract/tests/projects.spec.test.ts` (ST-1..3) ✅ (completed: 2026-11-04 17:20)
- [x] 1.1.2 [spec-author] Write secret contract specification tests — `packages/api-contract/tests/secrets.spec.test.ts` (ST-4..9) ✅ (completed: 2026-11-04 17:20)
- [x] 1.1.3 [spec-author] Write envelope AAD, validation, and keyring-port specification tests — `packages/core/tests/envelope-aad.spec.test.ts` (ST-10..17) ✅ (completed: 2026-11-04 17:20)
- [x] 1.1.4 [spec-author] Write project lifecycle, visibility, and access-explain specification tests — `apps/server/tests/integration/projects.spec.test.ts` (ST-18..27) ✅ (completed: 2026-11-04 17:20)
- [x] 1.1.5 Run the new spec tests and record the red phase ✅ (completed: 2026-11-04 17:20)

### Step 1.2: Implementation

**Reference**: [03-01 §Crypto Change](03-01-contracts-crypto.md) · [03-02 §Implementation](03-02-projects.md) · AR-1..4, AR-7, AR-26, AR-27
**Objective**: Land contracts, the keyring-compatible envelope, project lifecycle, and visibility.

- [x] 1.2.1 Add project contracts and exports — `packages/api-contract/src/projects.ts`, `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.2 Add secret contracts and exports — `packages/api-contract/src/secrets.ts`, `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.3 Add `EnvelopeKeyring`, object/project AAD, and strict envelope validation — `packages/core/src/crypto.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.4 Implement the envelope port on `KeyringProvider` — `apps/server/src/security/keyring.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.5 Update existing crypto tests for the AAD and keyring shape — `packages/core/tests/crypto.test.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.6 Add the project repository and domain errors — `apps/server/src/projects/{repository,errors}.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.7 Add the project service with chain-first joined decisions — `apps/server/src/projects/service.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.8 Add the joinable decision mode and explicit chain lock — `apps/server/src/rbac/audit.ts`, `apps/server/src/audit/policy-audit.ts`, `apps/server/src/audit/audit-writer.ts`, `apps/server/src/rbac/policy-service.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.9 Hide assignments, objects, and explain candidates for deleted projects; map hidden assignment-create resources to 404 — `apps/server/src/rbac/policy-repository.ts`, `apps/server/src/rbac/assignment-service.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.10 Add the project controller and register it — `apps/server/src/controllers/projects.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.2.11 Run the spec tests and reach the green phase ✅ (completed: 2026-11-04 17:35)

### Step 1.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-23
**Objective**: Cover project edge cases and prove the phase with the full gates.

- [x] 1.3.1 Write project implementation tests — `apps/server/tests/integration/projects.impl.test.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.3.2 Write contract implementation tests — `packages/api-contract/tests/projects.impl.test.ts` ✅ (completed: 2026-11-04 17:35)
- [x] 1.3.3 Full phase verification ✅ (completed: 2026-11-04 17:35)

**Deliverables**:
- [x] Project contracts, envelope v2/keyring port, project lifecycle, and visibility complete
- [x] All Phase 1 specification and implementation tests passing
- [x] `pnpm verify`, `pnpm db:types:check`, and the project integration tests passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 2: Secret Core and Idempotency

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Expected modification set**: `apps/server/src/secrets/{repository,envelope,idempotency,service,errors,rate-limits,runtime}.ts`, `apps/server/src/controllers/secrets.ts`, `apps/server/src/rbac/policy-service.ts`, `apps/server/src/app.ts`, `packages/api-contract/tests/secrets.impl.test.ts`, `apps/server/tests/integration/secrets*.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — value confidentiality, immutable versions, idempotency, and joined audit evidence are security- and integrity-critical.

### Step 2.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-28..56, ST-76..86 · [03-03](03-03-secrets.md) · AR-5..12, AR-15..18, AR-25, AR-29..31
**Objective**: Define secret create/write/read/list, idempotency, consumers, capabilities, and routes.

- [ ] 2.1.1 [spec-author] Write secret core specification tests — `apps/server/tests/integration/secrets.spec.test.ts` (ST-28..47, ST-76..81)
- [ ] 2.1.2 [spec-author] Write idempotency specification tests — `apps/server/tests/integration/secrets-idempotency.spec.test.ts` (ST-48..56)
- [ ] 2.1.3 [spec-author] Write HTTP route specification tests — `apps/server/tests/integration/secrets-http.spec.test.ts` (ST-82..86)
- [ ] 2.1.4 Run the new spec tests and record the red phase

### Step 2.2: Implementation

**Reference**: [03-03 §Repository](03-03-secrets.md) · [03-03 §Idempotency](03-03-secrets.md) · AR-5..12, AR-15..18, AR-25, AR-29..31
**Objective**: Implement secret storage, encryption, read/write flows, list, versions, capabilities, and idempotency.

- [ ] 2.2.1 Add the secret repository with name reservation, active versions, consumers, and list filters — `apps/server/src/secrets/repository.ts`
- [ ] 2.2.2 Add value decoding, response encoding, and envelope mapping — `apps/server/src/secrets/envelope.ts`
- [ ] 2.2.3 Add the HKDF-derived KEK-HMAC idempotency claim and replay helper — `apps/server/src/secrets/idempotency.ts`
- [ ] 2.2.4 Add the secret domain errors — `apps/server/src/secrets/errors.ts`
- [ ] 2.2.5 Add multi-resource capability projection — `apps/server/src/rbac/policy-service.ts`
- [ ] 2.2.6 Implement create, value write, read, list, and versions with version-detail audit events and the agent consumer touch — `apps/server/src/secrets/service.ts`
- [ ] 2.2.7 Implement consumer summaries and capability attachment — `apps/server/src/secrets/service.ts`
- [ ] 2.2.8 Add the data-plane rate limiter — `apps/server/src/secrets/rate-limits.ts`
- [ ] 2.2.9 Add the secret controller with the agent value-read branch — `apps/server/src/controllers/secrets.ts`
- [ ] 2.2.10 Compose the data runtime and register services/controllers — `apps/server/src/secrets/runtime.ts`, `apps/server/src/app.ts`
- [ ] 2.2.11 Run the spec tests and reach the green phase

### Step 2.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-23
**Objective**: Cover repository, envelope, concurrency, and idempotency edges.

- [ ] 2.3.1 Write secret core implementation tests — `apps/server/tests/integration/secrets.impl.test.ts`
- [ ] 2.3.2 Write secret contract implementation tests — `packages/api-contract/tests/secrets.impl.test.ts`
- [ ] 2.3.3 Full phase verification

**Deliverables**:
- [ ] Create, write, read, list, versions, capabilities, consumers, and idempotency complete
- [ ] All Phase 2 specification and implementation tests passing
- [ ] `pnpm verify`, `pnpm db:types:check`, and the secret integration tests passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 3: Lifecycle, Expiry, Consumers, and Purge

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Expected modification set**: `apps/server/src/config/{types,loader,redact}.ts`, `apps/server/src/transport/pre-stack.ts`, `apps/server/src/secrets/{service,repository,purge,errors}.ts`, `apps/server/src/controllers/secrets.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/helpers/purger.ts`, `apps/server/tests/integration/secrets-lifecycle.*.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — destructive purge, retention, protection, and expiry must fail closed and match the database triggers.

### Step 3.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-57..75, ST-87 · [03-04](03-04-lifecycle-purge.md) · AR-8, AR-13, AR-14, AR-19, AR-22, AR-28, AR-29, AR-32
**Objective**: Define metadata update, delete, recovery, protection, expiry, and purge.

- [ ] 3.1.1 [spec-author] Write lifecycle, expiry, purge, and leakage specification tests — `apps/server/tests/integration/secrets-lifecycle.spec.test.ts` (ST-57..75, ST-87)
- [ ] 3.1.2 Add the disposable purge-role helper — `apps/server/tests/integration/helpers/purger.ts`
- [ ] 3.1.3 Run the lifecycle spec tests and record the red phase

### Step 3.2: Implementation

**Reference**: [03-04 §Metadata Update](03-04-lifecycle-purge.md) · [03-04 §Purge](03-04-lifecycle-purge.md) · AR-8, AR-13, AR-14, AR-19, AR-22, AR-28, AR-29, AR-32
**Objective**: Implement every post-create lifecycle rule and the dedicated purge path.

- [ ] 3.2.1 Add optional `OPENVAULT_PURGE_DB_URL` and clamp the value limit — `apps/server/src/config/{types,loader,redact}.ts`
- [ ] 3.2.2 Raise the JSON parser limit and apply the `/v1/data` and legacy per-path guards — `apps/server/src/transport/pre-stack.ts`, `apps/server/src/config/types.ts`
- [ ] 3.2.3 Implement metadata update and protection transitions — `apps/server/src/secrets/service.ts`
- [ ] 3.2.4 Implement soft delete and recovery with the retention boundary — `apps/server/src/secrets/service.ts`
- [ ] 3.2.5 Implement expiry fallback, the one-event read outcome, and the retained-version limit — `apps/server/src/secrets/service.ts`, `apps/server/src/secrets/repository.ts`
- [ ] 3.2.6 Add the purge connection with database/role-membership guards, project lock, and name lock — `apps/server/src/secrets/purge.ts`
- [ ] 3.2.7 Implement the purge flow with exactly one outcome event — `apps/server/src/secrets/service.ts`
- [ ] 3.2.8 Compose and dispose the purge pool in the application — `apps/server/src/app.ts`
- [ ] 3.2.9 Add the lifecycle controller handlers — `apps/server/src/controllers/secrets.ts`
- [ ] 3.2.10 Run the lifecycle spec tests and reach the green phase

### Step 3.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-23
**Objective**: Prove role guards, purge failures, expiry boundaries, and name reservation.

- [ ] 3.3.1 Write lifecycle implementation tests — `apps/server/tests/integration/secrets-lifecycle.impl.test.ts`
- [ ] 3.3.2 Full phase verification

**Deliverables**:
- [ ] Metadata, delete, recovery, protection, expiry, version limit, and purge complete
- [ ] All Phase 3 specification and implementation tests passing
- [ ] `pnpm verify`, `pnpm db:types:check`, and the lifecycle integration tests passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 4: Documentation and Release

> **Phase baseline tree**: _(recorded by the exec-plan skill from a temporary-index snapshot of committed, staged, unstaged, and untracked phase-start state)_
> **Expected modification set**: `docs/reference/api.md`, `docs/guide/secrets.md`, `docs/reference/configuration.md`, `docs/architecture/crypto.md`, `docs/.vitepress/config.ts`, `docs/security/limitations.md`, `docs/changelog.md`, `.changeset/secrets.md`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: medium — the behavior is implemented; the remaining risk is documentation drift and release metadata.

### Step 4.1: Documentation

**Reference**: [00-index.md](00-index.md) · AR-4, AR-7, AR-13, AR-14, AR-25
**Objective**: Document the implemented behavior and release metadata.

- [ ] 4.1.1 Update the API reference with project and secret routes, shapes, and status codes — `docs/reference/api.md`
- [ ] 4.1.2 Add the secrets guide with encoding, versions, idempotency, retention, purge, and rename consequences — `docs/guide/secrets.md`
- [ ] 4.1.3 Document `OPENVAULT_PURGE_DB_URL`, retention, value limit, and version limit — `docs/reference/configuration.md`
- [ ] 4.1.4 Update the architecture crypto page with AAD v2 and the object-type/project binding — `docs/architecture/crypto.md`
- [ ] 4.1.5 Add the secrets guide to the VitePress sidebar — `docs/.vitepress/config.ts`
- [ ] 4.1.6 Update the security limitations with the purge credential, project-delete purge block, and v2 empty-table precondition — `docs/security/limitations.md`
- [ ] 4.1.7 Update the changelog and add a minor changeset — `docs/changelog.md`, `.changeset/secrets.md`
- [ ] 4.1.8 Document and run the envelope-v2 release precondition: both version tables must be empty before first boot — `docs/guide/secrets.md`

### Step 4.2: Release Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Verification Checklist
**Objective**: Prove the complete plan with every required gate.

- [ ] 4.2.1 Run `pnpm verify`
- [ ] 4.2.2 Run `pnpm db:types:check`
- [ ] 4.2.3 Run the full integration suite on PostgreSQL 16 and 17
- [ ] 4.2.4 Run `pnpm changeset status` and the docs build
- [ ] 4.2.5 Remove temporary artifacts, confirm the clean worktree, and record the final summary

**Deliverables**:
- [ ] Project and secret routes complete with `project.*` and `secret.*` enforcement
- [ ] Documentation and changeset complete
- [ ] All verification passing

**Verify**: `pnpm verify && pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration && pnpm changeset status`

---

## Dependencies

```
Phase 1 (contracts, crypto, projects)
    ↓
Phase 2 (secret core, idempotency, capabilities, consumers, routes)
    ↓
Phase 3 (lifecycle, expiry, purge, body/config limits)
    ↓
Phase 4 (documentation, release)
```

---

## Success Criteria

**Feature is complete when:**

1. ✅ All 65 tasks completed
2. ✅ All RD-08 acceptance criteria covered by tests
3. ✅ `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, and the docs build pass
4. ✅ Integration suite passes on PostgreSQL 16 and 17
5. ✅ No secret value in metadata, lists, audit, logs, or errors
6. ✅ Project deletion hides secrets, certificates, identities, assignments, and access explanations
7. ✅ Purge only succeeds after retention with protection disabled and a verified purger session
8. ✅ Documentation and changeset complete
9. ✅ Temporary artifacts removed and the worktree clean

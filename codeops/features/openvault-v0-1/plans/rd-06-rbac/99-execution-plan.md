# Execution Plan: RD-06 RBAC

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-03 22:25
> **Progress**: 57/57 tasks (100%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement RD-06 in four phases: contracts/catalog/schema/audit, the policy evaluator and identity
bridge, the assignment/access admin surface, and documentation plus the PostgreSQL 16/17 release
matrix. Each feature phase follows the mandatory specification-first order: specification tests,
red result, implementation, green result, implementation tests, full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Contracts, catalog, schema, and audit | 16 |
| 2 | Policy evaluator, capabilities, and identity bridge | 16 |
| 3 | Assignment API, access explain, and rate limits | 15 |
| 4 | Documentation, changeset, and release matrix | 10 |

**Total: 57 tasks across 4 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes in the phase sections below are the **single source of truth** for
> progress. Every task line appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp —
>    `- [~] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` —
>    `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** (`> **Progress**: X/Y tasks (Z%)`) and the Last Updated
>    stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning the phase sections top-to-bottom: the first `[~]` task is resumed
>    first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line.
>    The plan lifecycle is `Ready`, `Executing`, `Done`, or `Blocked`, derived from these markers.
>
> Timestamps come from `date '+%Y-%m-%d %H:%M'` — never invented.

---

## Phase 1: Contracts, catalog, schema, and audit

> **Phase baseline tree**: 4f2da44236d65cf9daf82beab6ded162622c5e62
> **Modification set**: `packages/api-contract/src/rbac.ts`, `packages/api-contract/src/index.ts`, `apps/server/src/rbac/actions.ts`, `apps/server/src/rbac/roles.ts`, `apps/server/src/rbac/reasons.ts`, `apps/server/src/rbac/errors.ts`, `apps/server/src/rbac/audit.ts`, `apps/server/src/database/schema.ts`, generated migration/snapshot/types/ctypes, the reviewed seed migration, and Phase 1 tests
> **Scope mode**: strict
> **Lenses**: api-surface, migration, security
> **Reasoning**: max — the catalog, contracts, and version row are foundational and hard to
> change after later phases depend on them

### Step 1.1: Specification Tests

**Reference**: [03-01](03-01-catalog-schema-audit.md) §Contracts, §Action catalog, §Role matrix, §Policy state, §Audit port · [07](07-testing-strategy.md) ST-1–ST-3, ST-5–ST-13, ST-15 · AR-2, AR-6, AR-19, AR-21, AR-24, AR-27
**Objective**: Freeze the public vocabulary, matrix, version row, and audit event shape before
implementation.

- [x] 1.1.1 [spec-author] Write contract tests for ST-5–ST-10 — `packages/api-contract/tests/rbac.spec.test.ts` ✅ (completed: 2026-11-03 20:25)
- [x] 1.1.2 [spec-author] Write catalog tests for ST-1–ST-3 — `apps/server/tests/integration/rbac-catalog.spec.test.ts` ✅ (completed: 2026-11-03 20:25)
- [x] 1.1.3 [spec-author] Write schema, seed, and version tests for ST-11–ST-13 and ST-15 — `apps/server/tests/integration/rbac-schema.spec.test.ts` ✅ (completed: 2026-11-03 20:25)
- [x] 1.1.4 Run the Phase 1 specification tests and record the red result ✅ (completed: 2026-11-03 20:25)

### Step 1.2: Implementation

**Reference**: [03-01](03-01-catalog-schema-audit.md) §Contracts, §Action catalog, §Role matrix, §Policy state, §Reason codes, §Audit port · AR-2, AR-19, AR-21, AR-24

- [x] 1.2.1 Add the RBAC contracts and export them — `packages/api-contract/src/rbac.ts`, `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.2 Add the 25-action catalog and descriptions — `apps/server/src/rbac/actions.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.3 Add the nine-role matrix and scope eligibility — `apps/server/src/rbac/roles.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.4 Add the reason-code union and error families — `apps/server/src/rbac/reasons.ts`, `apps/server/src/rbac/errors.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.5 Add the audit port and logger adapter — `apps/server/src/rbac/audit.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.6 Add `policy_state` to the schema — `apps/server/src/database/schema.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.7 Generate and review the migration, snapshot, row types, and CType constants — `apps/server/migrations/`, `apps/server/src/database/generated-types.ts`, `apps/server/src/database/ctypes.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.2.8 Add the reviewed `policy_state` seed migration — `apps/server/migrations/` ✅ (completed: 2026-11-03 20:27)

### Step 1.3: Implementation Tests and Hardening

**Reference**: [03-01](03-01-catalog-schema-audit.md) §Error Handling · [07](07-testing-strategy.md) ST-1–ST-15 · AR-2, AR-19, AR-21

- [x] 1.3.1 Write contract implementation tests for cross-field and strictness edges — `packages/api-contract/tests/rbac.impl.test.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.3.2 Write audit implementation tests for field sets, redaction, and failure propagation — `apps/server/tests/integration/rbac-audit.impl.test.ts` ✅ (completed: 2026-11-03 20:27)
- [x] 1.3.3 Re-run the Phase 1 specification tests and confirm green ✅ (completed: 2026-11-03 20:27)
- [x] 1.3.4 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` ✅ (completed: 2026-11-03 20:34)

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Checklist

---

## Phase 2: Policy evaluator, capabilities, and identity bridge

> **Phase baseline tree**: 88426fba9f3ccaa71915ad22b0d8d0a4eaf3134a
> **Modification set**: `apps/server/src/rbac/policy-repository.ts`, `apps/server/src/rbac/policy-service.ts`, `apps/server/src/rbac/runtime.ts`, `apps/server/src/identity/identity-authorizer.ts`, `apps/server/src/identity/identity-runtime.ts`, `apps/server/src/identity/identity-service.ts`, `apps/server/src/controllers/identity.ts`, `apps/server/src/controllers/meta.ts`, `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/app.ts`, and Phase 2 tests
> **Scope mode**: strict
> **Lenses**: security, api-surface, concurrency
> **Reasoning**: max — authorization semantics and the identity bridge must preserve every
> existing behavior while adding deny-by-default list handling

### Step 2.1: Specification Tests

**Reference**: [03-02](03-02-policy-evaluator.md) §Decision algorithm, §List authorization, §Grant authorization, §Capabilities, §Identity bridge · [07](07-testing-strategy.md) ST-4, ST-16–ST-30, ST-53–ST-55 · AR-3, AR-9, AR-10, AR-12, AR-19, AR-22

- [x] 2.1.1 [spec-author] Write catalog-route, evaluator, capability, and audit tests for ST-4 and ST-16–ST-30 — `apps/server/tests/integration/rbac-policy.spec.test.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.1.2 [spec-author] Write identity bridge and list-denial tests for ST-53–ST-55 — `apps/server/tests/integration/rbac-identity.spec.test.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.1.3 Run the Phase 2 specification tests and record the red result ✅ (completed: 2026-11-03 21:05)

### Step 2.2: Implementation

**Reference**: [03-02](03-02-policy-evaluator.md) §Decision algorithm, §List authorization, §Grant authorization, §Capabilities, §Identity bridge, §Runtime composition · AR-3, AR-12, AR-22

- [x] 2.2.1 Add the actor snapshot, version, and resource repository — `apps/server/src/rbac/policy-repository.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.2 Implement `authorize`, scope matching, reason selection, and `recordDecision` — `apps/server/src/rbac/policy-service.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.3 Implement `authorizeList`, `authorizeGrant`, `effectiveActions`, and `capabilitiesFor` — `apps/server/src/rbac/policy-service.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.4 Replace the identity helper internals and add `readScope` — `apps/server/src/identity/identity-authorizer.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.5 Deny an identity list with no visible scope — `apps/server/src/identity/identity-service.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.6 Add the policy runtime and pass it through the identity runtime — `apps/server/src/rbac/runtime.ts`, `apps/server/src/identity/identity-runtime.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.7 Wire the policy runtime through the agent runtime and application services — `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.8 Add the public role catalog route — `apps/server/src/controllers/meta.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.2.9 Map policy-unavailable failures in the identity controller — `apps/server/src/controllers/identity.ts` ✅ (completed: 2026-11-03 21:05)

### Step 2.3: Implementation Tests and Hardening

**Reference**: [03-02](03-02-policy-evaluator.md) §Error Handling · [07](07-testing-strategy.md) ST-16–ST-30, ST-53–ST-55 · AR-9, AR-19, AR-22

- [x] 2.3.1 Write evaluator implementation tests for scope, reason, and version edges — `apps/server/tests/integration/rbac-policy.impl.test.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.3.2 Write runtime and audit composition tests — `apps/server/tests/integration/rbac-policy.impl.test.ts` ✅ (completed: 2026-11-03 21:05)
- [x] 2.3.3 Re-run the Phase 2 specification and existing identity suites and confirm green ✅ (completed: 2026-11-03 21:05)
- [x] 2.3.4 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` ✅ (completed: 2026-11-03 21:08)

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Checklist

---

## Phase 3: Assignment API, access explain, and rate limits

> **Phase baseline tree**: 6be6dc1ba8063da7634331279ff17a860dbafa74
> **Modification set**: `apps/server/src/rbac/assignment-service.ts`, `apps/server/src/rbac/rate-limits.ts`, `apps/server/src/controllers/assignments.ts`, `packages/api-contract/src/rbac.ts`, `apps/server/src/app.ts`, and Phase 3 tests
> **Scope mode**: strict
> **Lenses**: security, concurrency, api-surface
> **Reasoning**: max — grant guard ordering, last-admin serialization, and hidden-resource
> behavior are security-critical and concurrent

### Step 3.1: Specification Tests

**Reference**: [03-03](03-03-assignments-access.md) §Create, §Delete and last-admin guard, §List, §Access explain, §Routes and rate limits · [07](07-testing-strategy.md) ST-14, ST-31–ST-52 · AR-5, AR-6, AR-8, AR-13, AR-15, AR-16, AR-18

- [x] 3.1.1 [spec-author] Write assignment, version, guard, last-admin, list, and rate-limit tests for ST-14 and ST-31–ST-45 — `apps/server/tests/integration/rbac-assignments.spec.test.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.1.2 [spec-author] Write access-explain and catalog-route tests for ST-46–ST-52 — `apps/server/tests/integration/rbac-explain.spec.test.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.1.3 Run the Phase 3 specification tests and record the red result ✅ (completed: 2026-11-03 21:38)

### Step 3.2: Implementation

**Reference**: [03-03](03-03-assignments-access.md) §Create, §Delete and last-admin guard, §List, §Access explain, §Routes and rate limits, §HTTP mapping · AR-5, AR-6, AR-8, AR-13, AR-15, AR-16, AR-18

- [x] 3.2.1 Implement target resolution and assignment creation — `apps/server/src/rbac/assignment-service.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.2 Implement deletion, decision audit, and the last-admin guard — `apps/server/src/rbac/assignment-service.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.3 Implement scoped assignment listing and filters — `apps/server/src/rbac/assignment-service.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.4 Implement access explain and consumer projection — `apps/server/src/rbac/assignment-service.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.5 Add the admin write/read rate-limit service — `apps/server/src/rbac/rate-limits.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.6 Add the assignment and access-explain controllers — `apps/server/src/controllers/assignments.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.7 Register the services, controllers, and limiters — `apps/server/src/app.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.2.8 Add the assignment list contract and finish error mapping — `packages/api-contract/src/rbac.ts`, `apps/server/src/controllers/assignments.ts` ✅ (completed: 2026-11-03 21:38)

### Step 3.3: Implementation Tests and Hardening

**Reference**: [03-03](03-03-assignments-access.md) §Error Handling · [07](07-testing-strategy.md) ST-31–ST-52 · AR-9, AR-16, AR-18

- [x] 3.3.1 Write assignment implementation tests for rollback, duplicate, and orphan cleanup — `apps/server/tests/integration/rbac-assignments.impl.test.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.3.2 Write a forced concurrent last-admin delete test — `apps/server/tests/integration/rbac-assignments.impl.test.ts` ✅ (completed: 2026-11-03 21:38)
- [x] 3.3.3 Re-run the Phase 3 specification tests and confirm green ✅ (completed: 2026-11-03 21:38)
- [x] 3.3.4 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` ✅ (completed: 2026-11-03 21:42)

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Checklist

---

## Phase 4: Documentation, changeset, and release matrix

> **Phase baseline tree**: f3f44dbef7f5db68321d6a365abe37c0f7a5edf3
> **Modification set**: `docs/reference/api.md`, `docs/guide/rbac.md`, `docs/changelog.md`, `.changeset/`, `codeops/features/openvault-v0-1/00-roadmap.md`, `codeops/00-roadmap.md`, `codeops/features/openvault-v0-1/plans/rd-06-rbac/99-execution-plan.md`, and Phase 4 tests
> **Scope mode**: strict
> **Lenses**: docs, release
> **Reasoning**: high — release evidence and documentation accuracy, with no new runtime design

### Step 4.1: Release Specification Tests

**Reference**: [07](07-testing-strategy.md) ST-57–ST-60 · AR-24, AR-25, AR-27

- [x] 4.1.1 [spec-author] Write release-document tests for ST-57–ST-58 — `apps/server/tests/integration/rbac-release.spec.test.ts` ✅ (completed: 2026-11-03 22:25)
- [x] 4.1.2 Run the release-document tests and record the red result ✅ (completed: 2026-11-03 22:25)

### Step 4.2: Documentation and Changeset

**Reference**: [03-03](03-03-assignments-access.md) §Routes and rate limits, §Code Examples · [03-01](03-01-catalog-schema-audit.md) §Contracts · AR-24, AR-25, AR-27

- [x] 4.2.1 Add assignment, explain, and meta request/response examples — `docs/reference/api.md` ✅ (completed: 2026-11-03 22:25)
- [x] 4.2.2 Add assignment and explain usage to the RBAC guide — `docs/guide/rbac.md` ✅ (completed: 2026-11-03 22:25)
- [x] 4.2.3 Add the changelog entry and the package changeset — `docs/changelog.md`, `.changeset/` ✅ (completed: 2026-11-03 22:25)

### Step 4.3: Release Verification

**Reference**: [07](07-testing-strategy.md) §Verification Checklist · AR-25, AR-27

- [x] 4.3.1 Confirm the release-document tests and the documentation build pass ✅ (completed: 2026-11-03 22:25)
- [x] 4.3.2 Run the PostgreSQL 16 migration, integration, and generated-type matrix ✅ (completed: 2026-11-03 22:25)
- [x] 4.3.3 Run the PostgreSQL 17 migration, integration, and generated-type matrix ✅ (completed: 2026-11-03 22:25)
- [x] 4.3.4 Run the full `pnpm verify` gate under Node 24.21.0 ✅ (completed: 2026-11-03 22:25)
- [x] 4.3.5 Update the roadmap and record completion ✅ (completed: 2026-11-03 22:25)

**Verify**: `pnpm verify`, PostgreSQL 16 and 17 integration suites, `pnpm db:types:check` on both

---

## Dependencies

```
Phase 1 (contracts, catalog, schema, audit)
    ↓
Phase 2 (evaluator, capabilities, identity bridge)
    ↓
Phase 3 (assignments, explain, rate limits)
    ↓
Phase 4 (docs, changeset, release matrix)
```

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed
2. ✅ All verification passing (`pnpm verify`)
3. ✅ PostgreSQL 16 and 17 matrices pass
4. ✅ No warnings or errors
5. ✅ No dead code — no unused parameters, functions, classes, or modules
6. ✅ Security hardened — deny by default, grant guards, last-admin invariant, hidden resources,
   rate limits, no secret leakage
7. ✅ Documentation updated and changeset present
8. ✅ Post-completion project re-analysis (handled by the exec-plan skill)

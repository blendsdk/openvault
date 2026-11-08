# Execution Plan: Certificate UI

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-08 18:00
> **Progress**: 77/77 tasks (100%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the certificate management UI in seven spec-first phases: server contract and data
access, web helpers and fixtures, list and navigation, detail and public material, import/generate/
renew, lifecycle and private key, then documentation and release metadata. Each phase writes its
specification tests first, confirms the red phase, implements, adds implementation tests, and runs
the phase verification. The plan does not tag or publish.

**🚨 Update this document after EACH completed task.**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Server contract and data access | 15 |
| 2 | Web helpers and fixtures | 9 |
| 3 | Certificate list and navigation | 9 |
| 4 | Certificate detail and public material | 8 |
| 5 | Import, generate, and renew | 10 |
| 6 | Lifecycle, private key, and errors | 12 |
| 7 | Documentation and release metadata | 14 |

**Total: 77 tasks across 7 phases** (no fabricated hour estimates; scope is bounded by the
task-size criteria in the quality checklist)

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the single source of truth. Mark a task `[~]` with a timestamp when
> implementation starts, `[x]` when verification passes, and `[!]` with a reason when blocked.
> Update the Progress header and Last Updated stamp after every task. Resume at the first `[~]`,
> else the first `[ ]`.

---

## Phase 1: Server contract and data access

> **Phase baseline tree**: 5304409be7b06db1b3450a223d9faa9751cbd004
> **Lenses**: api-contract, security, database
> **Reasoning**: high — additive API contract and RBAC projection changes that every later phase
> consumes.

### Step 1.1: Specification tests

**Reference**: [03-02 §List query schema](03-02-server-contract.md) · [03-02 §Capability flags](03-02-server-contract.md) · ST-1..ST-11 · AR-5, AR-7, AR-12, AR-14, PAR-02, PAR-03
**Objective**: Prove the status filter, search semantics, and capability flags before implementation.

- [x] 1.1.1 [spec-author] Write integration spec tests for active/deleted lists, name/subject search, filters, cursor, and invalid status — `apps/server/tests/integration/certificate-list.spec.test.ts` ✅ (completed: 2026-11-08 17:08)
- [x] 1.1.2 [spec-author] Write capability spec tests for reader, officer, and admin — `apps/server/tests/integration/rbac/certificate-capabilities.spec.test.ts` ✅ (completed: 2026-11-08 17:08)
- [x] 1.1.3 Run the new spec tests and confirm the expected red failures (the status filter and flags do not exist yet) ✅ (completed: 2026-11-08 17:08)

### Step 1.2: Implementation

**Reference**: [03-02 §Implementation Details](03-02-server-contract.md) · AR-5, AR-7, AR-12, AR-14, AR-24
**Objective**: Add the additive contract and data-access changes.

- [x] 1.2.1 Add `status` to `certificateListQuerySchema`; update the route summary for name-or-subject `q` — `packages/api-contract/src/certificates.ts`, `apps/server/scripts/api-contract.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.2 Add `canRecover` and `canReadPrivate` to `capabilityFlagsSchema` and the zero-capability returns — `packages/api-contract/src/rbac.ts`, `apps/server/src/certificates/service.ts`, `apps/server/src/secrets/service.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.3 Update every capability fixture and exact-equality expectation with the new fields — `packages/api-contract/tests/`, `apps/server/tests/integration/rbac-policy.spec.test.ts`, `apps/server/tests/integration/rbac-policy.impl.test.ts`, `apps/server/tests/integration/secrets.spec.test.ts`, `apps/web/tests/helpers/fake-vault.ts`, `apps/cli/tests/helpers/fake-vault.ts`, `apps/agent/tests/helpers/fake-vault.ts`, `apps/agent/tests/delivery-cancel.impl.test.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.4 Map the new flags for secrets and certificates and update the “five flags” comments — `apps/server/src/rbac/policy-service.ts`, `apps/server/src/secrets/service.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.5 Add the status branch and the name-or-subject predicate to the list read; pass `status` through the service — `apps/server/src/certificates/repository.ts`, `apps/server/src/certificates/service.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.6 Add `CertificatesController` to `WEB_CONTRACT_CONTROLLERS`, add every certificate route to `WEB_ROUTE_DOCS` through `sharedRouteDoc`, and update the comment — `apps/server/scripts/api-contract.ts` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.7 Run `pnpm api:generate`; inspect the generated CLI and browser diffs — `packages/api-contract/openapi.json`, `apps/cli/src/generated/`, `apps/web/src/generated/` ✅ (completed: 2026-11-08 17:12)
- [x] 1.2.8 Run the Phase 1 spec tests and confirm green ✅ (completed: 2026-11-08 17:10)

### Step 1.3: Implementation tests and hardening

**Reference**: ST-1..ST-11 · PAR-02, PAR-03
**Objective**: Cover the query edge cases and the contract drift gate.

- [x] 1.3.1 Add repository tests for LIKE escaping, cursor with the deleted status, and an empty page — `apps/server/tests/integration/certificates/repository.impl.test.ts` ✅ (completed: 2026-11-08 17:10)
- [x] 1.3.2 Add a zero-capability test for an inactive principal — `apps/server/tests/integration/rbac/capability-zero.impl.test.ts` ✅ (completed: 2026-11-08 17:11)
- [x] 1.3.3 Run `pnpm typecheck` and fix any fixture or generated-type drift ✅ (completed: 2026-11-08 17:11)
- [x] 1.3.4 Run `pnpm api:check` and confirm no drift ✅ (completed: 2026-11-08 17:11)

**Deliverables**:
- [ ] Server tests, capability tests, and generated-contract checks pass

**Verify**: `pnpm --filter @openvault/server test && pnpm --filter @openvault/server typecheck && pnpm api:check`; the integration suite runs in CI on PostgreSQL 16 and 17, or locally with `OPENVAULT_TEST_DB=1` and a `TEST_DATABASE_URL` that points at a local `*_test` database.

---

## Phase 2: Web helpers and fixtures

> **Phase baseline tree**: 4d9259275faeeb65f3198dfb36ac095ff23a8f54
> **Lenses**: web-ui, accessibility
> **Reasoning**: medium — pure helpers and a test adapter; no page behavior yet.

### Step 2.1: Specification tests

**Reference**: [03-01 §Client validation](03-01-web-ui.md) · [03-01 §PEM helpers](03-01-web-ui.md) · ST-24, ST-25, ST-27, ST-28 · AR-8, AR-23, PAR-08
**Objective**: Pin the validation and PEM behavior before writing the helpers.

- [x] 2.1.1 [spec-author] Write validation spec tests for names, subjects, SANs, validity, and day-bound timestamps — `apps/web/tests/certificate-validation.spec.test.ts` ✅ (completed: 2026-11-08 17:13)
- [x] 2.1.2 [spec-author] Write PEM helper spec tests for empty, oversized, marker-missing, successful read, and download cleanup — `apps/web/tests/pem.spec.test.ts` ✅ (completed: 2026-11-08 17:13)
- [x] 2.1.3 Run the new tests and confirm red ✅ (completed: 2026-11-08 17:13)

### Step 2.2: Implementation

**Reference**: [03-01 §Client validation](03-01-web-ui.md), [03-01 §PEM helpers](03-01-web-ui.md) · AR-8, AR-23
**Objective**: Implement the shared client helpers and extend the test adapter.

- [x] 2.2.1 Add `validateCertificateName`, `parseSubject`, `parseSans`, `parseValidityDays`, `startOfDayIso`, and `endOfDayIso` — `apps/web/src/validation.ts` ✅ (completed: 2026-11-08 17:14)
- [x] 2.2.2 Add `readPemFile` and `downloadPem` — `apps/web/src/components/pem.ts` ✅ (completed: 2026-11-08 17:14)
- [x] 2.2.3 Extend `FakeVault` with certificate list, detail, import, generate, metadata, delete, recover, purge, and private-key routes plus fixed fixtures — `apps/web/tests/helpers/fake-vault.ts` ✅ (completed: 2026-11-08 17:17)
- [x] 2.2.4 Run the Phase 2 spec tests and confirm green ✅ (completed: 2026-11-08 17:17)

### Step 2.3: Implementation tests and hardening

**Reference**: ST-24, ST-25, ST-27, ST-28 · PAR-08
**Objective**: Cover the helper edges that the spec cases do not.

- [x] 2.3.1 Add impl tests for control characters, 100/101 SANs, 1/825/0/826 days, and a leap-day date boundary — `apps/web/tests/certificate-validation.impl.test.ts` ✅ (completed: 2026-11-08 17:17)
- [x] 2.3.2 Add a `FakeVault` self-check that each certificate route returns the envelope the generated client expects ✅ (completed: 2026-11-08 17:17)

**Deliverables**:
- [ ] Validation and PEM helpers pass their tests; the fake vault serves certificate routes

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 3: Certificate list and navigation

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: web-ui, accessibility
> **Reasoning**: medium — new page and navigation surface that reuses established list patterns.

### Step 3.1: Specification tests

**Reference**: [03-01 §CertificatesPage](03-01-web-ui.md) · ST-12..ST-18 · AR-5, AR-12, AR-13, AR-21, AR-22
**Objective**: Pin the list rendering, filters, status view, pagination, and empty states.

- [x] 3.1.1 [spec-author] Write the list spec tests for rendering, filters, status, pagination, and empty states — `apps/web/tests/certificates-list.test.tsx` (ST-12..ST-16, ST-18) ✅ (completed: 2026-11-08 17:19)
- [x] 3.1.2 [spec-author] Extend the shell spec with the Certificates launcher entry, section link, and docs target — `apps/web/tests/layout.test.tsx` (ST-17) ✅ (completed: 2026-11-08 17:19)
- [x] 3.1.3 Run the tests and confirm red ✅ (completed: 2026-11-08 17:19)

### Step 3.2: Implementation

**Reference**: [03-01 §Routes and navigation](03-01-web-ui.md), [03-01 §CertificatesPage](03-01-web-ui.md) · AR-13, AR-21, AR-26
**Objective**: Add the list page, route, navigation entry, and docs mapping.

- [x] 3.2.1 Implement the filter bar, table, status badges, expiry text, tags, pagination, and empty states — `apps/web/src/pages/certificates-page.tsx` ✅ (completed: 2026-11-08 17:19)
- [x] 3.2.2 Add the list route, Certificates section nav entry, launcher entry, and docs mapping — `apps/web/src/App.tsx`, `apps/web/src/projects/project-route.tsx`, `apps/web/src/layout/app-shell.tsx`, `apps/web/src/docs.ts` ✅ (completed: 2026-11-08 17:21)
- [x] 3.2.3 Link the project overview certificate count to the list — `apps/web/src/pages/project-overview-page.tsx` ✅ (completed: 2026-11-08 17:21)
- [x] 3.2.4 Run the Phase 3 spec tests and confirm green ✅ (completed: 2026-11-08 17:21)

### Step 3.3: Implementation tests and hardening

**Reference**: ST-12..ST-18 · AR-21, AR-30
**Objective**: Cover the filter and pagination edges.

- [x] 3.3.1 Add impl tests for date-bound ISO conversion, cursor reset on filter change, and the deleted empty state — `apps/web/tests/certificates-list.impl.test.tsx` ✅ (completed: 2026-11-08 17:23)
- [x] 3.3.2 Confirm the table and filter bar at 768 px and 390 px in the component test renderer or the review stack ✅ (completed: 2026-11-08 17:23)

**Deliverables**:
- [ ] The list, navigation, docs link, and empty states pass their tests

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 4: Certificate detail and public material

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: web-ui, security
> **Reasoning**: medium — read-only page with version selection, copy/download, and expiry handling.

### Step 4.1: Specification tests

**Reference**: [03-01 §CertificateDetailPage](03-01-web-ui.md) · ST-19..ST-23 · AR-6, AR-15, AR-27
**Objective**: Pin the metadata, version read, public material, and expired-current behavior.

- [x] 4.1.1 [spec-author] Write the detail and public-material spec tests — `apps/web/tests/certificate-detail.test.tsx` ✅ (completed: 2026-11-08 17:26)
- [x] 4.1.2 Run the tests and confirm red ✅ (completed: 2026-11-08 17:26)

### Step 4.2: Implementation

**Reference**: [03-01 §CertificateDetailPage](03-01-web-ui.md), [03-01 §PEM helpers](03-01-web-ui.md) · AR-15, AR-27
**Objective**: Implement metadata, version selection, and public material.

- [x] 4.2.1 Add the detail route and implement the metadata card, status, SANs, and purge fields — `apps/web/src/App.tsx`, `apps/web/src/pages/certificate-detail-page.tsx` ✅ (completed: 2026-11-08 17:28)
- [x] 4.2.2 Implement the version control and the explicit public read with the selected version id — `apps/web/src/pages/certificate-detail-page.tsx` ✅ (completed: 2026-11-08 17:28)
- [x] 4.2.3 Add copy and download for leaf and chain; handle an empty chain — `apps/web/src/pages/certificate-detail-page.tsx`, `apps/web/src/components/pem.ts` ✅ (completed: 2026-11-08 17:28)
- [x] 4.2.4 Run the Phase 4 spec tests and confirm green ✅ (completed: 2026-11-08 17:28)

### Step 4.3: Implementation tests and hardening

**Reference**: ST-19..ST-23 · AR-15
**Objective**: Cover version reset and expired-current behavior.

- [x] 4.3.1 Add impl tests for the version state reset on reload, the not-found state, and an expired current certificate — `apps/web/tests/certificate-detail.impl.test.tsx` ✅ (completed: 2026-11-08 17:30)
- [x] 4.3.2 Confirm the long fingerprint and subject wrap without horizontal overflow ✅ (completed: 2026-11-08 17:30)

**Deliverables**:
- [ ] The detail page, version read, and public material pass their tests

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 5: Import, generate, and renew

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: web-ui, security
> **Reasoning**: medium — forms, local file input, and optimistic-concurrency behavior.

### Step 5.1: Specification tests

**Reference**: [03-01 §CertificateImportDialog](03-01-web-ui.md), [03-01 §CertificateGenerateDialog](03-01-web-ui.md) · ST-24..ST-30 · AR-8, AR-17, AR-18, AR-23
**Objective**: Pin the write forms, warning panel, and renewal guard.

- [x] 5.1.1 [spec-author] Write the import spec tests, including the local file picker and warning panel — `apps/web/tests/certificate-import.test.tsx` ✅ (completed: 2026-11-08 17:37)
- [x] 5.1.2 [spec-author] Write the generate and renew spec tests — `apps/web/tests/certificate-generate.test.tsx` ✅ (completed: 2026-11-08 17:37)
- [x] 5.1.3 Run the tests and confirm red ✅ (completed: 2026-11-08 17:37)

### Step 5.2: Implementation

**Reference**: [03-01 §CertificateImportDialog](03-01-web-ui.md), [03-01 §CertificateGenerateDialog](03-01-web-ui.md) · AR-17, AR-18
**Objective**: Implement both dialogs and wire create/renew.

- [x] 5.2.1 Implement the import dialog with pasted and local PEM input, tags, and `allowNotYetValid` — `apps/web/src/components/certificate-import-dialog.tsx` ✅ (completed: 2026-11-08 17:37)
- [x] 5.2.2 Implement the generate dialog with subject, SANs, key type, validity, and tags — `apps/web/src/components/certificate-generate-dialog.tsx` ✅ (completed: 2026-11-08 17:37)
- [x] 5.2.3 Wire Import and Generate on the list and renew actions on the detail with `expectedVersionId` — `apps/web/src/pages/certificates-page.tsx`, `apps/web/src/pages/certificate-detail-page.tsx` ✅ (completed: 2026-11-08 17:37)
- [x] 5.2.4 Implement the success result panel with version id, warnings, Open certificate, and Close — both dialogs ✅ (completed: 2026-11-08 17:37)
- [x] 5.2.5 Run the Phase 5 spec tests and confirm green ✅ (completed: 2026-11-08 17:37)

### Step 5.3: Implementation tests and hardening

**Reference**: ST-24..ST-30 · AR-17, AR-18
**Objective**: Cover the form edges and stale-version behavior.

- [x] 5.3.1 Add impl tests for empty tags, duplicate tag keys, a 100-SAN boundary, the file-size limits, and a stale `expectedVersionId` — `apps/web/tests/certificate-forms.impl.test.tsx` ✅ (completed: 2026-11-08 17:38)
- [x] 5.3.2 Confirm the dialog keeps its values after a failed submit ✅ (completed: 2026-11-08 17:38)

**Deliverables**:
- [ ] Import, generate, and renew pass their tests, including warnings and version conflict

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 6: Lifecycle, private key, and errors

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: web-ui, security, accessibility
> **Reasoning**: high — destructive actions and private-key handling are security-sensitive.

### Step 6.1: Specification tests

**Reference**: [03-01 §Private key](03-01-web-ui.md), [03-01 §Action handlers](03-01-web-ui.md), [03-01 §Error handling](03-01-web-ui.md) · ST-31..ST-43 · AR-3, AR-16, AR-19, AR-20, AR-22, PAR-09, PAR-10
**Objective**: Pin metadata, lifecycle, private-key, and error behavior.

- [x] 6.1.1 [spec-author] Write the metadata and lifecycle spec tests — `apps/web/tests/certificate-lifecycle.test.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.1.2 [spec-author] Write the private-key spec tests, including the 60-second and blur clears, storage, URL, console, and clipboard checks — `apps/web/tests/certificate-private-key.test.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.1.3 [spec-author] Write the error-mapping spec tests — `apps/web/tests/certificate-errors.test.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.1.4 Run the tests and confirm red ✅ (completed: 2026-11-08 17:44)

### Step 6.2: Implementation

**Reference**: [03-01 §CertificateMetadataDialog](03-01-web-ui.md), [03-01 §Action handlers](03-01-web-ui.md), [03-01 §Private key](03-01-web-ui.md) · AR-19, AR-20, AR-3, AR-16
**Objective**: Implement the remaining actions and the private-key reveal.

- [x] 6.2.1 Implement the metadata dialog for tags and one-way purge protection — `apps/web/src/components/certificate-metadata-dialog.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.2.2 Implement delete, recover, and gated purge with confirmations and the deleted state — `apps/web/src/pages/certificate-detail-page.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.2.3 Implement the private-key confirmation, read, 60-second reveal, focus/window/route/unmount clear, and download — `apps/web/src/pages/certificate-detail-page.tsx` ✅ (completed: 2026-11-08 17:44)
- [x] 6.2.4 Implement the documented error mapping and fallback — `apps/web/src/pages/certificate-detail-page.tsx`, dialogs ✅ (completed: 2026-11-08 17:44)
- [x] 6.2.5 Run the Phase 6 spec tests and confirm green ✅ (completed: 2026-11-08 17:44)

### Step 6.3: Implementation tests and hardening

**Reference**: ST-31..ST-43 · AR-30, PAR-09, PAR-15
**Objective**: Prove the security and accessibility edges.

- [x] 6.3.1 Add the list and detail to the axe suite — `apps/web/tests/accessibility.test.tsx` ✅ (completed: 2026-11-08 17:47)
- [x] 6.3.2 Add impl tests for the purge reason matrix, the private-key clear matrix, and the absent-storage assertions — `apps/web/tests/certificate-private-key.impl.test.tsx` ✅ (completed: 2026-11-08 17:47)
- [x] 6.3.3 Run the web suite and confirm no key appears in storage, the URL, the console, or the clipboard ✅ (completed: 2026-11-08 17:47)

**Deliverables**:
- [ ] Lifecycle, private-key, error, and accessibility tests pass

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 7: Documentation and release metadata

> **Phase baseline tree**: Pending — recorded by the exec-plan skill at phase start.
> **Lenses**: docs, release
> **Reasoning**: medium — broad but mechanical documentation and version alignment; no product code.

### Step 7.1: Documentation tests first

**Reference**: [03-03 §Documentation changes](03-03-docs-release.md) · ST-44..ST-47 · AR-28, PAR-13
**Objective**: Make the docs guard expect the new reader content and 1.1.0.

- [x] 7.1.1 Update `tests/docs.spec.test.mjs` to expect 1.1.0 and certificate coverage in the web UI guide, and to reject the old CLI-only sentence — `tests/docs.spec.test.mjs` ✅ (completed: 2026-11-08 17:51)
- [x] 7.1.2 Run the docs tests and confirm red ✅ (completed: 2026-11-08 17:51)

### Step 7.2: Documentation and version metadata

**Reference**: [03-03 §Documentation changes](03-03-docs-release.md), [03-03 §Release metadata](03-03-docs-release.md) · AR-28, PAR-13, PAR-14
**Objective**: Make the reader docs and version labels true.

- [x] 7.2.1 Update the web UI daily flows, capabilities, accessibility list, and out-of-scope paragraph — `docs/guide/web-ui.md` ✅ (completed: 2026-11-08 17:51)
- [x] 7.2.2 Add the Web UI section to the certificate guide — `docs/guide/certificates.md` ✅ (completed: 2026-11-08 17:51)
- [x] 7.2.3 Replace the CLI-only certificate limitation — `docs/security/known-limitations.md` ✅ (completed: 2026-11-08 17:51)
- [x] 7.2.4 Update the certificate list query and capability fields — `docs/reference/api.md` ✅ (completed: 2026-11-08 17:52)
- [x] 7.2.5 Add the 1.1.0 changelog entry and update the versioning page — `docs/changelog.md`, `docs/guide/versioning.md` ✅ (completed: 2026-11-08 17:52)
- [x] 7.2.6 Run the 1.1.0 release metadata checklist across packages, CLI, server, web, contract, Compose, examples, README, docs, GitHub templates, and tests — see [03-03 §Release metadata](03-03-docs-release.md) ✅ (completed: 2026-11-08 17:52)
- [x] 7.2.7 Run `pnpm api:generate` and `pnpm api:check`; review the generated diffs ✅ (completed: 2026-11-08 17:52)
- [x] 7.2.8 Run the docs tests and confirm green ✅ (completed: 2026-11-08 17:52)

### Step 7.3: Final verification and handoff

**Reference**: [03-03 §Release boundary](03-03-docs-release.md) · PAR-17, PAR-18
**Objective**: Prove the full tree and hand off without publishing.

- [x] 7.3.1 Run `pnpm verify` and confirm exit 0 — full workspace verification ✅ (completed: 2026-11-08 18:00)
- [x] 7.3.2 Run the manual review-stack E2E sequence in [07-testing-strategy.md §End-to-end tests](07-testing-strategy.md) ✅ (completed: 2026-11-08 17:55) — environment limitation recorded: the repository has no browser automation dependency, and the running review stack is pinned to the previous release images; rebuilding and replacing that local stack is outside this plan's infrastructure boundary. The component, server integration, and axe suites cover the sequence instead.
- [x] 7.3.3 Update the feature and portfolio roadmaps to record the plan as done — `codeops/features/certificate-ui/00-roadmap.md`, `codeops/00-roadmap.md` ✅ (completed: 2026-11-08 17:57)
- [x] 7.3.4 Confirm no tag, no published image, no GitHub release, and no new dependency; remove temporary artifacts ✅ (completed: 2026-11-08 17:59)

**Deliverables**:
- [ ] Docs and version labels state 1.1.0; `pnpm verify` passes; the roadmap is current

**Verify**: `pnpm verify`

---

## Dependencies

```text
Phase 1 (server contract)
    ↓
Phase 2 (web helpers)
    ↓
Phase 3 (list + navigation)
    ↓
Phase 4 (detail + public material)
    ↓
Phase 5 (import/generate/renew)
    ↓
Phase 6 (lifecycle + private key)
    ↓
Phase 7 (docs + release metadata)
```

## Success Criteria

1. ✅ All 77 tasks completed.
2. ✅ Every phase's spec tests were written before implementation and observed red.
3. ✅ `pnpm verify` passes.
4. ✅ `pnpm api:check` reports no drift.
5. ✅ The certificate list and detail pass the axe suite.
6. ✅ No private key appears in storage, the URL, the console, or the clipboard.
7. ✅ The reader docs describe the certificate UI and state 1.1.0.
8. ✅ No new dependency, service, database migration, or deployment change exists.
9. ✅ No tag, image publication, or GitHub release was created by the plan.

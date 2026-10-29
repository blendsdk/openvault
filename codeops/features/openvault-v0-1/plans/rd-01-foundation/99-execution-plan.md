# Execution Plan: RD-01 Foundation

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-29 16:59
> **Progress**: 14/34 tasks (41%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the RD-01 foundation in four phases: domain contracts and workspace, schema and
migrations, CI/build security, and full verification. Every implementation phase follows the
specification-first order: scaffold the package boundary, write spec tests, run them red,
implement, run green, add impl tests, verify.

**🚨 Update this document after EACH completed task.**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Domain contracts and workspace | 10 |
| 2 | Schema and migrations | 10 |
| 3 | CI and build security | 10 |
| 4 | Full verification and close-out | 4 |

**Total: 34 tasks across 4 phases**

> **Execution rule:** mark `[~]` with a timestamp on implementation, `[x]` on verify pass,
> `[!]` with a reason on blocker. The checkboxes are the single source of truth.

---

## Phase 1: Domain contracts and workspace

> **Reasoning**: medium — bounded package and schema work with clear acceptance criteria.
> **Phase gate**: `pnpm verify`
> **Phase baseline tree**: 6c538e7a170ff3b7c94d24c7064f98381fc9f93a
> **Scope mode**: strict
> **Expected modification set**: root `package.json`, `pnpm-workspace.yaml`, `.npmrc`,
> `biome.json`, `tsconfig.base.json`, `vitest.root.config.ts`, `packages/core/**` (ids/names
> plus tests), `packages/api-contract/**`, `packages/test-support/**`,
> `apps/server/package.json`, `apps/web/package.json`, `scripts/check-single-react.mjs`,
> `tests/**`, `pnpm-lock.yaml`

### Step 1.1: Shared IDs, names, and package boundaries

**Reference**: [03-01](03-01-workspace-toolchain.md) · [07](07-testing-strategy.md) · P-03, P-06, P-13, P-14

- [x] 1.1.1 [executor] Create `packages/api-contract` and `packages/test-support` skeletons (manifest, tsconfig, vitest config, `src/index.ts`) and add workspace deps to server ✅ (completed: 2026-10-29 16:37)
- [x] 1.1.2 [executor] Add root `vitest.root.config.ts` (`.spec` and `.impl` root tests), `test:root`, strict peer settings, React overrides, clean build scripts, and WebAFX/BlendSDK peer declarations ✅ (completed: 2026-10-29 16:39)
- [x] 1.1.3 [spec-author] Write `packages/core/tests/ids.spec.test.ts` and `packages/api-contract/tests/names.spec.test.ts` for ST-1–ST-6 ✅ (completed: 2026-10-29 16:40)
- [x] 1.1.4 [executor] Run the specs and record the red-phase failures ✅ (completed: 2026-10-29 16:41)
- [x] 1.1.5 [executor] Implement `packages/core/src/ids.ts` and `names.ts`, and re-export them from `packages/core/src/index.ts` ✅ (completed: 2026-10-29 16:42)
- [x] 1.1.6 [executor] Implement `packages/api-contract/src/ids.ts` and `packages/test-support/src/sentinels.ts` ✅ (completed: 2026-10-29 16:43)
- [x] 1.1.7 [spec-author] Write `tests/react-single.spec.test.mjs` for ST-44 ✅ (completed: 2026-10-29 16:45)
- [x] 1.1.8 [executor] Implement `scripts/check-single-react.mjs`; run the specs green; add impl tests for boundaries, Unicode, and sentinel exports ✅ (completed: 2026-10-29 16:47)
- [x] 1.1.9 [executor] Add G-3 root test (`packages/core` has no production dependencies) and the verify-order test ✅ (completed: 2026-10-29 16:48)
- [x] 1.1.10 [executor] Run the phase gate ✅ (completed: 2026-10-29 16:50)

**Deliverables**: core guards, api-contract schemas, test-support sentinels, root test runner, React/Griffel check.

**Verify**: `pnpm verify` (no database).

---

## Phase 2: Schema and migrations

> **Reasoning**: high — transactional DDL, triggers, composite FKs, concurrency, and rollback.
> **Phase gate**: `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` plus `pnpm test:integration` on PG16 and PG17.

### Step 2.1: PostgreSQL schema and runner

**Reference**: [03-02](03-02-database-schema-migrations.md) · [07](07-testing-strategy.md) · P-01, P-02, P-04, P-05, P-07, P-15

- [x] 2.1.1 [spec-author] Write `apps/server/tests/integration/migrations.spec.test.ts` for ST-7–ST-19 and ST-36–ST-38 ✅ (completed: 2026-10-29 16:59)
- [x] 2.1.2 [spec-author] Write `apps/server/tests/integration/schema.spec.test.ts` for ST-20–ST-35 ✅ (completed: 2026-10-29 16:59)
- [x] 2.1.3 [executor] Create `deploy/compose/compose.test.yaml`, `vitest.integration.config.ts`, the server `test:integration` script, the unit-config exclusion, and the integration helper with the strict guard ✅ (completed: 2026-10-29 16:59)
- [x] 2.1.4 [executor] Run the integration suites against empty PostgreSQL 16 and record red-phase failures ✅ (completed: 2026-10-29 16:59)
- [ ] 2.1.5 [executor] Write the eight SQL migrations, triggers, seed, and all constraints
- [ ] 2.1.6 [executor] Implement `migrate.ts`, `cli.ts` (`db:migrate`, `--dry-run`), startup hook, lock timeout, applied-set checks, and transaction-control rejection
- [ ] 2.1.7 [executor] Run the integration suites green on PostgreSQL 16
- [ ] 2.1.8 [executor] Add impl tests for lock timeout, concurrent migrators (two DB instances), checksum edge, temp-dir failure paths, and dry-run
- [ ] 2.1.9 [executor] Run the integration suites green on PostgreSQL 17
- [ ] 2.1.10 [executor] Run the phase gate

**Deliverables**: schema, triggers, migrations, runner/CLI, startup hook, local PG16/17 harness, integration helper.

**Verify**: phase gate plus `TEST_DATABASE_URL=... OPENVAULT_TEST_DB=1 pnpm test:integration`.

---

## Phase 3: CI and build security

> **Reasoning**: high — supply-chain pins, required checks, and secret/artifact leakage.
> **Phase gate**: `pnpm verify` and a CI run on the branch.

### Step 3.1: CI gates and build hygiene

**Reference**: [03-03](03-03-build-ci-security.md) · [07](07-testing-strategy.md) · P-08, P-09, P-10

- [ ] 3.1.1 [spec-author] Write `tests/ci.spec.test.mjs` and `tests/artifacts.spec.test.mjs` for ST-39–ST-43 and G-3/G-5
- [ ] 3.1.2 [executor] Implement `scripts/check-artifacts.mjs` and `scripts/audit-check.mjs`
- [ ] 3.1.3 [executor] Run the root suites and record red-phase failures
- [ ] 3.1.4 [executor] Pin every workflow action to the SHA in 03-03; add tag comments
- [ ] 3.1.5 [executor] Move pages/OIDC permissions to the docs deploy job, add `persist-credentials: false`, add the PG16/17 integration matrix plus audit jobs, and add the Gitleaks full-history schedule/config
- [ ] 3.1.6 [executor] Set the canonical `verify`, disable production source maps, exact-pin production/dev dependencies, and enable strict peers
- [ ] 3.1.7 [executor] Run the root suites green; add impl tests for nested dist, symlinks, and content markers
- [ ] 3.1.8 [executor] Update `CONTRIBUTING.md` with test DB commands and verification order
- [ ] 3.1.9 [repo-admin] Update branch protection: PR required, linear history, no force pushes, required checks `Verify`, `Integration (16)`, `Integration (17)`, `Audit`, `Analyze JavaScript and TypeScript (javascript-typescript)`, `Gitleaks`, `Review dependency changes`; read back the settings
- [ ] 3.1.10 [executor] Run the phase gate and a CI run on the branch

**Deliverables**: SHA-pinned workflows, least-privilege permissions, integration matrix, full/prod audit, artifact/React checks, canonical verify.

**Verify**: `pnpm verify`; CI green; branch-protection read-back.

---

## Phase 4: Full verification and close-out

> **Reasoning**: medium — integration and documentation close-out.
> **Phase gate**: all tests, preflight, and docs.

### Step 4.1: Close the foundation

**Reference**: [07](07-testing-strategy.md) · [00](00-index.md)

- [ ] 4.1.1 [executor] Run `pnpm verify` and `pnpm test:integration` on PostgreSQL 16 and 17
- [ ] 4.1.2 [executor] Run `preflight` iteration 3 against the amended plan; resolve every Critical/Major finding
- [ ] 4.1.3 [executor] Update the feature roadmap to `Plan Created` and then `Plan Preflighted`, link this plan, and update the portfolio
- [ ] 4.1.4 [executor] Open the PR with the preflight report and verification evidence

**Deliverables**: green full verify, preflight report, roadmap sync, PR.

**Verify**: `pnpm verify`; integration matrix; preflight exit.

---

## Dependencies

```text
Phase 1 (domain/workspace)
    ↓
Phase 2 (schema/migrations)
    ↓
Phase 3 (CI/build security)
    ↓
Phase 4 (full verification/preflight)
```

---

## Success Criteria

1. ✅ All 34 tasks completed.
2. ✅ All ST-1…ST-44 and G-1…G-5 pass.
3. ✅ `pnpm verify` passes without a database.
4. ✅ PostgreSQL 16 and 17 integration tests pass.
5. ✅ No secret, private key, or source map in build output.
6. ✅ Every workflow action is SHA-pinned and every security job is required.
7. ✅ Preflight iteration 3 has no unresolved Critical/Major finding.
8. ✅ Documentation and roadmap updated.

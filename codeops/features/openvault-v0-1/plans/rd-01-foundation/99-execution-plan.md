# Execution Plan: RD-01 Foundation

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-30 11:40
> **Progress**: 36/40 tasks (90%)
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
| 2.5 | BlendSDK codegen adoption | 6 |
| 3 | CI and build security | 10 |
| 4 | Full verification and close-out | 4 |

**Total: 40 tasks across 5 phases**

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
- [x] 2.1.5 [executor] Write the eight SQL migrations, triggers, seed, and all constraints ✅ (completed: 2026-10-29 17:07)
- [x] 2.1.6 [executor] Implement `migrate.ts`, `cli.ts` (`db:migrate`, `--dry-run`), startup hook, lock timeout, applied-set checks, and transaction-control rejection ✅ (completed: 2026-10-29 17:07)
- [x] 2.1.7 [executor] Run the integration suites green on PostgreSQL 16 ✅ (completed: 2026-10-29 17:07)
- [x] 2.1.8 [executor] Add impl tests for lock timeout, concurrent migrators (two DB instances), checksum edge, temp-dir failure paths, and dry-run ✅ (completed: 2026-10-29 17:11)
- [x] 2.1.9 [executor] Run the integration suites green on PostgreSQL 17 ✅ (completed: 2026-10-29 17:13)
- [x] 2.1.10 [executor] Run the phase gate ✅ (completed: 2026-10-30 08:05)

**Deliverables**: schema, triggers, migrations, runner/CLI, startup hook, local PG16/17 harness, integration helper.

**Verify**: phase gate plus `TEST_DATABASE_URL=... OPENVAULT_TEST_DB=1 pnpm test:integration`.

> **Superseded**: the hand-written SQL migrations and custom runner were replaced by the
> BlendSDK codegen path in Phase 2.5. The Phase 2 evidence remains as history.

---

## Phase 2.5: BlendSDK codegen adoption

> **Reasoning**: high — schema model, generated migrations, reviewed manual SQL, and runtime
> integration.
> **Phase gate**: `pnpm verify`, PostgreSQL 16/17 integration, and `pnpm db:types:check`.
> **Phase baseline tree**: 96c509a954abdd9c78cdee2572d6f252b5283d4b
> **Scope mode**: strict
> **Expected modification set**: `apps/server/src/database/**`, `apps/server/migrations/**`,
> `apps/server/blendsdk.migrations.ts`, `apps/server/src/db/**`, `apps/server/scripts/**`,
> `apps/server/tests/**`, `apps/server/package.json`, root `package.json`, `biome.json`,
> plan docs, RD-01 data-model row

### Step 2.5: Replace hand-written schema and migration plumbing

**Reference**: [03-02](03-02-database-schema-migrations.md) · [07](07-testing-strategy.md) · P-03, P-16

- [x] 2.5.1 [spec-author] Rewrite migration integration specs for `runMigrations`, `getMigrationStatus`, `validateMigrations`, and the codegen schema model ✅ (completed: 2026-10-30 10:20)
- [x] 2.5.2 [executor] Author `apps/server/src/database/schema.ts` and `blendsdk.migrations.ts`; generate the baseline and snapshot ✅ (completed: 2026-10-30 10:20)
- [x] 2.5.3 [executor] Add the reviewed trigger/seed manual migration and remove the eight hand-written SQL migrations ✅ (completed: 2026-10-30 10:20)
- [x] 2.5.4 [executor] Replace the custom runner, CLI, and startup hook with codegen migration APIs ✅ (completed: 2026-10-30 10:20)
- [x] 2.5.5 [executor] Generate row types and CType constants, add `db:types`/`db:types:check`, and exclude generated files from Biome ✅ (completed: 2026-10-30 10:20)
- [x] 2.5.6 [executor] Run `pnpm verify`, PostgreSQL 16/17 integration, and `db:types:check` ✅ (completed: 2026-10-30 11:35)

**Deliverables**: codegen schema model, baseline and manual migrations, codegen runner/CLI,
generated types/constants, updated specs and plan.

**Verify**: `pnpm verify`; both integration suites; type drift check.

---

## Phase 3: CI and build security

> **Reasoning**: high — supply-chain pins, required checks, and secret/artifact leakage.
> **Phase gate**: `pnpm verify` and a CI run on the branch.
> **Phase baseline tree**: 1f070d977139e164f030803ba252a6482e25ff69
> **Scope mode**: strict
> **Expected modification set**: `.github/workflows/**`, `.gitleaks.toml`, `scripts/**`,
> `tests/**`, package manifests and lockfile, `tsconfig.base.json`, `apps/web/vite.config.ts`,
> `CONTRIBUTING.md`, plan docs

### Step 3.1: CI gates and build hygiene

**Reference**: [03-03](03-03-build-ci-security.md) · [07](07-testing-strategy.md) · P-08, P-09, P-10

- [x] 3.1.1 [spec-author] Write `tests/ci.spec.test.mjs` and `tests/artifacts.spec.test.mjs` for ST-39–ST-43 and G-3/G-5 ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.2 [executor] Implement `scripts/check-artifacts.mjs` and `scripts/audit-check.mjs` ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.3 [executor] Run the root suites and record red-phase failures ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.4 [executor] Pin every workflow action to the SHA in 03-03; add tag comments ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.5 [executor] Move pages/OIDC permissions to the docs deploy job, add `persist-credentials: false`, add the PG16/17 integration matrix plus audit jobs, and add the Gitleaks full-history schedule/config ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.6 [executor] Set the canonical `verify`, disable production source maps, exact-pin production/dev dependencies, and enable strict peers ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.7 [executor] Run the root suites green; add impl tests for nested dist, symlinks, and content markers ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.8 [executor] Update `CONTRIBUTING.md` with test DB commands and verification order ✅ (completed: 2026-10-30 11:25)
- [x] 3.1.9 [repo-admin] Update branch protection: PR required, linear history, no force pushes, required checks `Verify`, `Integration (16)`, `Integration (17)`, `Audit`, `Analyze JavaScript and TypeScript (javascript-typescript)`, `Gitleaks`, `Review dependency changes`; read back the settings ✅ (completed: 2026-10-30 11:40)
- [x] 3.1.10 [executor] Run the phase gate and a CI run on the branch ✅ (completed: 2026-10-30 11:40)

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
Phase 2.5 (BlendSDK codegen)
    ↓
Phase 3 (CI/build security)
    ↓
Phase 4 (full verification/preflight)
```

---

## Success Criteria

1. ✅ All 40 tasks completed.
2. ✅ All ST-1…ST-44 and G-1…G-5 pass.
3. ✅ `pnpm verify` passes without a database.
4. ✅ PostgreSQL 16 and 17 integration tests pass.
5. ✅ No secret, private key, or source map in build output.
6. ✅ Every workflow action is SHA-pinned and every security job is required.
7. ✅ Preflight iteration 3 has no unresolved Critical/Major finding.
8. ✅ Documentation and roadmap updated.

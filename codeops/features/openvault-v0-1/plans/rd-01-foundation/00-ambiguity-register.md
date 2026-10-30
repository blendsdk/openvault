# Ambiguity Register: RD-01 Foundation Plan

> **Status**: ✅ GATE PASSED — all 17 items resolved
> **Last Updated**: 2026-10-30 11:10

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|----------|-----------------|-------------------|---------------|--------|
| P-01 | Technical | Integration-test PostgreSQL harness | Compose service + `TEST_DATABASE_URL` / Testcontainers | User accepted: Compose service + `TEST_DATABASE_URL` | ✅ Resolved |
| P-02 | Technical | Migration runner | Custom TypeScript runner + SQL files / `node-pg-migrate` | Superseded by P-16: BlendSDK codegen migration runner | ✅ Resolved |
| P-03 | Technical | Type generation for the first schema | Hand-written domain/repository types now, codegen later / `blendsdk/codegen` now | User changed decision 2026-10-30: use BlendSDK codegen for generated row types, constants, and migrations | ✅ Resolved |
| P-04 | Technical | CI PostgreSQL matrix | 16 and 17 / 16 only | User accepted: 16 and 17 | ✅ Resolved |
| P-05 | Data & state | Enum representation | `text` + CHECK constraints / PostgreSQL ENUM | User accepted: `text` + CHECK | ✅ Resolved |
| P-06 | Technical | Runtime validation location | Keep `packages/core` dependency-free; Zod in `packages/api-contract` / add Zod to core | User accepted: dependency-free core | ✅ Resolved |
| P-07 | Technical | Integration-test isolation | One disposable database per run, serial / schema per worker, parallel | User accepted: one disposable database per run | ✅ Resolved |
| P-08 | Technical | Build clean step | `rm -rf dist` / `rimraf` | User accepted: `rm -rf dist` | ✅ Resolved |
| P-09 | Technical | Dependency audit scope | `pnpm audit` now; OSV/Trivy in RD-14 / add OSV now | User accepted: `pnpm audit` now | ✅ Resolved |
| P-10 | Security | GitHub Actions pin timing | Pin every action to a full SHA now / defer | User accepted: pin now | ✅ Resolved |
| P-11 | UX & presentation | Public docs updates for RD-01 | CONTRIBUTING setup only / expand docs now | User accepted: CONTRIBUTING only | ✅ Resolved |
| P-12 | Technical | Changeset for an internal foundation | No changeset / patch | User accepted: no changeset | ✅ Resolved |
| P-13 | Scope | `apps/agent` and `apps/cli` workspace timing | Defer to RD-10/RD-11 / create empty packages now | User accepted: defer; RD-01 amended | ✅ Resolved |
| P-14 | Data & state | Project name trailing hyphen | Tighten to require alphanumeric ends / allow trailing hyphen | User accepted: tighten RD-08, SQL, and TS regexes | ✅ Resolved |
| P-15 | Security | Test database reset guard | Explicit opt-in + `_test` suffix + local/CI host + unique database / substring `test` | User accepted: strict guard and unique database | ✅ Resolved |
| P-16 | Technical | Migration implementation after BlendSDK 5.68.1 | Custom SQL runner + hand-written DDL / BlendSDK `DatabaseSchema` + generated baseline + manual trigger/seed migration | User approved full codegen path on 2026-10-30 | ✅ Resolved |
| P-17 | Data & state | Migration atomicity | Whole-run rollback / per-migration transaction | Codegen commits per migration; a failed migration rolls back its own effects, earlier migrations remain, startup fails | ✅ Resolved |

## Resolution Notes

**Bulk acceptance:** The user said "accept all plan decisions". Every row is recorded with the
recommended option spelled out above. Any change to these choices reopens the affected row
before implementation.

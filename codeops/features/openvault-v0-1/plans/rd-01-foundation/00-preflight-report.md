# Preflight Report: RD-01 Foundation Plan

> **Audit target**: `codeops/features/openvault-v0-1/plans/rd-01-foundation/`
> **Context**: RD-01 requirements, RD-08, and the existing repository
> **Date**: 2026-10-30 11:55
> **Status**: ✅ PASSED WITH NOTES — all Critical/Major findings resolved; final implementation addendum included
> **Same-session warning**: the plan was authored and reviewed in this session. The fixes were
> re-checked by a separate read-only preflight auditor; an independent human review is still
> recommended before implementation.

## Summary

| Iteration | Result |
|---|---|
| 1 | 30 findings: 3 Critical, 13 Major, 12 Minor, 2 Observations |
| 2 | 13 blocking findings remained: 1 Critical, 12 Major |
| 3 | 2 Major blockers remained |
| Final re-check | Resolved; no known Critical/Major finding |

## Resolved blocking findings

| ID | Problem | Resolution |
|---|---|---|
| PF-001 / PF2-006 | Integration tests ran inside the default unit test run without a database | Separate `vitest.config.ts` excludes `tests/integration/**`; `vitest.integration.config.ts` and `test:integration` added; Phase 2 task creates them |
| PF-002 | Artifact check rejected its own maps and `keyring.*` source files | Production maps disabled; scan roots limited to app/package `dist`; `keyring.js`/`.d.ts` allowed; content scan added |
| PF-003 / PF2-005 | Test DB reset could destroy a shared database; unique schema was not isolated | `OPENVAULT_TEST_DB=1`, `_test` maintenance URL, local/CI host, unique `openvault_test_<ulid>` database per run, no `DROP SCHEMA public` |
| PF-004 | RD-01 required `apps/agent`/`apps/cli`, plan deferred them | RD-01 amended; plan AR P-13 records the deferral to RD-10/RD-11 |
| PF-005 / PF2-007 | Three `verify` definitions; missing root check scripts | One canonical `verify`; `check:artifacts` and `check:react` root scripts defined |
| PF-006 | Root spec tests were never run | Root `vitest.root.config.ts`, `test:root`, included in `verify`; `.spec` and `.impl` included |
| PF-007 / PF2-008 | Package exports said `src`; workspace deps and scripts missing | `dist` exports, server workspace deps, package build/test scripts, core barrel re-export, test-support sentinel test |
| PF-008 / PF2-010 | No migrate CLI/startup hook; no production DB URL | `db:migrate`, `--dry-run`, startup hook, `OPENVAULT_DB_URL`, ST-18/19 |
| PF-009 / PF2-003 / PF2-004 | Schema invariants were not enforced | Object-scope CHECK, project/identity composite FKs, audit `project_id`, audit append-only triggers, version immutability, purge-protection trigger, idempotency request hash/expiry, pruner/purger role contract |
| PF-010 / PF2-001 / PF2-002 | Runner rejected trigger bodies; out-of-order detection was wrong | SQL lexer strips comments/strings/dollar-quotes; rejects top-level transaction control; compares every pending id to max applied |
| PF-011 / PF2-009 | Required checks, docs permissions, branch protection incomplete | Exact required checks, deploy-only pages/OIDC, `persist-credentials: false`, branch-protection read-back; no unowned Artifact Check job |
| PF-012 | Audit covered only production dependencies | `audit:prod` and `audit:full` both block |
| PF-013 | React check did not see `apps/web`; Griffel ignored | `pnpm -r list react` and `@griffel/react`; root argument for fixture |
| PF-014 | No local PostgreSQL 16/17 test harness | `deploy/compose/compose.test.yaml` with PG16/17 profiles and CONTRIBUTING commands |
| PF-015 / PF2-011 / PF2-012 | ST count and references were inconsistent; regex/grammar contradictions | 44 ST cases + 5 gates; references corrected; project regex rejects trailing hyphen; CodeQL subpath accepted; table count fixed |
| PF-016 | No FK/unique inventory; invariants untested | ST-20–ST-35 cover tables, FKs, unique constraints, CHECKs, triggers, ownership, object scope |
| PF-017 | Migration tests could edit versioned files | Impl tests copy migrations to a temp directory |
| PF-018 | `org` not seeded; no schema handshake | Org seed added; applied-set check aborts when disk and database diverge |
| PF-019 / PF2-007 | Unowned deliverables | dry-run, artifact/React scripts, lock timeout, build-clean, test-support test tasked; repositories layer removed from RD-01 |
| PF-020 | `.npmrc` peer settings ineffective; typo | Settings moved to `pnpm-workspace.yaml`; strict peers enabled; `yesql` corrected |
| PF-021 | Project regex accepted `abc-` | RD-08, TS, and SQL regex now require alphanumeric ends |
| PF-022 / PF2-006 | Phase ordering and roadmap | Package/helper scaffolding before spec runs; preflight before execution; roadmap set to Plan Created |
| PF-023 | Name rules traced to RD-01 | Now traced to RD-08; TS/SQL consistency test added to the plan |
| PF-024 | Audit test not deterministic | `scripts/audit-check.mjs` with fixture JSON and ST-41 |
| PF-025 | Mutable container tags | Deferred to RD-13 image digest pinning; recorded as accepted scope |
| PF-026 | Gitleaks diff-only | Full-history schedule, config, and license/OSS fallback added |
| PF-027 | `.env.example` vs no-secret rule | Secret-free `.env.example` explicitly allowed; Gitleaks/artifact scan cover real values |
| PF-028 | Shared-instance `withTransaction` risk | ST-16 uses two `PostgreSQLDatabase` instances; constraint documented |
| PF-029 | `/ready` unconditional | RD-02 dependency recorded; RD-01 does not claim readiness |
| PF-030 | Pin table tags, unused pattern | Tag column added; `SERVICE_NAME_PATTERN` removed |

## Accepted notes

1. **Container image digests:** CI/Compose Postgres images remain tag-based in RD-01; digest
   pinning and Dependabot Docker updates belong to RD-13. This does not affect the RD-01
   schema or build gates.
2. **Human review:** this was a same-session review. A separate human or external review is
   still required before production, as RD-14 states.

## Verification evidence

| Check | Result |
|---|---|
| Schema DDL on PostgreSQL 16 | Applied cleanly: 19 tables, 24 foreign keys, triggers created |
| Schema DDL on PostgreSQL 17 | Applied cleanly: 19 tables |
| Action SHA pins | Resolved to the intended upstream tags |
| Local `pnpm verify` | Green on the existing scaffold (before plan-only edits) |
| Internal links | All plan/requirements links resolve |
| Preflight re-scan | No known Critical/Major finding after the final fixes |

## Verdict

**✅ PREFLIGHT PASSED WITH NOTES — all Critical/Major findings resolved; 2 minor notes accepted.**

The plan is ready for execution testing. The first execution task is still a specification
test, not product code.

## Final implementation addendum (2026-10-30)

The plan was executed and then amended for BlendSDK 5.68.1 codegen adoption. A second
read-only phase review covered the codegen refactor; a third review covered the CI/build
security phase.

| Area | Final evidence |
|---|---|
| Codegen schema and migrations | `DatabaseSchema` baseline + reviewed trigger/seed manual migration; PostgreSQL 16/17 integration 30/30 each |
| Generated types | `db:types:check` clean after a migration |
| Runtime | `runMigrations` startup and CLI wrapper; invalid history and startup refusal tested |
| CI | Verify, Integration 16/17, Audit, CodeQL, Gitleaks, dependency review all green |
| Branch protection | Exact required checks, strict, linear, no force/delete, admins enforced |
| Full verification | `pnpm verify` green; 18 root policy tests |

Remaining accepted notes:

1. Database role separation is deferred to RD-13; until then deployment must not use the
   table owner as the runtime role. RD-13 now contains the requirement.
2. A `schema.ts` change is not a CI drift failure until a migration is generated; the
   limitation is documented and the generator is part of the workflow.
3. Container image digests remain deferred to RD-13.
4. This was an internal/AI review; independent human or external review is still required
   before production, as RD-14 states.

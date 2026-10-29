# RD-01 Foundation Implementation Plan

> **Feature**: Workspace, data model, migrations, and build security for OpenVault v0.1
> **Status**: Planning Complete — preflight passed with notes
> **Created**: 2026-10-29 15:20
> **Implements**: openvault-v0-1/RD-01
> **CodeOps Artifact Schema**: 1

## Overview

This plan implements the foundation that every later OpenVault requirement depends on: a
reproducible pnpm/TypeScript 7 workspace, the PostgreSQL schema, an idempotent migration
runner, shared identity/name schemas, a test support package, and CI/build security controls.

The plan does not implement authentication, secrets, certificates, the agent, or the UI. It
creates the boundaries and evidence those features will build on. The current scaffold
already has a crypto primitive and a WebAFX readiness endpoint; this plan keeps the
workspace and replaces the unverified build/data foundation around them.

## Minimum-Sufficient Baseline

**Original goal:** a reproducible foundation with a schema and migration path that later
security phases can trust.

**Smallest viable design:** keep the existing pnpm/TypeScript 7/Biome workspace, add the
missing shared packages, define the schema in plain SQL, run it with a small TypeScript
runner, and enforce build/CI security with existing tools.

**Excluded machinery:** ORM, migration framework, Testcontainers, code generator, Redis,
Kubernetes, and multi-tenant schema.

**Approved complexity:** None in this plan. The release signing/SBOM pipeline is RD-14.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Plan decisions (15 resolved) |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Delta view of RD-01 |
| 02 | [Current State](02-current-state.md) | What exists and what is missing |
| 03-01 | [Workspace and Toolchain](03-01-workspace-toolchain.md) | pnpm workspace, TS 7, Biome, package layout |
| 03-02 | [Database Schema and Migrations](03-02-database-schema-migrations.md) | Tables, constraints, indexes, runner |
| 03-03 | [Build and CI Security](03-03-build-ci-security.md) | CI, action pinning, audit, secret scan |
| 05 | [Findings Ledger](05-findings.md) | Phase review findings and rulings |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases ST-1…ST-44 and gates G-1…G-5 |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, task checklist |

## Quick Reference

### Key Decisions

| Decision | Outcome |
|---|---|
| Integration DB | Compose/service Postgres via `TEST_DATABASE_URL` |
| Migrations | Custom TypeScript runner + immutable SQL files + checksums |
| Schema types | Hand-written domain/repository types; codegen later |
| Database support | PostgreSQL 16 and 17 |
| Enums | `text` + CHECK constraints |
| Validation | Zod in `packages/api-contract`; `packages/core` dependency-free |
| Test isolation | One disposable database per integration run, serial |
| Build clean | `rm -rf dist` |
| Dependency audit | `pnpm audit --prod --audit-level=high` |
| Actions | Pin every action to a full commit SHA now |
| Docs | `CONTRIBUTING.md` setup only |
| Changeset | None for this internal foundation |

### Usage Examples

```bash
pnpm install --frozen-lockfile
pnpm verify
TEST_DATABASE_URL=postgres://openvault:openvault@localhost:5432/openvault_test \
  pnpm --filter @openvault/server test:integration
```

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| `correctness-reviewer` | reviewer | Migration transaction, lock, and checksum behavior | P-02, P-07 |
| `security-auditor` | reviewer | CI pinning, dependency audit, no secrets in build output | P-09, P-10 |
| `preflight-auditor` | reviewer | Plan/RD completeness before execution | RD-01 |
| `spec-test-author` | executor | Write ST-1…ST-44 before implementation | 07 |

Detection evidence: the plan changes the database schema, the migration runner, CI workflows,
and dependency policy. These are security- and correctness-sensitive surfaces.

## Related Files

| Path | Purpose |
|---|---|
| `package.json` | Root scripts, package manager, exact pins |
| `pnpm-workspace.yaml` | Workspace packages and build allowlist |
| `tsconfig.base.json` | TypeScript 7 baseline |
| `biome.json` | Lint/format baseline |
| `.npmrc` | pnpm peer resolution |
| `packages/core/src/` | Dependency-free domain types |
| `packages/api-contract/src/` | Shared Zod schemas and IDs |
| `packages/test-support/src/` | Sentinels and fixtures |
| `apps/server/src/db/` | Migration runner and repositories |
| `apps/server/migrations/` | Ordered SQL migrations |
| `apps/server/src/db/migrate.ts` | Migration runner |
| `apps/server/src/db/cli.ts` | `db:migrate` and `--dry-run` |
| `scripts/check-artifacts.mjs` | Build artifact/content check |
| `scripts/check-single-react.mjs` | React/Griffel duplicate check |
| `scripts/audit-check.mjs` | Audit JSON parser for tests |
| `deploy/compose/compose.test.yaml` | Local PostgreSQL 16/17 test profiles |
| `vitest.root.config.ts` | Root policy tests |
| `.github/workflows/ci.yml` | Verification, audit, integration matrix |
| `.github/workflows/codeql.yml` | CodeQL |
| `.github/workflows/dependency-review.yml` | Dependency review |
| `.github/workflows/secret-scan.yml` | Gitleaks |
| `.github/workflows/docs.yml` | Docs build/deploy permissions |
| `CONTRIBUTING.md` | Setup, test DB, verification order |

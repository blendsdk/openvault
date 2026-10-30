# Current State: RD-01 Foundation

> **Historical snapshot**: this document describes the repository before RD-01 execution.
> See `99-execution-plan.md` for the current implemented state.

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What exists

- A pnpm workspace with `apps/server`, `apps/web`, and `packages/core`.
- TypeScript 7.0.2, Biome 2.6.4, Vitest 5.0.5, and Vite 8.3.5 pinned.
- An AES-256-GCM crypto primitive and tests in `packages/core`.
- A WebAFX server with a single `/v1/ready` route and a passing supertest.
- A React 19 + Fluent UI web shell.
- CI, CodeQL, dependency review, and Gitleaks workflows.
- VitePress docs and GitHub Pages deployment.

### Relevant files

| File | Purpose | Changes needed |
|---|---|---|
| `package.json:12-35` | Root scripts and dev dependencies | Add integration scripts; exact-pin remaining ranges; clean builds |
| `pnpm-workspace.yaml:1-19` | Workspace and build allowlist | Normalize build-script allowlist; confirm pnpm 12 behavior |
| `.npmrc:1-2` | Peer resolution | Decide whether strict peers are safe in CI |
| `apps/server/package.json:14-36` | Server dependencies | Exact-pin production dependencies; add DB/migration scripts |
| `packages/core/package.json:19-23` | Core package | Keep dependency-free; add domain types |
| `.github/workflows/ci.yml:20-38` | CI | Pin actions to SHAs; add Postgres integration matrix and audit |
| `.github/workflows/codeql.yml:25-38` | CodeQL | Pin actions to SHAs |
| `.github/workflows/secret-scan.yml:16-24` | Gitleaks | Pin action to SHA; add full-history schedule |
| `.github/workflows/docs.yml:17-20` | Docs build/deploy | Move pages/OIDC permissions to deploy only |
| `apps/server/src/` | WebAFX app | Add config/db/migrations; no product routes yet |
| `packages/core/src/` | Crypto and keyring | Add shared name/ID types; do not widen dependencies |

### Code analysis

- The root `verify` script at `package.json:18` runs typecheck, Biome, unit tests, builds, and
  docs, but no database integration test.
- The server package has no `test:integration` script and no database dependency wiring.
- `apps/server` does not depend on `@openvault/core`; the workspace is not yet composed.
- `packages/core` has no Zod dependency, which matches P-06.
- No `packages/api-contract`, `packages/test-support`, `apps/agent`, or `apps/cli` exists.
- No `migrations/` directory or `schema_migrations` table exists.
- CI uses mutable major tags (`actions/checkout@v4`, `pnpm/action-setup@v4`,
  `actions/setup-node@v4`, `github/codeql-action/*@v3`, `gitleaks/gitleaks-action@v2`).
- CI has no PostgreSQL service, no integration matrix, and no `pnpm audit`.

## Gaps Identified

### Gap 1: No persistent schema or migration path

**Current behavior:** the server has no database layer and no migrations.
**Required behavior:** RD-01 schema, invariants, indexes, and an idempotent checksummed runner.
**Fix required:** add `apps/server/migrations/`, a migration runner, repository types, and
PostgreSQL 16/17 integration tests.

### Gap 2: Workspace packages are incomplete

**Current behavior:** only server, web, and core exist.
**Required behavior:** `packages/api-contract`, `packages/test-support`, and the package
boundaries later RDs consume.
**Fix required:** create the packages with shared Zod schemas and sentinel fixtures; keep
`packages/core` dependency-free.

### Gap 3: CI is not a security gate yet

**Current behavior:** actions are tag-pinned; no dependency audit; no Postgres integration.
**Required behavior:** SHA pins, least-privilege permissions, audit, integration matrix, and
frozen installs.
**Fix required:** update workflows and add scripts.

### Gap 4: Dependency ranges are mixed

**Current behavior:** production dependencies use carets; some dev dependencies use carets.
**Required behavior:** exact pins for production; lockfile integrity; documented update policy.
**Fix required:** pin versions, regenerate the lockfile, and keep Dependabot/Changesets.

### Gap 5: Build output is not cleaned or checked

**Current behavior:** `tsc` emits `.js.map` and `.d.ts.map`; `dist` is not cleaned; the
production web build also emits source maps.
**Required behavior:** clean builds, no production maps, and artifact/content checks.
**Fix required:** update build scripts and tsconfigs; add artifact and React checks.

## Dependencies

### Internal dependencies

- `packages/core` — domain types and crypto; must stay I/O-free.
- `packages/api-contract` — Zod schemas and shared ID/name types.
- `packages/test-support` — sentinel fixtures.
- `apps/server` — WebAFX, database, migrations.
- `apps/web` — consumes shared schemas later.

### External dependencies

- `blendsdk` 5.67.0, `express` 5, `pg`, `yesql`, `zod` 4, `vitest`, `biome`,
  `typescript` 7.0.2.
- PostgreSQL 16 and 17 in CI.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration runs twice or partially | Medium | High | Advisory lock, transaction, checksum, idempotency test |
| Test database contamination | Medium | Medium | One disposable database per run, serial integration tests |
| SHA pin mistakes break CI | Low | Medium | Resolve SHAs from the same tag; Dependabot updates |
| Exact pins drift from lockfile | Low | Medium | `pnpm install --frozen-lockfile` and review |
| TypeScript 7 type incompatibility | Low | High | Existing compile check; keep pinned |
| CI matrix doubles runtime | High | Low | Two PostgreSQL jobs only for integration |
| Secret files enter the build context | Low | Critical | ignore rules, artifact scan, Gitleaks |
| `packages/core` gains a dependency | Low | Medium | dependency-free test in CI |

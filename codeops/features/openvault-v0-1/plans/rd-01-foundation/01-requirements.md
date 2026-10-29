# Requirements: RD-01 Foundation

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-01](../../requirements/RD-01-foundation-data-build.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan

- RD-01 R1: pnpm/TypeScript 7 workspace and package layout.
- RD-01 R2: PostgreSQL schema and invariant constraints.
- RD-01 R3: idempotent, checksummed migration runner.
- RD-01 R4: shared name/ID schemas in a dependency-free core plus `api-contract`.
- RD-01 R5: build security, dependency pinning, audit, CodeQL, Gitleaks, dependency review.
- RD-01 R6: CI PostgreSQL 16/17 integration matrix.
- RD-01 R7: no secrets or private keys in the repository or build output.

### Deferred / out of this plan

- RD-01 R8: generated types from the live schema (`blendsdk/codegen`) — deferred until the
  schema stabilizes; hand-written types are used now.
- RD-01 R9: full release signing/SBOM/image scanning — RD-14.
- Authentication, secrets, certificates, agent, CLI, and UI — later RDs.

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Integration database harness | Compose/service Postgres via `TEST_DATABASE_URL` | P-01 |
| Migration runner | Custom TypeScript runner + SQL files + checksums | P-02 |
| Type generation | Hand-written types now; codegen later | P-03 |
| PostgreSQL CI matrix | 16 and 17 | P-04 |
| Enum representation | `text` + CHECK constraints | P-05 |
| Validation location | Zod in `packages/api-contract`; core dependency-free | P-06 |
| Test isolation | One disposable database per run, serial | P-07 |
| Build clean | `rm -rf dist` | P-08 |
| Dependency audit | `pnpm audit --prod --audit-level=high` now | P-09 |
| Action pinning | Full SHA now | P-10 |
| Public docs | `CONTRIBUTING.md` setup only | P-11 |
| Changeset | None | P-12 |

## Acceptance Criteria

1. [ ] All 44 specification test cases and 5 CI/manual gates in `07-testing-strategy.md` pass.
2. [ ] `pnpm verify` passes typecheck, Biome, builds, unit/root tests, artifact/React checks, and docs build without a database.
3. [ ] The schema and migration runner pass on PostgreSQL 16 and 17.
4. [ ] The workspace contains the RD-01 packages; `apps/agent` and `apps/cli` are created by RD-10/RD-11 (P-13).
5. [ ] No production dependency uses a caret range; no secret or private key is in the tree or build output.
6. [ ] Security requirements verified: full/prod audit, CodeQL, Gitleaks, dependency review, SHA pins, least-privilege workflow permissions, branch protection.

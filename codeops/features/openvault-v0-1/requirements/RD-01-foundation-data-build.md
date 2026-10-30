# RD-01: Foundation, Data Model, and Build Security

> **Document**: RD-01-foundation-data-build.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: —
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document establishes the repository, toolchain, persistent data model, migration
runner, and baseline build-security controls that every later requirement depends on. It
does not implement product behavior; it makes the later behavior testable, reproducible, and
reviewable.

## Functional Requirements

### Must Have

- [ ] pnpm workspace with `apps/server`, `apps/web`, `packages/core`, `packages/api-contract`, and `packages/test-support`. `apps/agent` and `apps/cli` are created by RD-10 and RD-11.
- [ ] Node.js 22.23+, TypeScript 7.0.2, Biome 2.6.4, Vitest 5.0.5, Vite 8.3.5, and VitePress
  1.6.4 pinned in the root manifest or lockfile.
- [ ] All production dependencies pinned to exact versions; lockfile committed and CI uses
  `--frozen-lockfile`.
- [ ] PostgreSQL schema and an idempotent, checksummed migration runner.
- [ ] CI runs typecheck, Biome, unit tests, integration tests, builds, and docs build.
- [ ] CI runs dependency audit, CodeQL, Gitleaks, and dependency review.
- [ ] `main` is protected: pull request, required checks, linear history, no force pushes.
- [ ] No secret values, private keys, or production hostnames in the repository or test
  fixtures.

### Should Have

- [ ] Generated TypeScript types from the PostgreSQL schema for repositories and tests.
- [ ] A migration dry-run command and a test that applies migrations twice.
- [ ] CI matrix for PostgreSQL 16 and 17.

### Won't Have (Out of Scope)

- ORM or schema-sync tooling — explicit SQL is required for audit ordering and controlled
  migrations.
- Multi-tenant columns or tenant isolation — single organization in v0.1.
- Kubernetes, remote-host, or HA deployment scaffolding.

## Technical Requirements

### Repository and toolchain

| Concern | Requirement |
|---|---|
| Node | `>=22.23.0` |
| TypeScript | `7.0.2`, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| Server module resolution | `NodeNext` |
| UI module resolution | `Bundler` |
| Lint / format | Biome 2.6.4; `.opencode` and generated output excluded |
| Package manager | pnpm 12.11.2, `dedupe-peer-dependents=true` |
| React | single React 19 and Griffel instance; overrides and duplicate check |

### Data model

| Table | Purpose |
|---|---|
| `org` | Single organization row |
| `projects` | Project namespace, soft delete |
| `principals` | Human users and service identities, `owner_project_id` for services |
| `local_credentials` | Argon2id hash, forced-change flag, lockout counters |
| `oidc_identities` | `(issuer, subject)` link |
| `cli_sessions` | Hashed CLI refresh tokens and rotation family |
| `workload_certs` | Agent certificate serial and fingerprint, expiry, revocation |
| `join_tokens` | Hashed single-use join tokens, project binding, expiry |
| `consumers` | Agent registration: Compose project/service, hostname, manifest hash, last seen |
| `role_assignments` | Principal, role, scope type/id, grantor, expiry |
| `secrets` | Project, name, current version, tags, purge protection, deletion |
| `secret_versions` | Immutable envelope, creator, expiry |
| `certificates` | Project, name, current version, purge protection, deletion |
| `certificate_versions` | Chain, encrypted private key, metadata, validity |
| `audit_events` | Append-only event, project id, chain hash, HMAC, audit key id |
| `audit_checkpoints` | Last event id/hash and HMAC |
| `audit_keys` | Wrapped HMAC key |
| `idempotency_keys` | Principal, key, method, path, resource id, created |
| `blendsdk_migrations` | Applied migration id, checksum, timestamp (BlendSDK ledger) |

Invariants:

1. Version rows are never updated after insert; only `current_version_id` moves.
2. Secret/certificate writes and their audit events commit in one transaction.
3. Soft-deleted rows are hidden by default; `purge_after` is derived from retention.
4. Purge protection is one-way and cannot be disabled.
5. Audit rows are never updated or deleted by application code.
6. A service identity must have exactly one owner project.
7. `role_assignments` scope is `org`, `project`, or `object`; object scope is limited to
   reader roles.

### Migration runner

- Migrations are ordered SQL files with a recorded checksum.
- Each migration runs in its own transaction; a failure rolls back the failing migration and
  stops startup. Earlier applied migrations remain recorded in the ledger.
- The run takes an advisory lock so two instances cannot race.
- Re-running a migration set is a no-op.
- A checksum mismatch aborts startup.
- A failed migration leaves no partial effects from that migration and stops startup; the next
  run retries the pending migration.
- Migrations never contain secret values.
- All timestamps are stored and returned in UTC; user-facing formatting is the UI's
  responsibility.
- Migrations are forward-only in v0.1; there is no mixed-version window because the stack is
  single-node and drained before upgrade.

### Build and CI security

- `pnpm verify` runs typecheck, Biome, tests, builds, and docs.
- `pnpm audit --prod --audit-level=high` fails CI on high or critical findings.
- CodeQL, Gitleaks, and dependency review are required checks.
- GitHub Actions are pinned to full commit SHAs; workflow permissions are least privilege.
- Build artifacts do not include `.env`, keyrings, test fixtures, or source maps for the
  server.
- `dist/` is cleaned before build.

## Integration Points

- Every later RD uses this schema and migration runner.
- RD-02 consumes the config and keyring location.
- RD-07 writes `audit_events`; RD-08 and RD-09 write secret/certificate rows.
- RD-14 verifies the CI and release controls.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Feature boundary | One release / split | One feature | Cross-cutting security decisions | AR-1 |
| Database | PostgreSQL / other | PostgreSQL | Transactions and audit ordering | AR-6 |
| Schema style | ORM / explicit SQL | Explicit SQL + migrations | Control and reviewability | AR-4 |
| Dependency policy | Caret / exact | Exact pins | Supply-chain control | AR-17, AR-23 |
| CI security | Basic / full | Audit + CodeQL + Gitleaks + dependency review | Baseline for a secrets product | AR-18, AR-23 |

## Security Considerations

- **Data sensitivity:** the schema stores ciphertext, wrapped keys, certificate private keys,
  password hashes, and audit evidence. No plaintext values.
- **Input validation:** schema and migration identifiers are code-reviewed, not user input.
- **Authentication & authorization:** no routes in this RD; access is enforced later.
- **Injection risks:** migrations are static SQL; repository queries are parameterized.
- **Encryption needs:** ciphertext fields are `bytea`; keys never enter SQL.
- **Rate limiting:** N/A in this RD.
- **Infrastructure:** non-root CI containers, pinned actions, least-privilege workflow
  permissions, no secrets in logs.

## Acceptance Criteria

1. [ ] `pnpm install --frozen-lockfile` succeeds on a clean checkout.
2. [ ] `pnpm verify` passes typecheck, Biome, tests, builds, and docs build.
3. [ ] Applying migrations to an empty PostgreSQL 16 database succeeds; applying them a
   second time is a no-op; a checksum mismatch aborts startup.
4. [ ] A failed migration leaves no partial effects from that migration and prevents the server
   from starting; earlier applied migrations remain recorded.
5. [ ] `pnpm audit --prod --audit-level=high` exits 0 with the committed lockfile.
6. [ ] CI fails when a high-severity dependency is introduced or a secret is detected.
7. [ ] No `.env`, keyring, private key, or production hostname is present in the repository
   or build artifacts.
8. [ ] A schema test asserts every table in the data model exists with the required unique
   constraints, foreign keys, and CHECK constraints.
9. [ ] Security requirements verified: no secrets in source, pinned dependencies, least-
   privilege CI.

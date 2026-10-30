# Testing Strategy: RD-01 Foundation

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage goals

| Code type | Target |
|---|---|
| Domain schemas and guards | 95% |
| Migration runner and triggers | 90% |
| Build/CI helper scripts | 85% |
| Configuration/glue | 70% |

- Test names state behavior: `should [expected] when [condition]`.
- Integration tests use a real PostgreSQL 16/17 instance; no database mocks.
- No test uses a real secret; `packages/test-support` supplies sentinels.
- Spec tests are immutable once implementation starts.

## Specification Test Cases

### Domain schemas

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | ULID `01ARZ3NDEKTSV4RRFFQ69G5FAV` | Accepted by `isUlid` | RD-01 R4 |
| ST-2 | ULID containing `I`, `L`, `O`, or `U`; 25/27 chars; empty | Rejected by `isUlid` | RD-01 R4 |
| ST-3 | Project names `abc`, `a-b-c`, `a1-b2`, `abc-d` | Accepted by `projectNameSchema` | RD-08 R1 / P-14 |
| ST-4 | Project names `ab`, `A-Project`, `-abc`, `abc-`, `a_b`, 41 chars | Rejected with validation error | RD-08 R1 / P-14 |
| ST-5 | Secret names `db-password`, `A1`, 127 chars | Accepted by `secretNameSchema` | RD-08 R2 / P-14 |
| ST-6 | Secret names with `/`, `..`, NUL, 128 chars | Rejected with validation error | RD-08 R2 / P-14 |

### Migrations

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-7 | Empty PostgreSQL 16 database; apply migrations | `UP_TO_DATE`; baseline, manual migration, and 19 tables exist | RD-01 R3 / P-04 |
| ST-8 | Empty PostgreSQL 17 database; apply migrations | `UP_TO_DATE`; baseline, manual migration, and 19 tables exist | RD-01 R3 / P-04 |
| ST-9 | Apply the same migrations twice | Second run is `UP_TO_DATE`; no new ledger rows | RD-01 R3 / P-02 |
| ST-10 | Modify an applied migration; validate history | `INVALID_HISTORY`; codegen rejects the checksum mismatch | RD-01 R3 / P-02 |
| ST-11 | Delete or rename an applied migration; validate history | `INVALID_HISTORY`; codegen rejects the missing id | RD-01 R3 / P-02 |
| ST-12 | Add a migration that sorts before the latest applied id | Codegen rejects the ordering change | RD-01 R3 / P-02 |
| ST-13 | Empty migration directory | Codegen rejects the configuration | RD-01 R3 / P-02 |
| ST-14 | Migration contains top-level `BEGIN`, `COMMIT`, or `ROLLBACK` | Codegen rejects transaction control; PL/pgSQL bodies remain valid | RD-01 R3 / P-02 |
| ST-15 | Migration contains invalid SQL | The failing migration leaves no partial effects; earlier migrations remain recorded | RD-01 R3 / P-02 |
| ST-16 | Two migrators on the same database | Codegen advisory lock serializes them; no duplicate ledger rows | RD-01 R3 / P-02 |
| ST-17 | Migration lock is held | Codegen reports lock contention and leaves no partial apply | RD-01 R3 / P-02 |
| ST-18 | `db:migrate --dry-run` with pending files | `PENDING`; no ledger or tables created | RD-01 R3 / P-02 |
| ST-19 | Server starts without `OPENVAULT_DB_URL` | Startup exits non-zero before binding HTTP | RD-01 R3 / RD-01 AC4 |

### Schema inventory and constraints

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-20 | Query `information_schema.tables` | 19 tables exist, including `blendsdk_migrations` | RD-01 R2 |
| ST-21 | Query foreign keys | Every declared FK exists with the expected columns and delete action | RD-01 R2/AC8 |
| ST-22 | Query unique constraints/indexes | Active project/secret/certificate names, refresh/token hashes, serials, fingerprints, consumer principal, and assignment coalescence are unique | RD-01 R2/AC8 |
| ST-23 | Query CHECK constraints | Role, scope, result, actor kind, status, name, purge, and envelope length checks exist | RD-01 R2/AC8 |
| ST-24 | `secrets.current_version_id` references another secret’s version | Composite FK rejects at commit | RD-01 R2 / P-05 |
| ST-25 | `certificates.current_version_id` references another certificate’s version | Composite FK rejects at commit | RD-01 R2 / P-05 |
| ST-26 | Insert a 11-byte nonce, 15-byte tag, 31-byte wrapped DEK, or >64 KiB ciphertext | CHECK rejects the row | RD-01 R2 |
| ST-27 | Insert an audit event with a 31-byte hash or unknown `audit_key_id` | CHECK/FK rejects the row | RD-01 R2 |
| ST-28 | Direct `UPDATE`/`DELETE` on `audit_events` or `audit_checkpoints` | Trigger rejects | RD-01 R2 / RD-07 |
| ST-29 | Direct `UPDATE` on a secret/certificate version | Trigger rejects | RD-01 R2 |
| ST-30 | Direct `DELETE` on a version without `openvault.allow_purge=on` | Trigger rejects | RD-01 R2 |
| ST-31 | Disable `purge_protected` on an existing secret/certificate | Trigger rejects | RD-01 R2 |
| ST-32 | Insert an object-scope assignment with `org.admin` or `secrets.manager` | CHECK rejects | RD-01 R2 / RD-06 |
| ST-33 | Insert a join token/consumer whose project differs from the principal owner | Composite FK rejects | RD-01 R2 / RD-05 |
| ST-34 | Service principal not owned by any project | CHECK rejects | RD-01 R2 |
| ST-35 | `org` table after migration | Exactly one row with id 1 | RD-01 R2 |

### Test database and guard

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-36 | Integration suite without `TEST_DATABASE_URL` or `OPENVAULT_TEST_DB` | Exits non-zero with a setup message; no schema changes | RD-01 R3 / P-01, P-15 |
| ST-37 | URL database name not ending `_test`, or host not local/CI | Exits non-zero before any DDL | RD-01 R3 / P-15 |
| ST-38 | Valid test DB | Creates a unique `openvault_test_<ulid>` database, runs migrations, drops only that database | RD-01 R3 / P-15 |

### CI and artifacts

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-39 | Parse every workflow `uses:` line | `owner/repo(/subpath)?@<40-hex>` plus tag comment; no mutable tags | RD-01 R5 / P-10 |
| ST-40 | Workflow permissions | `contents: read` top level; pages/OIDC only on deploy; checkout `persist-credentials: false` | RD-01 R5 / P-10 |
| ST-41 | `audit-check.mjs` with a fixture JSON containing a high advisory | Exit 1 | RD-01 R5 / P-09 |
| ST-42 | `check-artifacts.mjs` on a clean temp root | Exit 0 | RD-01 R5 / P-08, P-10 |
| ST-43 | `check-artifacts.mjs` on a temp root with `.env`, `server.key`, `index.js.map`, or the sentinel | Exit 1 and print each path | RD-01 R5 / P-10 |
| ST-44 | `check-single-react.mjs` with a nested fixture containing two React or Griffel versions | Exit 1 and print both paths | RD-01 R1 / P-06 |

### CI/manual gates

| Gate | Expected behavior | Source |
|---|---|---|
| G-1 | Clean checkout + `pnpm install --frozen-lockfile` | Exit 0; lockfile unchanged | RD-01 R1 |
| G-2 | `pnpm verify` | Exit 0; build, typecheck, Biome, unit/root tests, artifact, React, docs | RD-01 R1/R5 |
| G-3 | `packages/core/package.json` | No production dependencies | RD-01 R4 |
| G-4 | `pnpm audit:prod` / `pnpm audit:full` | Exit 0 on the committed lockfile | RD-01 R5 |
| G-5 | Branch protection read-back | Exact required checks and PR/linear/no-force settings | RD-01 R5 |

## Test Categories

### Specification tests (written before implementation)

| Test file | ST cases | Component |
|---|---|---|
| `packages/core/tests/ids.spec.test.ts` | ST-1, ST-2 | Domain guards |
| `packages/api-contract/tests/names.spec.test.ts` | ST-3–ST-6 | Schemas |
| `packages/test-support/tests/sentinels.spec.test.ts` | sentinel exports | Test support |
| `apps/server/tests/integration/migrations.spec.test.ts` | ST-7–ST-9, ST-18, ST-19, ST-36–ST-38 | Codegen integration |
| `apps/server/tests/integration/schema.spec.test.ts` | ST-20–ST-35 | Schema |
| Upstream `blendsdk/codegen` suite | ST-10–ST-17 | Library migration lifecycle |
| `tests/ci.spec.test.mjs` | ST-39, ST-40, G-3 | CI policy |
| `tests/artifacts.spec.test.mjs` | ST-41–ST-43 | Audit/artifact |
| `tests/react-single.spec.test.mjs` | ST-44 | React/Griffel |

### Implementation tests (after implementation)

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/generated-database.test.ts` | Generated row types and CType constants compile and expose expected names | High |
| `packages/core/tests/ids.impl.test.ts` | Boundary and Unicode cases | Medium |
| `tests/artifacts.impl.test.mjs` | Nested dist, symlinks, empty files, content markers | Medium |

### Integration tests

| Test | Components | Description |
|---|---|---|
| Migration matrix | Codegen + PostgreSQL 16/17 | Apply baseline + manual migration, re-apply, status, validate |
| Schema constraints | Schema + PostgreSQL | FKs, CHECKs, indexes, triggers, org seed |
| Generated types | Codegen introspection | Row types, CType constants, drift check |

### End-to-end tests

N/A in RD-01. The foundation has no user-facing flow; RD-03 and later add E2E.

## Test Data

- Sentinel value: `SENTINEL_DO_NOT_LEAK_7f3a`.
- Test database name ends `_test`; host local/CI; `OPENVAULT_TEST_DB=1`.
- Unique `openvault_test_<ulid>` database per run; no `DROP SCHEMA public`.
- Fixtures create one organization, one project, one user, one service identity, and no
  secret values.
- No mocks for PostgreSQL; real service in CI.

## Verification Checklist

- [ ] ST-1…ST-44 and G-1…G-5 defined with concrete expectations.
- [ ] Every ST traces to RD-01/RD-08 or a plan AR.
- [ ] Spec tests written before implementation.
- [ ] Spec tests fail before implementation (red phase).
- [ ] Spec tests pass after implementation (green phase).
- [ ] Impl tests cover edge cases and internals.
- [ ] PostgreSQL 16 and 17 pass.
- [ ] `pnpm verify` passes.
- [ ] No real secrets in fixtures.

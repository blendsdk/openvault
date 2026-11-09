# Preflight Report: Secret Rotation Workflow Plan

> **Status**: ✅ PREFLIGHT PASSED — 16 findings resolved, 0 accepted risks
> **Iteration**: 2 (re-scan after fixes)
> **Artifact**: Implementation plan at `codeops/features/secret-rotation/plans/rd-01-secret-rotation/`
> **Target hash (iteration 1)**: `1532e64289c1e8fe4b182a31c92c259d360e79b2f7bb329a1b03656e1d0bf964`
> **Target hash (iteration 2, plan docs excluding this report)**: `c0d0d3f318bf84701554a8038de90b3e6518e5bc57fb12762662330a6d83ebfb`
> **Codebase Grounded**: 31 source, test, migration, and documentation files examined; 42 references verified
> **Last Updated**: 2026-11-09
> **Authority**: Auto-design active — eligible technical resolutions delegated and recorded; no product, scope, security-policy, release, or commit decision was delegated.

SAME-SESSION REVIEW: This artifact was created in the current session. Same-agent bias risk is elevated.
The audit therefore re-checked every load-bearing code claim against the repository, including the migration,
test-runner, scheduler, consumer-summary, and web-upload paths. Consider a fresh-session audit before a
high-risk release if independent assurance is required.

## Codebase Context Summary

**Tech Stack:** TypeScript workspace on pnpm; WebAFX server with PostgreSQL; Zod API contract;
generated CLI and browser clients; React/Fluent UI web app; Vitest unit, root, and PostgreSQL integration
suites; BlendSDK schema-diff migrations.

**Architecture:** The server composes runtimes in `apps/server/src/app.ts`; the secret runtime is built in
`apps/server/src/secrets/runtime.ts`. Secrets have immutable versions and a current-version pointer.
Certificate expiry provides the durable notification, claim lease, audit, and signed webhook pattern.
The desired schema is `apps/server/src/database/schema.ts`; the applied DDL is generated into
`apps/server/migrations/` with `schema.snapshot.json`, and integration tests create databases from those
migrations. The web UI uses generated clients through `FakeVault`; the CLI uses the generated client and
`writeOutputFile`.

**Key Files Examined:** `packages/api-contract/src/secrets.ts`, `packages/api-contract/src/actions.ts`,
`apps/server/src/database/schema.ts`, `apps/server/src/secrets/{service,repository,runtime}.ts`,
`apps/server/src/certificates/expiry/{repository,service,scheduler,webhook}.ts`,
`apps/server/src/{app.ts,audit/actions.ts,purge/vault-purger.ts,ops/database-dump.ts}`,
`apps/server/src/config/{loader,types}.ts`, `apps/server/blendsdk.migrations.ts`,
`apps/server/migrations/*`, `apps/server/tests/integration/{migrations,schema,roles}.spec.test.ts`,
`apps/server/tests/integration/security/auth-boundary.spec.test.ts`,
`apps/server/tests/integration/helpers/purger.ts`, `apps/web/src/{App.tsx,docs.ts}`,
`apps/web/src/pages/*`, `apps/web/src/join/../generated/client.secrets.ts`,
`apps/web/tests/helpers/fake-vault.ts`, `apps/cli/src/commands/{secret,files,index}.ts`,
`apps/cli/tests/helpers/fake-vault.ts`, `docs/guide/{rotation,web-ui}.md`, `tests/docs.spec.test.mjs`.

## Summary by Dimension

| # | Dimension | Findings | Highest Severity |
|---|-----------|----------|-----------------|
| 1 | Ambiguities | 2 | 🟠 MAJOR |
| 2 | Implicit Assumptions | 3 | 🟠 MAJOR |
| 3 | Logical Contradictions | 2 | 🟡 MINOR |
| 4 | Completeness Gaps | 4 | 🔴 CRITICAL |
| 5 | Dependency Issues | 2 | 🔴 CRITICAL |
| 6 | Feasibility Concerns | 2 | 🟠 MAJOR |
| 7 | Testability | 3 | 🟠 MAJOR |
| 8 | Security Blind Spots | 1 | 🟠 MAJOR |
| 9 | Edge Cases | 2 | 🟡 MINOR |
| 10 | Scope Creep Indicators | 0 | — |
| 11 | Ordering & Sequencing | 1 | 🔴 CRITICAL |
| 12 | Consistency | 2 | 🟡 MINOR |
| 13 | Codebase Alignment | 5 | 🔴 CRITICAL |

## Summary by Severity

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1 | resolved (PF-001) |
| MAJOR | 6 | resolved (PF-002..PF-007) |
| MINOR | 8 | resolved (PF-008..PF-015) |
| OBSERVATION | 1 | resolved (PF-016) |

---

## Findings

### PF-001: Schema changes are planned without the generated migration and schema-impact tests 🔴 CRITICAL

**Dimension:** Completeness Gaps, Dependency Issues, Ordering & Sequencing, Codebase Alignment
**Location:** `03-01-data-api.md` §Schema; `99-execution-plan.md` 1.2.1 and 2.2.1; `00-index.md` Related Files
**Codebase Evidence:** `apps/server/blendsdk.migrations.ts` declares `schema: "./src/database/schema.ts"` and
`migrationsDir: "./migrations"`. `apps/server/migrations/` contains the applied DDL plus
`schema.snapshot.json`. `apps/server/tests/integration/migrations.spec.test.ts:111,117,121,136` expects
exactly 14 migrations, 26 public tables, and 14 ledger rows. `apps/server/tests/integration/schema.spec.test.ts:75-107`
asserts the exact table inventory and a foreign-key count of 27.
`apps/server/tests/integration/roles.spec.test.ts` and
`apps/server/tests/integration/security/auth-boundary.spec.test.ts:211-219` assert role grants and the
five-column consumer view. `apps/server/tests/integration/helpers/purger.ts` grants the purge role.

**The Problem:** `schema.ts` is the desired-state model, not the migration runner. `runMigrations` applies
the files in `apps/server/migrations/`; it does not diff or generate them. Editing only `schema.ts` leaves
existing databases without the column or table, and every integration database is created from the
migration files. The new tests would fail with missing relation/column errors. The plan also omits the
required migration ledger, schema inventory, foreign-key, role-grant, view-column, and purge-helper test
updates. This is a hard execution blocker.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add a Phase 1 task that runs the existing `generateMigration` API against `apps/server/blendsdk.migrations.ts`, commits the generated migration and snapshot, and updates the migration/schema/role/auth-boundary/purger-helper tests | Uses the project's reviewed migration mechanism; proves the DDL; keeps the ledger valid | One extra task and generator run |
| B | Hand-write the migration SQL and snapshot entries | No generator knowledge needed | Snapshot/lineage errors; generator validation rejects mismatched hashes; high risk |
| C | Leave the plan as written and rely on `schema.ts` only | No extra work | Feature cannot run; integration tests fail; production schema never changes |

**Recommendation:** Option A — the only option that applies the schema through the repository's actual
migration pipeline and keeps the schema/role tests truthful.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: persistence and reversible
migration mechanism inside the approved feature. Objective: make the column, table, and view exist in every
migrated database. Evidence: the migration config, generated migrations, snapshot, and the exact-count tests
above. Rejected alternatives: hand-written SQL (lineage/snapshot risk) and `schema.ts` only (does not apply).
Strongest counterargument: a generator run adds a review step; the tests and snapshot make it auditable.
Confidence: High. Hardening: in-context challenge; the existing certificate-expiry migration proves the
pattern. Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the
repository moves to startup schema diffing or stops generating migrations.

---

### PF-002: The plan promises consumer `state`, but the existing consumer summary does not expose it 🟠 MAJOR

**Dimension:** Implicit Assumptions, Completeness Gaps, Codebase Alignment
**Location:** `03-04-web-ui.md` §Secret detail rotation card and §Table; `03-03-cli.md` §status;
`02-current-state.md` "Agent consumers expose ... state"; RD-01 §Web UI
**Codebase Evidence:** `packages/api-contract/src/secrets.ts:52-56` defines `secretConsumerSummarySchema`
with only `composeProject`, `composeService`, and `lastSeen`.
`apps/server/src/database/schema.ts:713-730` defines the definer view
`secret_consumer_summaries` with exactly five columns and no `state`.
`apps/server/src/secrets/repository.ts:695-725` maps only those three public fields.
`apps/server/src/secrets/service.ts:1319` maps the same three fields. The `consumers` table does store
`state`, and `apps/web/src/pages/consumers-page.tsx` reads it through a different identity endpoint.

**The Problem:** The plan and RD-01 say the rotation card and CLI show consumer `state`, but the secret
consumer summary cannot supply it. The plan claims to "reuse the existing summary", which is false.
An executor would either show no state (silent scope reduction) or add an unplanned contract/view change
late in the web phase.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Extend the view, contract, repository, service, detail card, CLI, fixtures, and migration to include `state` | Delivers the approved visibility; additive and backwards compatible | Touches the view and generated contract |
| B | Drop `state` and show only project/service/`lastSeen` | Smaller | Contradicts RD-01 and the approved consumer visibility |

**Recommendation:** Option A — `state` is explicitly part of the approved behavior, and the data already
exists in `consumers.state`; exposing it is a small additive change.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: additive data shape inside the
approved consumer-visibility scope. Objective: show the state the requirement names. Evidence: the schema,
view, repository, service, contract, and the existing consumers page. Rejected alternative: dropping state
(violates the governing requirement). Strongest counterargument: exposing consumer state through the data
plane view widens a read surface; it is already authorized for the same consumers and is display-only.
Confidence: High. Hardening: security review of the definer view; add a role-boundary test. Policy version:
1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: consumer state becomes
control-plane-only or the view is re-scoped.

---

### PF-003: The phase and final verification gates do not run the integration tests that contain the new behavior 🟠 MAJOR

**Dimension:** Testability, Feasibility Concerns
**Location:** `99-execution-plan.md` Phase 1/2 `Verify` lines, Success Criteria 3; `07-testing-strategy.md`
**Codebase Evidence:** `apps/server/vitest.config.ts` excludes `tests/integration/**`.
`apps/server/vitest.integration.config.ts` includes them. `apps/server/package.json` defines
`test` (unit only) and `test:integration` separately. Root `package.json` `verify` runs `pnpm test`
(unit + root) but not `test:integration`. `.github/workflows/ci.yml` sets `OPENVAULT_TEST_DB=1` and runs
`pnpm test:integration` as a separate step.

**The Problem:** All new server tests are placed under `apps/server/tests/integration/secrets/`.
The Phase 1 and Phase 2 `Verify` commands use `pnpm --filter @openvault/server test`, which does not run
those files. The final `pnpm verify` also does not run them. The plan could report a green gate while the
rotation policy, list, scheduler, webhook, purge, and migration tests never executed.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=... pnpm test:integration` (or a scoped integration command) to Phase 1/2 verification and the final gate | Runs the actual behavior; matches CI | Requires a local test database |
| B | Move the tests to the unit suite | No database | Cannot exercise PostgreSQL filters, claims, purge, or migrations |
| C | Rely on CI only | No local setup | The executing agent cannot prove the task |

**Recommendation:** Option A — the new behavior is database-bound; the gate must run the integration suite.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: testing strategy and
implementation sequencing. Objective: prove each phase before commit. Evidence: the two Vitest configs and
the root verify script. Rejected alternatives: unit-only (impossible for SQL/claims) and CI-only (no local
evidence). Strongest counterargument: the local environment may not have PostgreSQL; the plan already
documents the test-database guard and CI fallback. Confidence: High. Hardening: run the migration test and a
scoped rotation integration file during execution. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the project merges integration tests into `verify`.

---

### PF-004: The notification claim does not lock the secret/project rows, has no foreign keys, and has no keyset cursor 🟠 MAJOR

**Dimension:** Security Blind Spots, Edge Cases, Codebase Alignment
**Location:** `03-02-notifications.md` §Notification table, §Claim and delivery, §Error Handling
**Codebase Evidence:** `apps/server/src/certificates/expiry/repository.ts:160-200` locks the certificate and
project rows with `FOR SHARE OF c, p` before inserting a claim, because a concurrent delete or renewal can
otherwise commit between the eligibility check and the claim. `apps/server/src/certificate/expiry` is the
stated pattern. `apps/server/src/certificates/expiry/repository.ts:92-111` uses a keyset cursor.
`apps/server/src/purge/vault-purger.ts:190-235` deletes notification rows, then versions, then the parent
inside one transaction. The plan's table has no foreign keys, and the claim steps say only "re-check
eligibility in the same transaction".

**The Problem:** A re-check without a row lock does not stop a purge from deleting the secret after the
check. Without a foreign key, the scan can insert an orphan notification row and later deliver a warning for
a deleted secret. Without a keyset cursor on the computed due date, a batched scan can skip or duplicate
rows when data changes between pages. The certificate pattern exists specifically to prevent these races.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Mirror the certificate pattern: `FOR SHARE` on the secret and project, two foreign keys with `ON DELETE CASCADE`, a unique audit-event id, and a keyset cursor on `(dueAt, secretId)` | Proven concurrency and lifecycle behavior; no orphan rows | A little more SQL and two schema constraints |
| B | Add only the foreign keys and rely on the purge delete | Closes orphans | The race can still deliver a warning after purge |
| C | Add only the lock and keep no foreign keys | Narrows the race | A crash or non-purge delete can orphan rows; inconsistent with the pattern |

**Recommendation:** Option A — the plan explicitly mirrors certificate expiry; this is the same race class.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: concurrency, consistency, and
persistence mechanisms inside the approved notification feature. Objective: at-most-once, non-orphan
warnings. Evidence: the certificate repository locks and keyset, the purger transaction, and the new table
definition. Rejected alternatives: locks only (orphans) and foreign keys only (stale delivery race).
Strongest counterargument: added constraints slow purge; cascade plus the existing delete is cheap.
Confidence: High. Hardening: scheduler concurrency test with a concurrent delete. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the purge or version-delete path changes.

---

### PF-005: The scheduler startup condition misstates the existing lifecycle 🟠 MAJOR

**Dimension:** Implicit Assumptions, Codebase Alignment
**Location:** `03-02-notifications.md` §Scheduler wiring; `99-execution-plan.md` 2.2.7
**Codebase Evidence:** `apps/server/src/app.ts:542-544` starts `certificateExpiryScheduler` when
`dependencies.disableBackgroundJobs !== true`. There is no migration or role check. The scheduler is also
registered as a singleton with a `stop()` disposer at `app.ts:418-427`.

**The Problem:** The plan says "Start it only when the server has a migration/role configuration that
permits it; mirror the existing scheduler lifecycle." The existing lifecycle has no such condition. An
executor could invent a gate that prevents the rotation scan from ever running, or add configuration that
does not exist.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Start the rotation scheduler under the same `disableBackgroundJobs !== true` condition and register the same disposer | Mirrors the verified lifecycle | None |
| B | Add a new migration/role permission gate | Theoretically safer | New behavior and surface not in the requirements; can silently disable the feature |
| C | Start it unconditionally | Simple | Runs during tests and one-shot jobs; breaks the existing test isolation |

**Recommendation:** Option A — use the actual condition; do not add a new gate.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: internal wiring and failure
behavior. Objective: run the scan in production and stay disabled in test/one-shot contexts. Evidence:
`app.ts:542-544` and the disposer registration. Rejected alternatives: a new gate (unapproved surface) and
unconditional start (breaks tests). Strongest counterargument: a role-aware gate could avoid useless work on
read-only replicas; this product has no such deployment mode. Confidence: High. Hardening: scheduler test
asserts no start when `disableBackgroundJobs` is true. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the app gains a background-job role mode.

---

### PF-006: The list filter uses the database clock while the response uses the injected service clock 🟠 MAJOR

**Dimension:** Consistency, Testability, Logical Contradictions
**Location:** `03-01-data-api.md` §Repository and §Status computation; `07-testing-strategy.md` ST-3/ST-5/ST-6
**Codebase Evidence:** `apps/server/src/secrets/service.ts` uses `this.#now()` for metadata and version
expiry. The certificate repository accepts an explicit `now` parameter and binds `:now`
(`apps/server/src/certificates/expiry/repository.ts:92-150`). The plan's rotation SQL uses `now()` while the
service uses `this.#now()`, then says "the service uses the same injected clock".

**The Problem:** The database and the service can disagree at the warning and due boundaries, so a row can
be returned by `rotation=due` with `rotationStatus="ok"` or excluded while the metadata says `due_soon`.
Tests with an injected clock cannot control the SQL predicate, making the boundary cases nondeterministic.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Pass one `now` value from the service into the repository and bind `:now` in the filter | One clock; deterministic boundary tests; matches the certificate pattern | One extra parameter |
| B | Use the database clock for both | Consistent in production | Tests cannot inject the boundary; the service would need to read the DB time |
| C | Keep both clocks | No code change | Inconsistent status/filter at the boundary |

**Recommendation:** Option A — the service clock is the product clock; the filter must use it.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: consistency and testing
mechanism. Objective: one status definition for response and filter. Evidence: `SecretService.#now()` and
the certificate `now` parameter. Rejected alternatives: DB clock for both (untestable) and mixed clocks
(inconsistent). Strongest counterargument: the DB clock is authoritative for timestamps; the service clock
is already authoritative for expiry and metadata, so using it is consistent. Confidence: High. Hardening:
boundary tests pass a fixed `now`. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the service stops accepting an injected clock.

---

### PF-007: The generated-value file flow has no failure ordering and omits `--force` 🟠 MAJOR

**Dimension:** Edge Cases, Security Blind Spots, Completeness Gaps
**Location:** `03-03-cli.md` §`rotation rotate`, §Error Handling; `99-execution-plan.md` 3.2.2
**Codebase Evidence:** `apps/cli/src/commands/files.ts:21-75` `writeOutputFile` requires an explicit
`force` option, rejects an existing file unless forced, and writes atomically. The CLI `secret get` exposes
`--force`; the plan's `rotation rotate` option table does not, while its error table says "`--out` exists
without `--force`".

**The Problem:** The plan does not say whether the file is written before or after the server rotation.
Writing after a successful rotation can lose the only copy of the new value if the file write fails.
Writing before a failed rotation can leave a value on disk that is not active. The missing `--force` option
also makes the documented error case unreachable.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Validate and write the file first; on a server-write failure, remove that file and report the failure; print the value only after success when `--out` is absent; add `--force` and tests | Never rotates without a durable copy; never leaves an inactive file by accident | Requires an explicit cleanup branch |
| B | Rotate first, then write the file | The server value exists | A file failure loses the credential |
| C | Write only when `--force` is present | Simple | Ignores the normal `--out` use case |

**Recommendation:** Option A — write-ahead is the only order that guarantees the generated credential is
recoverable after a successful rotation.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: failure/recovery design and
security mechanism inside the approved generator. Objective: no lost or ambiguous credential. Evidence:
`writeOutputFile` semantics and the CLI `--force` precedent. Rejected alternatives: rotate-first (loss) and
force-only (does not satisfy the requirement). Strongest counterargument: a failed rotation leaves a file
that must be cleaned up; the command removes it and reports the path. Confidence: High. Hardening: failure
tests for file-write, API-write, and cleanup. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the CLI gains a transactional output helper.

---

### PF-008: The data/API specification still contains two conflicting rotation filters and self-correcting prose 🟡 MINOR

**Dimension:** Ambiguities, Logical Contradictions, Consistency
**Location:** `03-01-data-api.md:66` (`rotation?: "due" | "overdue"`), :133
(`rotation: z.enum(["due", "overdue"])`), :136-143 (the "filtering client-side? **No:**" paragraph)
**Codebase Evidence:** Not code-dependent; the governing RD-01 and AR-12/AR-19 now require
`policy | due | overdue`.
**The Problem:** An executor reading the repository section or the first enum sees only two values and
misses `policy`. The self-correcting paragraph reads like an unfinished draft and obscures the final
decision.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Replace both with `policy | due | overdue` and rewrite the paragraph as a direct decision | One unambiguous contract | None |
| B | Keep `due | overdue` and have the page request the unfiltered list | Contradicts the RD and excludes non-policy rows only client-side | Inconsistent and inefficient |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: specification consistency.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the filter set changes.

---

### PF-009: The plan omits the real secret runtime composition and makes the warning-days option mandatory 🟡 MINOR

**Dimension:** Codebase Alignment, Impact Blindness
**Location:** `03-01-data-api.md` §Status computation; `99-execution-plan.md` 1.2.5; `02-current-state.md`
file table
**Codebase Evidence:** `apps/server/src/secrets/runtime.ts:31-56` constructs `SecretService` and is called
from `app.ts:189-198`. More than ten integration test files construct `SecretService` directly.
**The Problem:** `app.ts` cannot pass a new option directly into `SecretService`; the option must flow
through `createSecretRuntime`. If `rotationWarningDays` is required, every test constructor must change.
The plan names `app.ts` but not `runtime.ts`, so an executor following the file map will hit a type error.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add `runtime.ts`, make `rotationWarningDays?: number` default 7, and pass it from `app.ts` | Minimal churn; test constructors keep working | One optional field |
| B | Make it required and update every constructor | Explicit | Unnecessary test churn |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: internal wiring and test
strategy. Evidence: `runtime.ts`, `app.ts`, and the test constructors. Rejected alternative: required option
(churn). Strongest counterargument: an optional default hides a missing production wiring; the app test
asserts the configured value is passed. Confidence: High. Hardening: in-context challenge. Policy version:
1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the runtime composition moves.

---

### PF-010: `daysUntilDue` does not define its negative-value rounding 🟡 MINOR

**Dimension:** Edge Cases, Ambiguities
**Location:** `03-02-notifications.md` §Notification table and §Scan eligibility; `07-testing-strategy.md`
ST-11/ST-12
**Codebase Evidence:** The certificate service uses `Math.ceil(remaining / DAY_MS)` but only for
non-expired certificates (`apps/server/src/certificates/expiry/service.ts:148`). Rotation must represent
overdue values as negative.
**The Problem:** `Math.ceil` returns `0` for any overdue value between 0 and one day, so the payload would
not be negative as the requirements state. The exact due instant and the -1 ms case have no expected value.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Use `0` at the due instant; `Math.ceil` for positive remaining time; `Math.floor` for negative | Honest "days" and a negative overdue value | Two branches |
| B | Use `Math.floor` always | Negative works | A due-soon value can be one day low |
| C | Use calendar dates | Human intuitive | Time-zone complexity |

**Recommendation:** Option A; pin `dueAt - 1ms`, `dueAt`, and `dueAt + 1ms` in tests.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: algorithm and edge-case
definition. Confidence: High. Hardening: boundary tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the payload switches to a duration string.

---

### PF-011: The release checklist can rewrite historical release evidence, and the docs cleanup misses the actual out-of-scope line 🟡 MINOR

**Dimension:** Consistency, Completeness Gaps
**Location:** `03-05-docs-release.md` §Release metadata ("Move every 1.1.0 label to 1.2.0") and
§`docs/guide/web-ui.md`
**Codebase Evidence:** `docs/security/release-evidence.md`, `docs/security/claims.json`, and
`docs/security/claims.md` contain historical v1.1.0 release facts. `docs/guide/web-ui.md:109` currently
says "Rotation wizards, settings, ..." in the out-of-scope list; the plan only says to remove "rotation
workflow".
**The Problem:** A literal "every 1.1.0 label" replacement falsifies the security release record and the
claims. The actual out-of-scope text is "Rotation wizards", so the planned cleanup would leave a
contradiction in the reader docs. There is also no changeset for the user-visible release, although
CONTRIBUTING requires one.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Restrict the bump to current-release labels listed in the table; preserve release evidence/claims/history; edit the "Rotation wizards" line; add a changeset | Truthful history; no docs contradiction; follows CONTRIBUTING | One extra file |
| B | Bulk-replace every 1.1.0 | Mechanically simple | Falsifies security evidence |
| C | Skip the out-of-scope edit and changeset | No extra work | Contradictory docs; missing release record |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: documentation and release
metadata mechanism within the approved v1.2.0 target. Evidence: the historical security docs, the actual
web-ui line, and CONTRIBUTING. Rejected alternatives: bulk replacement (false evidence) and skip (docs
contradiction). Strongest counterargument: a changeset may be consumed later; it is still the repository's
recorded mechanism. Confidence: High. Hardening: docs guard and `pnpm security:claims:check`. Policy version:
1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the release process stops using
changesets or the docs guard owns release labels.

---

### PF-012: The redacted configuration shape and the webhook URL parser reuse are unspecified 🟡 MINOR

**Dimension:** Ambiguities, Codebase Alignment
**Location:** `03-02-notifications.md` §Configuration; `99-execution-plan.md` 2.2.6
**Codebase Evidence:** `apps/server/src/config/types.ts:81-118` has a single `webhookConfigured` boolean for
the certificate expiry webhook and `certExpiryHour`; `apps/server/src/config/loader.ts:35-106`
`parseWebhookUrl` hardcodes `OPENVAULT_CERT_EXPIRY_WEBHOOK_URL` in every issue path.
**The Problem:** "Add the settings to the redacted configuration output" does not say which fields or how
they avoid ambiguity with the certificate webhook. Reusing `parseWebhookUrl` as written would report
errors under the certificate variable name for rotation settings.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add `rotationScanHour`, `rotationWarningDays`, and `rotationWebhookConfigured`; parameterize the parser with the environment key | Clear support output; correct error names | Small parser signature change |
| B | Reuse `webhookConfigured` for both | No type change | Ambiguous support output |
| C | Duplicate the parser | No signature change | Duplicated validation |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: configuration mechanism.
Confidence: High. Hardening: config tests assert the redacted shape and error key. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: configuration output is reorganized.

---

### PF-013: Generated database types are not in the plan 🟡 MINOR

**Dimension:** Completeness Gaps, Codebase Alignment
**Location:** `03-01-data-api.md` §Proposed changes; `99-execution-plan.md` Phase 1
**Codebase Evidence:** `apps/server/scripts/generate-db-types.ts` writes
`apps/server/src/database/generated-types.ts` and `apps/server/src/database/ctypes.ts` from a migrated
database. `CONTRIBUTING.md` says to run `pnpm db:types` and use `pnpm db:types:check` in CI. Root `verify`
does not currently include that check.
**The Problem:** A schema change without regenerated types leaves committed generated artifacts stale.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add a Phase 1 task to run `pnpm db:types` after migration and commit the generated files; run `pnpm db:types:check` in the phase verify | Keeps checked-in artifacts true | Needs a migrated local database |
| B | Skip | Less work | Stale generated files |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: persistence/generation
mechanism. Confidence: High. Hardening: `db:types:check`. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: generated types stop being committed.

---

### PF-014: The web workflow spec leaves the `?status=due` deep link, empty-state action, and consumer-state wording incomplete 🟡 MINOR

**Dimension:** Ambiguities, UX Completeness
**Location:** `03-04-web-ui.md` §RotationPage, §Secrets list badge, §RotationDialog, §Secret detail rotation card
**Codebase Evidence:** `App.tsx` has no rotation route yet; `SecretsPage` uses local filter state;
`formatTime` is null-safe; the existing consumer summary has no state (PF-002).
**The Problem:** The secrets list links to `/rotation?status=due`, but the page spec never says to initialize
its status filter from the URL, so the link can land on "All policies". The "No policies" empty state says
"Set a policy from a secret" without a link. The copy row says "only for public/manual use", which conflicts
with the generated-value copy instruction. The due computation has no null-current-version guard.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Read `status` from the URL, make the empty-state action a link, clarify the copy label, and guard a null current version | The deep link and card behave as described | Small spec additions |
| B | Leave the details to the executor | Shorter | Broken deep link and ambiguous value handling |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: presentation and navigation
mechanism inside the approved UI. Confidence: High. Hardening: route and axe tests. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the route/filter model changes.

---

### PF-015: The test strategy omits the migration/schema/role impacts and the web fake routes 🟡 MINOR

**Dimension:** Testability, Codebase Alignment
**Location:** `07-testing-strategy.md` §Test Categories; `99-execution-plan.md` Phase 4/5
**Codebase Evidence:** The web `FakeVault` handles secret GET/create/delete but not secret PATCH/PUT
(`apps/web/tests/helpers/fake-vault.ts:395-443`); the CLI fake handles PUT/PATCH
(`apps/cli/tests/helpers/fake-vault.ts:330,376`). ST-45 is assigned to `rotation-page.test.tsx` but the axe
suite lives in `apps/web/tests/accessibility.test.tsx`. The migration/schema/role/auth-boundary tests are not
listed anywhere.
**The Problem:** The web rotate and policy tests cannot reach the API until `FakeVault` supports the secret
PATCH/PUT routes. The test file map is inaccurate for the axe case, and the schema-impact tests are missing.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Add a FakeVault rotation-route task, map ST-45 to the axe suite, and list the migration/schema/role tests | Tests exercise the real client; accurate map | A little more test code |
| B | Mock page modules instead | Less fake code | Violates the existing `FakeVault` pattern |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: testing strategy. Confidence:
High. Hardening: verify the web tests actually issue PATCH/PUT. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the web tests move to a shared fixture server.

---

### PF-016: The partial index and CLI list-flag details are overstated 🔵 OBSERVATION

**Dimension:** Performance, Ambiguities
**Location:** `03-01-data-api.md` §Schema; `03-03-cli.md` §`rotation list`
**Codebase Evidence:** The partial index on `rotation_interval_days IS NOT NULL` helps the `policy` filter
and the scan's candidate set; it cannot serve the computed `created_at + interval` range. The CLI table
lists `--due` and `--overdue` but not their mutual exclusion.
**The Problem:** The plan says the index "supports the rotation scans and filters" without qualification,
which overstates the due-date filter. Two list flags can both be supplied with no defined precedence.
**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Reword the index purpose and reject `--due` with `--overdue` | Accurate and predictable | None |
| B | Leave as written | No change | Misleading performance claim and ambiguous CLI input |

**Recommendation:** Option A.

**Resolution:** Resolved — AI delegated under `--auto-design`. Eligibility: performance and CLI input
handling. Confidence: High. Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`.
Reopen triggers: a computed-expression index is added or the CLI flags change.

---

## Iteration 2: Fix verification

All 16 findings were resolved by editing the plan documents and the derived goal prompt. The fixes were
verified against the repository:

| Finding | Fix applied | Verification |
|---|---|---|
| PF-001 | Added migration generation, snapshot, and schema/migration/role/view/purge-helper test work to Phase 1 and the file map | `03-01`, `00-index`, `99` now name `apps/server/migrations/`, `schema.snapshot.json`, `migrations.spec`, `schema.spec`, `roles.spec`, `auth-boundary.spec`, and `helpers/purger.ts` |
| PF-002 | Added consumer `state` to the view, contract, repository, service, UI, CLI, fixtures, and migration | `03-01`, `03-03`, `03-04`, `02-current-state` now describe the additive state field and tests |
| PF-003 | Added integration commands to Phase 1/2 verification, the final gate, and the success criteria | `99` Verify lines and `07` checklist now run `pnpm test:integration` with the guarded test database |
| PF-004 | Added `FOR SHARE` locks, two foreign keys, unique audit-event id, and a `(dueAt, secretId)` keyset cursor | `03-02` §Notification table and §Claim now mirror the certificate repository |
| PF-005 | Replaced the invented migration/role gate with `disableBackgroundJobs !== true` | `03-02` §Scheduler wiring now cites the actual lifecycle |
| PF-006 | Passed one `now` value into the list filter and bound `:now` | `03-01` §Repository and §Status computation now use one clock |
| PF-007 | Defined write-ahead file handling, cleanup on rotation failure, value print after success, and `--force` | `03-03` §rotate and error table now match `writeOutputFile` |
| PF-008 | Replaced both filter declarations and removed the self-correcting paragraph | `03-01` now states `policy | due | overdue` once |
| PF-009 | Added `runtime.ts`, optional warning days default 7, and the test-constructor impact | `03-01`, `02`, `99` now name `runtime.ts` |
| PF-010 | Defined the days formula and boundary cases | `03-02` and `07` now state `ceil`/`floor` and pin the three instants |
| PF-011 | Restricted the release bump, preserved historical evidence, edited the actual "Rotation wizards" line; the final check found the manual release flow, so no changeset is left behind | `03-05` now separates current labels from history and names the exact line |
| PF-012 | Named the redacted fields and parameterized the URL parser | `03-02` §Configuration now specifies them |
| PF-013 | Added `pnpm db:types` and `db:types:check` to Phase 1 | `99` now includes the generated DB type files |
| PF-014 | Added URL status initialization, a linked empty-state action, clarified copy, and a null guard | `03-04` now covers the deep link and null-current-version case |
| PF-015 | Added FakeVault rotation routes, corrected the ST-45 mapping, and listed the schema tests | `07` and `99` now include them |
| PF-016 | Qualified the index purpose and added CLI flag mutual exclusion | `03-01` and `03-03` now state both |

**Iteration 2 checks:**

| Check | Result |
|---|---|
| Task count and unique ids | 85 tasks, 85 unique ids; phase counts 15/19/8/11/10/6/16 |
| Ambiguity gates | Requirements and plan registers both `GATE PASSED` |
| Internal links | All plan links resolve |
| AR/PAR references | No undefined references |
| Acceptance criteria | 22 criteria present |
| Root tests | `pnpm test:root` — 52 passed, 1 skipped |

**Final verdict:** ✅ PASSED — all critical and major findings are resolved; all minor findings are resolved;
no accepted risk remains. The plan is ready for execution under `exec-plan` with `--auto-design` and
`--auto-commit`.

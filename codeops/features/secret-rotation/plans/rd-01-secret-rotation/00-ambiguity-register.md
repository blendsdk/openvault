# Plan Ambiguity Register: Secret Rotation Workflow

> **Status**: ✅ GATE PASSED — 28 inherited + 20 plan-local items resolved
> **Last Updated**: 2026-11-09 09:54
> **Parent**: [Plan Index](00-index.md)
> **Requirements register**: [../../requirements/00-ambiguity-register.md](../../requirements/00-ambiguity-register.md)
> **Policy version**: 1
> **Root invocation ID**: `secret-rotation-2026-11-09T09:54Z`
> **Authority mode**: `--auto-design` for eligible technical decisions; product, scope, security-policy,
> release, and commit-mode decisions remain user-owned.

## Inherited decisions

All product, scope, security-policy, and release decisions in `AR-01` through `AR-28` were resolved
in the requirements register. They are not re-confirmed here. The rows below are plan-local
implementation decisions.

## Register

| # | Category | Ambiguity / Gap | Options | Resolution | Status |
|---|----------|-----------------|---------|------------|--------|
| PAR-01 | Technical | Which command proves the plan | `pnpm verify` / package suites / manual | **Project fact** — `package.json` defines `verify` as the full gate; phase checks use narrower commands. | ✅ Resolved |
| PAR-02 | Technical | How the interval column and secret rows are modeled | New column + repository mapping / separate policy table | **AI delegated** — one nullable `rotation_interval_days` column on `secrets`; add it to `SECRET_COLUMNS`, `SecretRow`, `SecretRecord`, and `toSecret`. | ✅ Resolved |
| PAR-03 | Technical | How status and list filters are computed | SQL only / service only / mixed | **AI delegated** — repository filters due/overdue with SQL; service computes the response status from the loaded current version and the configured warning window. | ✅ Resolved |
| PAR-04 | Technical | How the daily scan is structured | Mirror certificate expiry / generic scheduler / no durable table | **AI delegated** — mirror the certificate-expiry repository/service/scheduler/webhook with a dedicated `secret_rotation_notifications` table and claim lease. | ✅ Resolved |
| PAR-05 | Security | How the webhook is protected | Reuse expiry webhook / new transport / unsigned | **AI delegated** — reuse the certificate-expiry URL validation, timeout, timestamp, and HMAC scheme; metadata-only payload. | ✅ Resolved |
| PAR-06 | Integration | How the warning is audited | New action / reuse secret.write / no audit | **AI delegated** — add `secret.rotation_warning` and an allowlist for status, days, version, webhook, and reason. | ✅ Resolved |
| PAR-07 | Integration | How the notification table joins purge, dump, and grants | Full integration / leave orphans | **AI delegated** — add the table to the purger allowlist/delete, the dump table list, and the role grants/documentation. | ✅ Resolved |
| PAR-08 | Technical | How the CLI commands and generator are built | New `rotation` group / extend `secret` / no CLI | **AI delegated** — add a root `ov rotation` group; reuse the generated client, `readValue`, and `writeOutputFile`; generate with `randomBytes(32).toString("base64url")`. | ✅ Resolved |
| PAR-09 | Naming | Which web files and routes own the workflow | Dedicated page + detail card / filter only / global page | **AI delegated** — `rotation-page.tsx`, `rotation-policy-dialog.tsx`, `rotation-dialog.tsx`, a detail card, and `/projects/:project/rotation`. | ✅ Resolved |
| PAR-10 | Security | How the UI handles a generated value | Show once + copy / persist / auto-submit | **AI delegated** — component state only; show once; copy button; regenerate before submit; never storage, URL, console, or logs. | ✅ Resolved |
| PAR-11 | Technical | How tests exercise the new surfaces | Extend `FakeVault` + integration harness / mocks / live server | **AI delegated** — extend `FakeVault` with rotation fields and routes; server integration tests use the real services and test database. | ✅ Resolved |
| PAR-12 | Technical | Phase ordering and red/green structure | Spec-first / implementation-first / mixed | **AI delegated** — seven phases; spec tests, red, implement, impl tests, verify. | ✅ Resolved |
| PAR-13 | Technical | Which docs change and when | Reader docs + release metadata / code comments only | **AI delegated** — update the rotation, secrets, web UI, CLI, API reference, configuration, changelog, versioning, README, and docs index; final phase moves labels to 1.2.0. | ✅ Resolved |
| PAR-14 | Technical | How the warning window and scan hour are configured | Env vars / database settings / hard-coded | **AI delegated** — four env vars validated at boot like the certificate-expiry settings. | ✅ Resolved |
| PAR-15 | Technical | How accessibility is covered | Existing axe + keyboard / visual only / no check | **AI delegated** — add the Rotation page and rotate dialog to the axe suite; labeled fields, table caption, dialog focus. | ✅ Resolved |
| PAR-16 | Technical | Whether the feature adds a support surface | Reuse stack / new library or workflow engine | **AI delegated** — reuse only; no new dependency, queue, service, or generic framework. The Complexity Escalation Gate did not fire. | ✅ Resolved |
| PAR-17 | Technical | Commit behavior during execution | Ask per task / auto-commit / no commit | **User instruction** — use `--auto-commit`: commit and push after each verified task. | ✅ Resolved |
| PAR-18 | Scope | Whether the plan tags or publishes a release | Tag in plan / hand off / no release | **User instruction and scope boundary** — the plan stops at release metadata; tagging and publication remain separate. | ✅ Resolved |
| PAR-19 | Naming | Where the feature artifacts live | New feature set / extend v1.1 / standalone | **User decision inherited from AR-1** — `codeops/features/secret-rotation/` with `requirements/` and `plans/rd-01-secret-rotation/`. | ✅ Resolved |
| PAR-20 | UX | Whether a goal prompt file is produced | Inline only / feature file / docs page | **Plan deliverable** — create `codeops/features/secret-rotation/GOAL-PROMPT.md` as a maintainer artifact, not a published docs page. | ✅ Resolved |

## Resolution Notes

**PAR-01:** `package.json` defines `verify` as the full build, typecheck, API contract, lint, tests,
artifact, compose, security, and docs gate. Package-scoped commands are used inside phases; `pnpm
verify` is the completion gate.

**PAR-02:** Authority: AI — delegated by `--auto-design`. Eligibility: persistence mechanism inside
the confirmed policy workflow. Objective: one source of truth for the interval and no duplicate
policy table. Decision: a nullable column on `secrets`; the current version's `createdAt` is the
rotation anchor. Evidence: the current version is already joined into `listActiveSecrets`
(`apps/server/src/secrets/repository.ts`). Rejected alternatives: a `secret_rotation_policies` table
(extra join for one integer); a mutable due-date column (sync risk). Strongest counterargument: a
policy table would support richer per-secret settings later; not needed now. Confidence: High.
Hardening: in-context challenge; integration tests pin the mapping. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: policies need multiple fields or
per-environment schedules.

**PAR-03:** Authority: AI — delegated by `--auto-design`. Eligibility: query and status computation
mechanism. Objective: one status definition used by the API, UI, CLI, and scan. Decision: SQL filters
due/overdue; the service computes `rotationDueAt`/`rotationStatus` from the loaded current version and
the warning window. Evidence: the list already loads current version metadata; the service builds
`secretMetadataSchema`. Rejected alternatives: compute status in the UI (divergent clocks); compute
only in SQL (the response still needs the fields). Strongest counterargument: duplicated boundary
logic; the service is the single response builder. Confidence: High. Hardening: boundary tests at
`now == dueAt` and `now == dueAt - warning`. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the status model gains more states.

**PAR-04:** Authority: AI — delegated by `--auto-design`. Eligibility: scheduler/persistence
mechanism using an existing pattern. Objective: durable, deduplicated warnings without a new queue.
Decision: mirror the certificate-expiry modules and table. Evidence:
`apps/server/src/certificates/expiry/{service,repository,scheduler,webhook}.ts`. Rejected
alternatives: a generic notification framework (premature); no durable table (duplicate sends).
Strongest counterargument: duplicated code; the payloads and thresholds differ, so a focused copy is
smaller than an abstraction. Confidence: High. Hardening: scheduler tests with an injected clock.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a third
notification workflow appears.

**PAR-05:** Authority: AI — delegated by `--auto-design`. Eligibility: security mechanism inside the
approved webhook feature. Objective: metadata-only delivery with authenticity and SSRF protection.
Decision: reuse the certificate-expiry URL rules and HMAC scheme. Evidence:
`apps/server/src/certificates/expiry/webhook.ts`. Rejected alternatives: unsigned payload; include
the value. Strongest counterargument: the operator controls the endpoint; the payload is minimal.
Confidence: High. Hardening: webhook security tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a different transport or payload is required.

**PAR-06:** Authority: AI — delegated by `--auto-design`. Eligibility: audit integration. Objective:
a filterable, value-free warning event. Decision: `secret.rotation_warning` with a detail allowlist.
Evidence: `certificate.expiry_warning` and `EXPIRY_DETAIL_KEYS` in
`apps/server/src/audit/actions.ts`. Rejected alternatives: reuse `secret.write`. Strongest
counterargument: the action catalog grows; the event is distinct. Confidence: High. Hardening: audit
tests. Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers:
the audit catalog is reorganized.

**PAR-07:** Authority: AI — delegated by `--auto-design`. Eligibility: data-lifecycle integration
required by the new table. Objective: no orphan rows and restorable backups. Decision: add the table
to the purger allowlist/delete, the dump list, and the role grants/docs. Evidence:
`vault-purger.ts`, `ops/database-dump.ts`, `deploy/postgres/grants.sql`. Rejected alternatives: leave
orphans. Strongest counterargument: more integration points; tests pin them. Confidence: High.
Hardening: purge/dump tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the dump format changes.

**PAR-08:** Authority: AI — delegated by `--auto-design`. Eligibility: CLI composition using existing
commands. Objective: discoverable policy and rotate commands. Decision: a root `ov rotation` group
with set/clear/list/status/rotate; reuse the generated client, secure file writer, and value reader.
Evidence: `apps/cli/src/commands/index.ts` and `secret.ts`. Rejected alternatives: five more `secret`
subcommands; a single rotate command. Strongest counterargument: a new root group; the workflow is a
first-class operator task. Confidence: High. Hardening: CLI tests. Policy version: 1. Root invocation
ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the CLI groups are reorganized.

**PAR-09:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation and navigation
inside the confirmed UI workflow. Objective: a visible workflow home plus an in-context detail card.
Decision: a project Rotation page, a detail rotation card, and a list badge. Evidence: the certificate
UI page/nav pattern. Rejected alternatives: a filter only; a global page. Strongest counterargument:
another project section; the workflow deserves a home. Confidence: High. Hardening: route and axe
tests. Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers:
the nav hierarchy changes.

**PAR-10:** Authority: AI — delegated by `--auto-design`. Eligibility: security mechanism inside the
approved generator. Objective: show a generated value once without persistence. Decision: component
state only; copy and regenerate; clear on close/unmount. Evidence: the existing secret reveal and
credential copy helpers. Rejected alternatives: persist until submit (storage); auto-submit
(operator cannot deliver the value). Strongest counterargument: closing loses the value; the operator
can regenerate before completing. Confidence: High. Hardening: tests assert no storage/console.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a
server-side reveal flow is required.

**PAR-11:** Authority: AI — delegated by `--auto-design`. Eligibility: testing mechanism using the
existing harness. Objective: realistic component and server coverage. Decision: extend `FakeVault`
with rotation fields and use the real services in integration tests. Evidence:
`apps/web/tests/helpers/fake-vault.ts` and the PostgreSQL integration harness. Rejected
alternatives: page mocks; live external services. Strongest counterargument: the fake can drift;
server tests cover the contract. Confidence: High. Hardening: `api:check` and integration. Policy
version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the web tests
move to a shared contract fixture.

**PAR-12:** Authority: AI — delegated by `--auto-design`. Eligibility: implementation sequencing
within the accepted spec-first standard. Objective: prove each behavior before code. Decision:
seven phases with spec tests, red, implement, impl tests, verify. Evidence:
`_shared/spec-first-ordering.md`. Rejected alternatives: implementation-first; one giant phase.
Strongest counterargument: phase handoff overhead; each phase is independently verifiable.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the execution tool changes its phase model.

**PAR-13:** Authority: AI — delegated by `--auto-design`. Eligibility: documentation changes within
the confirmed feature and release target. Objective: accurate reader docs and release labels.
Decision: update the listed pages and use the established release checklist. Evidence: the
certificate UI release flow. Rejected alternatives: no docs; internal records in reader pages.
Strongest counterargument: the version bump touches many files; the checklist is mechanical.
Confidence: High. Hardening: docs guard and `pnpm verify`. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the docs layout changes.

**PAR-14:** Authority: AI — delegated by `--auto-design`. Eligibility: configuration mechanism inside
the approved optional webhook. Objective: operator control without a database settings surface.
Decision: four validated env vars. Evidence: the certificate-expiry config block. Rejected
alternatives: database settings; hard-coded values. Strongest counterargument: more env vars; they
are optional and documented. Confidence: High. Hardening: config tests. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: configuration is centralized.

**PAR-15:** Authority: AI — delegated by `--auto-design`. Eligibility: accessibility testing using the
existing suite. Objective: keyboard and screen-reader usable screens. Decision: add the Rotation page
and dialog to the axe suite. Evidence: `apps/web/tests/accessibility.test.tsx`. Rejected
alternatives: visual only; a new framework. Strongest counterargument: axe catches a subset; manual
keyboard checks remain. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: WCAG requirements expand.

**PAR-16:** Authority: AI — delegated by `--auto-design`. Eligibility: complexity baseline. Objective:
no new support surface. Decision: reuse the stack and the certificate-expiry pattern. Evidence: the
existing scheduler/webhook and UI/test helpers. Rejected alternatives: a generic framework; a workflow
engine. Strongest counterargument: duplication; no third workflow today. Confidence: High. Hardening:
the Complexity Escalation Gate was checked and did not fire. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a new cross-cutting requirement appears.

**PAR-17:** The user explicitly requested `--auto-commit`: commit and push after each verified task.
This is an action authorization, not an auto-design decision.

**PAR-18:** The user chose v1.2.0, but publication is reserved authority. The plan stops at release
metadata and does not create a tag, publish an image, or create a GitHub release.

**PAR-19:** Inherited from AR-1. The nested layout resolves the feature folder and RD id; the plan
index declares `secret-rotation/RD-01`.

**PAR-20:** The goal prompt is a maintainer artifact so a later agent can run preflight and execute
the plan with the same guardrails.

## Gate review

- [x] All 28 requirements decisions are inherited as resolved.
- [x] All 20 plan-local rows are resolved.
- [x] Every auto-design row records eligibility, evidence, rejected alternatives, a counterargument,
  confidence, policy version, root invocation ID, and reopen triggers.
- [x] No row authorizes a material support surface; the Complexity Escalation Gate did not fire.
- [x] Commit and publication permissions are separated from design authority.

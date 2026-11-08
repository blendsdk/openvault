# Plan Ambiguity Register: Certificate UI

> **Status**: ✅ GATE PASSED — 30 inherited + 20 plan-local items resolved
> **Last Updated**: 2026-11-08 16:32
> **Parent**: [Plan Index](00-index.md)
> **Requirements register**: [../../requirements/00-ambiguity-register.md](../../requirements/00-ambiguity-register.md)
> **Policy version**: 1
> **Root invocation ID**: `certificate-ui-2026-11-08T16:32Z`
> **Authority mode**: `--auto-design` for eligible technical decisions; the user owns product,
> scope, security-policy, release, and commit-mode decisions.

## Inherited decisions

All product, scope, security-policy, and release decisions in `AR-01` through `AR-30` were resolved
in the requirements register. They are not re-confirmed here. The rows below are plan-local
implementation decisions that the RD leaves open.

## Register

| # | Category | Ambiguity / Gap | Options | Resolution | Status |
|---|----------|-----------------|---------|------------|--------|
| PAR-01 | Technical | Which command proves the plan | `pnpm verify` / package-scoped suites / manual | **Project fact** — `package.json` defines `verify` as the full gate; every phase uses it, with narrower package commands during the phase. | ✅ Resolved |
| PAR-02 | Technical | How the list status and search predicates are implemented | New repository method / branch in the existing method / service-side filter | **AI delegated** — keep one repository read method, parameterized by status; default `active`; `q` matches name or subject with the existing LIKE escaping. | ✅ Resolved |
| PAR-03 | Data & state | How the browser learns private-key and recover permissions | Extend shared flags / certificate-only fields / derive from role names | **AI delegated** — extend the shared capability flags with `canRecover` and `canReadPrivate`; map secrets to `secret.recover`/`secret.read` and certificates to `certificate.recover`/`certificate.read_private`. | ✅ Resolved |
| PAR-04 | Integration | How the browser gets typed certificate calls | Add the controller to the web contract / hand-write wrappers / reuse the CLI client | **AI delegated** — add `CertificatesController` to `WEB_CONTRACT_CONTROLLERS`, add every certificate route to `WEB_ROUTE_DOCS` through `sharedRouteDoc`, run `pnpm api:generate`, and use the generated `certificates` group. | ✅ Resolved |
| PAR-05 | Technical | How the detail page finds metadata and public material | List lookup + explicit read / direct read / new endpoint | **AI delegated** — list lookup with `status` and `q=name`; explicit public read with the selected version id; deleted items never call the public read. | ✅ Resolved |
| PAR-06 | Naming | Which files and components own the screens | One page with drawers / two pages + dialogs / new feature module | **AI delegated** — `certificates-page.tsx`, `certificate-detail-page.tsx`, `certificate-import-dialog.tsx`, `certificate-generate-dialog.tsx`, `certificate-metadata-dialog.tsx`, plus small PEM/download helpers. | ✅ Resolved |
| PAR-07 | Technical | How page state and data loading are managed | Local state + `useAsync` / global store / data library | **AI delegated** — local component state and the existing `useAsync` hook; no store or dependency. | ✅ Resolved |
| PAR-08 | Technical | How local PEM files are read and validated | FileReader helper / File.text inline / upload endpoint | **AI delegated** — one `readPemFile` helper using `FileReader`, with 256 KiB leaf/chain and 64 KiB key limits; no upload endpoint. | ✅ Resolved |
| PAR-09 | Security | How the private-key reveal clears | Timer only / timer + focus loss / persistent | **AI delegated** — 60-second timer plus region blur, window blur, route change, and unmount; download only, no clipboard. | ✅ Resolved |
| PAR-10 | UX | How API errors become user text | Raw server message / mapped codes + fallback / generic only | **AI delegated** — map version conflict, purge protection, retention active, not found, and access denied; fall back to the server message inside `ErrorAlert`; never render raw internals. | ✅ Resolved |
| PAR-11 | Technical | How component tests exercise the generated client | Extend `FakeVault` / mock page modules / live server | **AI delegated** — extend `FakeVault` with certificate routes and fixed PEM/ULID fixtures; render the real pages and generated client. | ✅ Resolved |
| PAR-12 | Technical | Phase ordering and red/green structure | Spec-first / implementation-first / mixed | **AI delegated** — seven phases; each feature phase writes spec tests, confirms red, implements, adds impl tests, then verifies. | ✅ Resolved |
| PAR-13 | Technical | Which documentation files change | Reader docs only / include internal records / no docs | **AI delegated** — update `docs/guide/web-ui.md`, `docs/guide/certificates.md`, `docs/security/known-limitations.md`, `docs/reference/api.md`, `docs/changelog.md`, `docs/guide/versioning.md`, `docs/index.md`, and `README.md`; leave internal assurance records to the release process. | ✅ Resolved |
| PAR-14 | Technical | When and how the version moves to 1.1.0 | Before feature / final phase / after release | **AI delegated** — final phase after feature verification; update package, CLI, API, image, Compose, and docs labels; do not tag or publish. | ✅ Resolved |
| PAR-15 | Technical | Which accessibility checks cover the new screens | Existing axe + keyboard / visual only / no check | **AI delegated** — add the certificate list and detail to the existing accessibility suite; keep labeled fields, table captions, and dialog focus management. | ✅ Resolved |
| PAR-16 | Technical | Whether the feature adds a support surface | Reuse stack / new library or store | **AI delegated** — reuse only; no new dependency, service, framework, state store, or infrastructure. The Complexity Escalation Gate did not fire. | ✅ Resolved |
| PAR-17 | Technical | Commit and push behavior during execution | Ask per task / auto-commit / no commit | **User instruction** — use `--auto-commit`: commit and push after each verified task. | ✅ Resolved |
| PAR-18 | Scope | Whether the plan tags or publishes a release | Tag in plan / hand off / no release | **User instruction and scope boundary** — the plan stops at release metadata; tagging and publication remain outside the execution scope. | ✅ Resolved |
| PAR-19 | Naming | Where the feature artifacts live | New feature set / extend v1.0 / standalone | **User decision inherited from AR-01** — `codeops/features/certificate-ui/` with `requirements/` and `plans/rd-01-certificate-ui/`. | ✅ Resolved |
| PAR-20 | UX | Whether a goal prompt file is produced | Inline only / feature file / docs page | **User request** — create `codeops/features/certificate-ui/GOAL-PROMPT.md` as a maintainer artifact, not a published docs page. | ✅ Resolved |

## Resolution Notes

**PAR-01:** `package.json` defines `verify` as the full build, typecheck, unit, root, artifact,
compose, security-evidence, claims, and docs gate. Package-scoped commands are used inside a phase
for faster feedback; `pnpm verify` is the completion gate. This is a project fact, not a product
decision.

**PAR-02:** Authority: AI — delegated by `--auto-design`. Eligibility: persistence and query
mechanism for the user-confirmed list/filter scope. Objective: one list path that can return active
or deleted rows and search by the identifiers operators know. Decision: keep a single repository
method, rename `listActiveCertificates` to `listCertificates`, and add a `status` parameter; apply
`deleted_at IS NULL` or `IS NOT NULL`; `q` matches `c.name` or `v.subject` with the existing
escaping. Evidence:
`apps/server/src/certificates/repository.ts:741-765` already builds the conditions and cursor.
Rejected alternatives: two repository methods (duplicated query); service-side filtering (loads
deleted rows into memory). Strongest counterargument: one method with a branch is slightly less
obvious; the branch is a single predicate and the tests pin both modes. Confidence: High. Hardening:
in-context challenge. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`.
Reopen triggers: the status model gains more than active/deleted.

**PAR-03:** Authority: AI — delegated by `--auto-design`. Eligibility: authorization-projection
mechanism within the user-approved capability policy. Objective: let the UI hide recover and
private-key actions accurately. Decision: extend the shared flags and map them per resource type.
Evidence: `apps/server/src/rbac/policy-service.ts:94-107` owns the mapping and
`packages/api-contract/src/rbac.ts:226-232` owns the shape. Rejected alternatives: derive from role
names (UI would duplicate policy); certificate-only fields (splits the concept). Strongest
counterargument: secret responses grow by two booleans; the change is additive. Confidence: High.
Hardening: contract and generated-client tests. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: a resource gains a new distinct action.

**PAR-04:** Authority: AI — delegated by `--auto-design`. Eligibility: integration mechanism using
the existing generator. Objective: typed browser calls without a second transport. Decision: add
the controller, add its route docs to `WEB_ROUTE_DOCS` through `sharedRouteDoc`, and regenerate.
Evidence: `apps/server/scripts/api-contract.ts:556-566` lists the browser controllers and explicitly
excludes certificates today; the browser document resolves every route from `WEB_ROUTE_DOCS`. Rejected alternatives: hand-written
fetch wrappers (drift); CLI client (bearer auth). Strongest counterargument: the browser contract
grows; it is generated from the same routes and checked by `api:check`. Confidence: High. Hardening:
`pnpm api:check`. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: the browser contract intentionally excludes a certificate route.

**PAR-05:** Authority: AI — delegated by `--auto-design`. Eligibility: data-flow mechanism for the
confirmed detail screen. Objective: show metadata for active, expired, and deleted items without
unnecessary audit reads. Decision: metadata from the list route; public material only on demand with
the selected version id; deleted items never read public material. Evidence:
`apps/server/src/certificates/service.ts:481-506` returns 410 for an expired current version, while
an explicit version bypasses that gate. Rejected alternatives: read on mount (audit noise); new
metadata endpoint (new surface). Strongest counterargument: the list query must find the exact name;
the `q` change in AR-12 makes that reliable. Confidence: High. Hardening: in-context challenge.
Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the
server adds a metadata-only route or removes the expiry gate.

**PAR-06:** Authority: AI — delegated by `--auto-design`. Eligibility: file and component
decomposition within existing web conventions. Objective: keep each page and dialog reviewable.
Decision: two pages, three dialogs, and small helpers. Evidence: the existing page/dialog split in
`apps/web/src/pages/`. Rejected alternatives: one monolithic page (too large); a new module tree
(unnecessary). Strongest counterargument: more files; each has one responsibility. Confidence: High.
Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the app adopts a different page composition
pattern.

**PAR-07:** Authority: AI — delegated by `--auto-design`. Eligibility: state-management mechanism;
no new dependency. Objective: reuse the established page data flow. Decision: local state and
`useAsync`. Evidence: `apps/web/src/pages/secrets-page.tsx` and `secret-detail-page.tsx`. Rejected
alternatives: global store (unneeded); data library (new dependency). Strongest counterargument: a
shared cache could reduce repeated list calls; the certificate pages are independent and the list is
small. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: cross-page caching becomes a requirement.

**PAR-08:** Authority: AI — delegated by `--auto-design`. Eligibility: input-handling mechanism
within the approved paste-or-file requirement. Objective: read local PEM without an upload service.
Decision: one `readPemFile` helper with `FileReader`, size limits, and error messages. Evidence: the
browser already reads local files for other inputs; no multipart route exists. Rejected
alternatives: `File.text` only (less compatible); upload endpoint (new surface). Strongest
counterargument: `FileReader` is callback-based; the helper wraps it in a promise. Confidence: High.
Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the product needs server-side file storage.

**PAR-09:** Authority: AI — delegated by `--auto-design`. Eligibility: security mechanism inside the
user-approved private-key policy. Objective: minimize exposure. Decision: timer plus blur/window/
route/unmount clear; download only. Evidence: the secret reveal lifecycle in
`apps/web/src/pages/secret-detail-page.tsx:60-125`. Rejected alternatives: persistent reveal;
clipboard. Strongest counterargument: download leaves a file; the operator explicitly requests it and
the read is audited. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root
invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: clipboard delivery is required.

**PAR-10:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation mechanism using
existing feedback components. Objective: consistent, safe error text. Decision: map known codes,
fall back to the server message, never render internals. Evidence: `ErrorAlert` in
`apps/web/src/components/feedback.tsx`. Rejected alternatives: raw messages (inconsistent); generic
only (loses actionable detail). Strongest counterargument: mappings drift; unknown codes still fall
back safely. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation
ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: server error codes change.

**PAR-11:** Authority: AI — delegated by `--auto-design`. Eligibility: testing strategy using the
existing harness. Objective: exercise the real generated client and page code. Decision: extend
`FakeVault` with certificate routes and fixtures. Evidence: `apps/web/tests/helpers/fake-vault.ts`
and `apps/web/tests/secrets-list.test.tsx`. Rejected alternatives: module mocks (less realistic);
live server (slow, environment-dependent). Strongest counterargument: the fake can drift from the
server; server integration tests cover the real contract. Confidence: High. Hardening: in-context
challenge. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: the web tests move to a shared contract fixture.

**PAR-12:** Authority: AI — delegated by `--auto-design`. Eligibility: implementation sequencing
within the accepted specification-first standard. Objective: prove each behavior before code.
Decision: seven phases with spec-test, red, implement, impl-test, verify. Evidence:
`_shared/spec-first-ordering.md` and the existing test suites. Rejected alternatives:
implementation-first (violates the standard); one giant phase (unreviewable). Strongest
counterargument: seven phases add handoff overhead; each phase is independently verifiable.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the execution tool changes its phase model.

**PAR-13:** Authority: AI — delegated by `--auto-design`. Eligibility: documentation changes within
the confirmed feature and release target. Objective: keep reader docs accurate without exposing
implementation records. Decision: update the listed reader pages and the API reference; leave
internal assurance records to the release process. Evidence: the current web-ui page says
certificates are out of scope (`docs/guide/web-ui.md` "Out of scope in v1.0") and the limitations
page says certificate management is CLI-only (`docs/security/known-limitations.md`). Rejected
alternatives: no docs (inaccurate); internal records (not reader-facing). Strongest counterargument:
the version bump touches many files; the plan uses the established release checklist. Confidence:
High. Hardening: docs guard and `pnpm verify`. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the docs layout changes.

**PAR-14:** Authority: AI — delegated by `--auto-design`. Eligibility: release-metadata sequencing
within the user-confirmed v1.1.0 target; no publication. Objective: align code and docs without
tagging. Decision: final phase after feature verification; use the 1.0.1 bump as the checklist; no
tag or image publish. Evidence: the 1.0.1 release flow and the current 1.0.1 labels. Rejected
alternatives: bump first (claims an unreleased version); bump after release (docs lag). Strongest
counterargument: main briefly shows 1.1.0 before the tag; this matches the repository flow.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the release process changes.

**PAR-15:** Authority: AI — delegated by `--auto-design`. Eligibility: accessibility testing using
the existing suite. Objective: keep the new screens keyboard- and screen-reader-usable. Decision:
add list and detail to the axe suite and keep the documented patterns. Evidence:
`apps/web/tests/accessibility.test.tsx` and `docs/guide/web-ui.md` §Accessibility. Rejected
alternatives: visual-only review (not testable); a new accessibility framework (unnecessary).
Strongest counterargument: axe catches a subset; manual keyboard checks remain in the phase.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: WCAG conformance requirements expand.

**PAR-16:** Authority: AI — delegated by `--auto-design`. Eligibility: complexity baseline; it
selects the smallest viable design. Objective: no new support surface. Decision: reuse the existing
stack and add no dependency, service, framework, state store, or infrastructure. Evidence:
`apps/web/package.json` already has the required UI packages; the pages use local state. Rejected
alternatives: data library, global store, new design system. Strongest counterargument: a library
could reduce boilerplate; the existing patterns are sufficient and the maintenance cost is lower.
Confidence: High. Hardening: the Complexity Escalation Gate was checked and did not fire, so no
packet is required. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`.
Reopen triggers: a new cross-cutting requirement appears.

**PAR-17:** The user explicitly requested `--auto-commit`: after each verified task, commit with a
Conventional Commit message and push the branch. This is an action authorization, not an
auto-design decision.

**PAR-18:** The user chose v1.1.0, but publication is reserved authority. The plan stops at release
metadata and does not create a tag, push a tag, publish an image, or create a GitHub release.

**PAR-19:** Inherited from AR-1. The nested layout convention resolves the feature folder and the
RD id; the plan index declares `certificate-ui/RD-01`.

**PAR-20:** The user asked for a detailed goal prompt file. It lives in the feature root so it is
versioned with the plan and is not part of the published documentation site.

## Gate review

- [x] All 30 requirements decisions are inherited as resolved.
- [x] All 20 plan-local rows are resolved.
- [x] Every auto-design row records eligibility, evidence, rejected alternatives, a counterargument,
  confidence, policy version, root invocation ID, and reopen triggers.
- [x] No row authorizes a material support surface; the Complexity Escalation Gate did not fire.
- [x] Commit and publication permissions are explicitly separated from design authority.

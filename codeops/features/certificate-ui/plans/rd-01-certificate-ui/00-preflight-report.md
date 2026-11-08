# Preflight Report: Certificate UI Plan

> **Audit target**: `codeops/features/certificate-ui/plans/rd-01-certificate-ui/`
> **Git revision**: `1e7ee119f8f3ca65600b49186d3b02facd7aeb4b`
> **Plan tree hash**: `5b25e1c07f01ebe7d9eae2febd0cd7a1bea6490e`
> **Report date**: 2026-11-08 17:06
> **Mode**: `--auto-design` (eligible technical decisions delegated; product, scope, security
> policy, release, and publication remain user-owned)
> **Verdict**: ✅ PASSED WITH NOTES — 3 minor findings resolved, 0 critical/major open

## Audit scope

**Audit target**: the complete plan set in
`codeops/features/certificate-ui/plans/rd-01-certificate-ui/` (`00-index`, both ambiguity
registers, `01-requirements`, `02-current-state`, `03-01`, `03-02`, `03-03`, `07`, `99`).

**Context documents**: `codeops/features/certificate-ui/requirements/RD-01-certificate-ui.md`,
`codeops/features/certificate-ui/requirements/00-ambiguity-register.md`, `AGENTS.md` (absent;
project conventions detected from manifests and existing code), and the repository files cited
below.

**Product scope baseline**: full certificate lifecycle in the browser, backed by the existing
API, RBAC, and audit; v1.1.0 metadata only; no tag, image publication, or GitHub release.

## Codebase context summary

| Claim | Verified evidence |
|---|---|
| Certificate API exists, browser client omits it | `apps/server/src/controllers/certificates.ts`; `apps/server/scripts/api-contract.ts:560-569` omits `CertificatesController` from `WEB_CONTRACT_CONTROLLERS`; `apps/web/src/generated/client.ts` has no `certificates` group |
| List hard-codes active rows and subject-only `q` | `apps/server/src/certificates/repository.ts:741-745` |
| List query has no `status` | `packages/api-contract/src/certificates.ts:140-165` |
| Capability flags have five fields | `packages/api-contract/src/rbac.ts:225-232`; zero returns in `apps/server/src/rbac/policy-service.ts:496-556`, `apps/server/src/certificates/service.ts:45-51`, `apps/server/src/secrets/service.ts:54-60` |
| Expired current read returns 410; explicit version bypasses | `apps/server/src/certificates/service.ts:493-505`, `813-828` |
| Web list/detail patterns and hooks exist | `apps/web/src/pages/secrets-page.tsx`, `secret-detail-page.tsx`, `apps/web/src/hooks/use-async.ts`, `apps/web/src/components/{feedback,status,data-table}.tsx` |
| Test harness exists | `apps/web/tests/helpers/{fake-vault,render}.tsx`; `apps/web/tests/accessibility.test.tsx`; PostgreSQL integration helpers under `apps/server/tests/integration/helpers/` |
| Docs claims are current | `docs/guide/web-ui.md:101-105`; `docs/security/known-limitations.md:14`; `docs/guide/certificates.md` exists |
| Docs guard | `tests/docs.spec.test.mjs` checks the 1.0.1 labels and implementation terms |

## Findings

### PF-001 — Public read omits the current version id when the version control is empty 🟡 MINOR

**Dimension**: 3 (logical contradiction) / 7 (testability).

**Evidence**: `03-01 §Public material` sent `...(version ? { version } : {})`. The server returns
410 for an expired current version only when `query.version === undefined`
(`apps/server/src/certificates/service.ts:493-505`). RD-01 AC-12 and ST-22 require the current
version id in the read.

**Resolution**: Final read always sends a concrete version id: the selected value, or
`certificate.version.id` when the control is empty. The private-key read uses the same resolved
value. `03-01` is updated. Authority: AI — delegated by `--auto-design` (implementation mechanism
inside the confirmed read behavior). Reopen trigger: the server removes the current-version
expiry gate.

### PF-002 — Phase 3 header actions depend on Phase 5 dialog components 🟡 MINOR

**Dimension**: 11 (ordering and sequencing).

**Evidence**: `99-execution-plan.md` task 3.2.1 implements the list page; task 5.2.3 wires the
Import and Generate actions. ST-15 (Phase 3) requires the actions to be present on the active
view and absent on the deleted view.

**Resolution**: Phase 3 renders the actions; Phase 5 attaches the dialogs. The final tree keeps
both actions functional. This is an intermediate commit boundary, not a final-state gap; no plan
change is needed. Authority: AI — delegated by `--auto-design` (implementation sequencing).

### PF-003 — Detail row link must preserve the list status 🟡 MINOR

**Dimension**: 12 (consistency) / 9 (edge case).

**Evidence**: `03-01 §CertificateDetailPage` says the list link includes `?status=deleted`, while
the `§CertificatesPage` table row said only "Link to the detail route".

**Resolution**: The Name column links to `${base}/${name}?status=${filters.status}`. `03-01` is
updated.

## 13-dimension scan

| Dimension | Result |
|---|---|
| 1. Ambiguities | No open material ambiguity; AR-01..AR-30 and PAR-01..PAR-20 close the product, scope, security, and technical choices. |
| 2. Implicit assumptions | Verified against the code: Zod defaults apply in the controller (`safeParse`), the generated client preserves optional defaults, `useAsync` supports an enabled flag, and the web test harness renders the real client. |
| 3. Logical contradictions | PF-001 resolved. The capability-gating table matches RD-01 and the server actions. |
| 4. Completeness gaps | Every RD-01 must-have maps to a plan section and an ST case. Docs, API reference, changelog, versioning, README, and roadmaps are covered. |
| 5. Dependency issues | No new package. PostgreSQL integration harness and the existing Docker test database are available. Internal dependencies are in the correct order. |
| 6. Feasibility | The server changes are additive; the browser uses the generated client; no migration is needed. The 25-row cursor pattern already exists. |
| 7. Testability | ST-1..ST-47 have concrete inputs and outputs; red/green phases are explicit; axe and docs guards exist. |
| 8. Security blind spots | Private key is component state only, 60-second and blur clears, download only, no clipboard/storage/URL/console. Public reads stay audited. Server authorization remains authoritative. |
| 9. Edge cases | Empty chain, expired current certificate, deleted detail, stale expected version, purge reason matrix, file size caps, SAN/validity bounds, and not-found states are specified. |
| 10. Scope creep | None. No CA, ACME, upload service, store, framework, or new dependency. |
| 11. Ordering & sequencing | Spec-first in every phase; PF-002 is an intermediate wiring boundary. |
| 12. Consistency | PF-003 resolved. Terminology, names, routes, filenames, docs paths, and release boundary are consistent. |
| 13. Codebase alignment | All cited paths and line references were checked against the current tree; no phantom references, stale assumptions, architecture mismatch, or convention violation found. |

## Remaining risks

- The capability schema change touches shared secret fixtures; the plan lists every fixture and
  the TypeScript check catches drift.
- The generated browser client grows; `pnpm api:check` is the drift gate.
- The manual review-stack E2E sequence needs a rebuilt local stack; if unavailable, the plan
  requires the limitation to be recorded and the component/integration suites used instead.

## Verdict

✅ **PASSED WITH NOTES** — 3 minor findings resolved, 0 critical/major findings, 0 reserved
decisions. Execution may proceed under `--auto-design --auto-commit`.

# Preflight Report: RD-09 Certificates

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Audit target**: all plan documents in `codeops/features/openvault-v0-1/plans/rd-09-certificates/`
> **Context**: RD-06, RD-07, RD-08, RD-09, RD-10, RD-11, RD-12, RD-13, and the repository schema, crypto, policy, audit, config, transport, and test code
> **Iterations**: 2 (design challenge + three preflight clusters, followed by a fix pass)
> **Status**: ✅ PREFLIGHT PASSED — all critical/major findings resolved; accepted residuals recorded

> **⚠️ SAME-SESSION REVIEW:** The plan and this report were produced in the same session. Independent
> correctness and security/concurrency reviews run again during execution. This report records the
> planning-stage preflight only.

## Codebase Context Summary

| Area | Verified fact |
|---|---|
| Schema | `certificates` and `certificate_versions` already exist with the chain, envelope, metadata, current-version, and lifecycle columns (`apps/server/src/database/schema.ts:344-398`). |
| Triggers | Version immutability, certificate purge by `openvault_purger` under `openvault.allow_purge`, retention, and one-way protection are already enforced (`apps/server/migrations/20261030094213_triggers-and-seed.up.sql:35-140`). |
| Crypto | The v2 envelope already binds `objectType`, project, object, and version and accepts `objectType: "certificate"` (`packages/core/src/crypto.ts:15-58`). |
| X.509 | `@peculiar/x509` 3.1.0 is a direct server dependency; `signatureOnly` is available on `X509Certificate.verify`; the library generates RSA/EC self-signed certificates (`apps/server/node_modules/@peculiar/x509/build/index.d.ts:1264-1268,1610`). |
| Policy | All seven certificate actions, object scope, `authorizeList`, `hasAny`, and certificate capabilities already exist (`apps/server/src/rbac/roles.ts:44-150`, `policy-service.ts:411-558`). |
| Audit | The chain writer, persistent adapter, action catalog, and detail allowlists are complete (`apps/server/src/audit/`). |
| Transport | The data-plane limiter is 600/min per principal and `/v1/data` has a 512 KiB body guard (`apps/server/src/secrets/rate-limits.ts:5-37`, `apps/server/src/transport/pre-stack.ts:22-24`). |
| Artifacts | `pnpm check:artifacts` rejects private-key PEM markers in `dist` (`scripts/check-artifacts.mjs:7,103-110`). |

## Design Challenger Findings

The independent challenger reviewed create-or-renew, chain storage, PKCS#8/key rules, generation,
expiry claims, private reads, lifecycle, expired reads, purge grants, and scope. Its P0/P1
objections are resolved:

| ID | Finding | Resolution |
|---|---|---|
| C-P0-1 | Pending expiry claims could never be retried after a crash or failed mark-sent | Added `claimed_at` lease, stale-pending reclaim, and a lease-aware `claim` (03-04) |
| C-P0-2 | Date-aware `verify()` rejected expired chain links; a leaf+root with a missing intermediate was rejected | `signatureOnly: true`, separate leaf date checks, issuer-name decision, drop-and-warn path (03-01/AR-8) |
| C-P1-1 | Expiry audit was not idempotent and lacked the version | Stable `audit_event_id`, allow/error dedupe, `version` detail (03-04/AR-21) |
| C-P1-2 | A delayed renewal could move the current pointer backwards | Optional `expectedVersionId` with 409 `certificate_version_conflict` (03-01/03-02/AR-2) |
| C-P1-3 | Only the 600/min limiter protected writes | 10/min import/generate limiter (03-02/AR-22) |
| C-P1-4 | Generated `notBefore` equaled `now` | Backdated by 30 seconds (03-01/AR-10) |
| C-P1-5 | `req.body.privateKeyPem` was not redacted | Added redaction paths and a sentinel test (03-02) |
| C-P1-6 | Purger guard omitted the notification owner; docs listed secrets-only grants | Five-owner guard and six-table grants (03-03) |
| C-P1-7 | Scheduler timezone, webhook URL exposure, and replay window were undefined | UTC hour, redacted URL, timestamped HMAC (03-04) |
| C-P1-8 | Missing tests for the above | Added ST cases (07) |

## Risk Cluster Findings

| PF ID | Severity | Finding | Resolution |
|---|---|---|---|
| PF-R01 | High | Purge checked lifecycle state before authorization | Authorize at project and object scope first; state 409s write one error outcome (03-03) |
| PF-R02 | High | PATCH could set protection on a concurrently deleted row | Locked-row `deleted_at IS NULL` recheck (03-03) |
| PF-R03 | Medium | Purger deleted by id without project/name predicates | Every delete matches id, project, and name with row-count checks (03-03) |
| PF-R04 | Medium | No route-by-principal denial matrix or valid agent-certificate fixture | Added ST-91 and fixture requirements (07) |
| PF-R05 | Medium | Parsing/generation ran before authorization | Project-scope pre-authorization before parse/generate (03-02) |
| PF-R06 | Medium | Private read wrote allow before decryption | Decrypt first; success writes allow, failure writes error; audit failure zeroes and returns 503 (03-02) |
| PF-R07 | Medium | Certificate names could be enumerated before authorization | `hasAny`/project pre-checks and uniform read-denial mapping (03-02/03-03) |
| PF-R08 | Medium | No cross-tenant same-name matrix | Added ST-92 (07) |
| PF-R09 | Medium | Generalized purger had no stable error contract | Added `VaultPurgerError` with `project_not_found`/`service_unavailable` (03-03) |
| PF-R10 | Medium | Five-owner guard could affect split-owner deployments | Retained the stricter guard and documented the dedicated-role requirement (03-03) |
| PF-R11 | Medium | Phase 4 omitted the RD-08 test files importing `SecretPurger` | Added both files to the Phase 4 set and task 4.2.2 (99) |
| PF-R12 | Medium | Phase 1 omitted `ctypes.ts` | Added to the Phase 1 set and generation task (99) |
| PF-R13 | Medium | PATCH was scheduled in Phase 2 before the lifecycle service | Moved PATCH to Phase 4 (99) |
| PF-R14 | Medium | Extracted metadata lengths and date invariants were not validated | Parser validates subject/issuer/serial/SAN total/date order before encryption (03-01) |
| PF-R15 | Medium | Expired/not-yet-valid intermediates passed silently | Added `expired_intermediate`/`not_yet_valid_intermediate` warnings (03-01/07) |
| PF-R16 | Medium | PKCS#8 structure and key variants were untested | DER PKCS#8 parse plus PKCS#1-body, RSA-PSS, P-384, and RSA-4096 fixtures (03-01/07) |
| PF-R17 | Medium | SAN grammar and subject syntax were untested | Typed SAN schema, shared canonicalizer, ST-9b, and subject validation (03-01/07) |
| PF-R18 | Medium | A rejected scan could stop the scheduler | `try/catch/finally` always schedules the next run (03-04) |
| PF-R19 | Medium | Webhook SSRF/redaction policy conflicted | Link-local/metadata rejection, credential/fragment rejection, URL never logged or redacted-exposed (03-04/03-03) |
| PF-R20 | Medium | `?version=` metadata ownership was ambiguous | Metadata describes the selected version; parent fields describe the certificate (03-02) |
| PF-R21 | Medium | Lifecycle audit outcomes were untested | Added ST-62a and denial/rollback assertions (07) |
| PF-R22 | Medium | Ceil-based threshold selection sent a stale 30-day warning at 14 days | Raw-millisecond threshold selection with boundary tests (03-04/07) |
| PF-R23 | Medium | Expiry audit/mark-sent transaction boundaries were undefined | Claim, audit, and mark-sent use separate short transactions; no row-lock/chain-lock cycle (03-04) |
| PF-R24 | Low | Notification cleanup test could pass via cascade alone | Added a purger grant and explicit-delete test (03-03/07) |
| PF-R25 | Low | 413 was unreachable because the contract capped first | Contract ceiling above the parser bound; HTTP 413 test (03-01/07) |
| PF-R26 | Low | No scan-to-claim race test | Added ST-82a and `FOR SHARE` locks (03-04/07) |

## Grounding Cluster Findings

| PF ID | Severity | Finding | Resolution |
|---|---|---|---|
| PF-G01 | High | `KeyObject.equals` compares different key types and would always fail | SPKI DER comparison (03-01) |
| PF-G02 | High | RSA `publicExponent` was a number array | `new Uint8Array([1,0,1])` (03-01) |
| PF-G03 | Medium | A private-key armor literal would fail `check:artifacts` | Use Node's `export({format:"pem",type:"pkcs8"})` (03-01) |
| PF-G04 | Medium | Malformed subjects could become an empty Name | `new x509.Name` plus non-empty attribute validation; ST-34 input defined (03-01) |
| PF-G05 | Medium | ST-26/27 413 was unreachable | Raised the contract ceiling; parser enforces the configured bound (03-01/07) |
| PF-G06 | Medium | Purge state checks preceded authorization | Fixed in 03-03 (see PF-R01) |
| PF-G07 | Medium | RD-08 tests importing `SecretPurger` were omitted | Added both files to Phase 4 (99) |
| PF-G08 | Medium | Migration/schema counts and inventories were not updated | Added task 1.3.3 and the test files (99) |
| PF-G09 | Medium | `db:types:check` ran before migration/without the env | All verify lines migrate first with `OPENVAULT_DB_URL` (99) |
| PF-G10 | Medium | Claim rechecked state without locking the rows | `FOR SHARE` on project and certificate before claim (03-04) |
| PF-G11 | Medium | Scheduler rejection path was undefined | Catch/finally and a rejected-run test (03-04/07) |
| PF-G12 | Low | Audit dedupe ignored the prior result | `auditEventResult`; a prior `error` gets a new event id (03-04) |
| PF-G13 | Low | Private-key DER was zeroed only after encryption | Parse/authorize/encrypt wrapped in `try/finally`; zero on every exit (03-02) |
| PF-G14 | Low | Stale citations, file lists, and index counts | Citations rebased; Related Files updated; index count corrected (00/02/03/07) |
| PF-G15 | Low | Test files and phase sets were inconsistent | Split impl tests by phase; Phase 1 test files added; PATCH moved to Phase 4 (99/07) |
| PF-G16 | Low | No read-evidence failure test | Added ST-97 (07) |

## Soundness Cluster Findings

| PF ID | Severity | Finding | Resolution |
|---|---|---|---|
| PF-S01 | CRITICAL | The create path never inserted the parent `certificates` row | Added `insertCertificate` before the version insert for a new name (03-02) |
| PF-S02 | MAJOR | No execution task created `certificates-http.spec.test.ts`; ST ranges were stale | Added Phase 3 task 3.1.2 and updated every task's ST range (99) |
| PF-S03 | MAJOR | PATCH pre-auth order was wrong; purge state 409s lacked audit outcomes | Rewrote PATCH order; one `fail` outcome per purge conflict (03-03) |
| PF-S04 | MINOR | Phase 5 set omitted `secure-application.ts` | Added to the Phase 5 set and Related Files (99/00) |
| PF-S05 | MAJOR | RD-09's UI certificate count was unowned | Added `certificateCount` to project list items, AR-35, and ST-98 (contracts/03-02/07) |
| PF-S06 | MINOR | `ExpiryRunSummary` undefined; scheduler lifecycle underspecified | Defined the summary; idempotent async start; await in-flight stop; lease retry boundary documented (03-04) |
| PF-S07 | MINOR | Repository interface lacked lock helpers and `CertificateListRow` | Added both lock helpers and the list row type (03-02) |
| PF-S08 | MINOR | Index said warning "per version" | Changed to "per current version" (00) |
| PF-S09 | MINOR | Citations, ST references, and the webhook header lagged | Rebased citations; removed undefined ST references; added the timestamp header (00/07) |
| PF-S10 | MINOR | Agent-listener status was described as uniform 401 | Documented 401 for same-project agents and 403 for project-mismatched certificates (01/03/07) |
| PF-S11 | MINOR | AC8 contradicted purge requiring a deleted certificate | Split certificate-delete and project-delete hiding rules (01) |
| PF-S12 | OBSERVATION | EC key usage was ambiguous | EC uses digitalSignature only; RSA adds keyEncipherment (03-01/07) |
| PF-S13 | MINOR | Migration generate/apply/type order and CLI location were wrong | Explicit `apps/server` command, migrate before type generation (99) |
| PF-S14 | MINOR | SAN/subject validation was not shared | Typed SAN schema, shared canonicalizer, subject schema (03-01) |
| PF-S15 | OBSERVATION | Audit dedupe could skip the success allow after an error | Same fix as PF-G12 (03-04) |

## Verdict

- **CRITICAL:** 0 open. PF-S01 fixed.
- **MAJOR:** 0 open. PF-S02, PF-S03, PF-S05 fixed.
- **MEDIUM/HIGH:** 0 open. All risk/grounding items resolved or folded into the plan.
- **Accepted residuals:** see below.
- **Pass tier:** ✅ PREFLIGHT PASSED.

## Accepted Residuals

| Risk | Owner | Revisit |
|---|---|---|
| A crash between the certificate purge delete and its outcome event can leave the deletion without evidence; the trigger requires a separate session. | RD-13 operations | If audit completeness for purge becomes a hard requirement |
| A crash after a webhook send but before mark-sent can duplicate a warning; the payload has a stable `eventId` for receiver dedupe. | RD-13 operations | If exactly-once delivery is required |
| Expired notification rows are retried on the next daily run, not immediately after the one-hour lease. | RD-13 operations | If faster retry is required |
| A protected deleted certificate reserves its name forever. | Product owner | If a rename/trash feature is requested |
| Import/generate have no `Idempotency-Key`; `expectedVersionId` is the stale-write guard. | RD-11 CLI | If retry-safe renewal becomes a CLI requirement |
| A generated or imported private key exists briefly as a PEM string that cannot be zeroed; the DER buffer is zeroed. | RD-13 security review | If a hardware-backed key mode appears |
| DNS rebinding remains possible for an operator-configured webhook URL; the URL is not user-controlled and is never logged. | RD-13 operations | If webhook targets become user-supplied |
| Certificate names are not enumerable through the data routes after the visibility pre-checks; project existence remains observable to authenticated callers. | RD-12 review | If project names become sensitive |
| No certificate consumers or versions-list route exists in v0.1. | Product owner | If RD-10/RD-12 requires them |
| The agent listener returns 401 for a same-project agent and 403 for a project-mismatched certificate; both deny all certificate data. | RD-10 | If a uniform status is required |

## Verification Evidence

- The plan's `99-execution-plan.md` has 74 tasks across six phases, with specification tests before
  implementation in each phase.
- Every RD-09 acceptance criterion maps to at least one ST case; the mapping is in
  [07-testing-strategy.md](07-testing-strategy.md).
- `pnpm verify`, `OPENVAULT_DB_URL=... pnpm db:migrate`, `OPENVAULT_DB_URL=... pnpm db:types:check`,
  `pnpm changeset status`, the docs build, and PostgreSQL 16/17 integration runs are the release
  gate.

# Ambiguity Register: OpenVault Certificate UI

> **Status**: ✅ GATE PASSED — all 30 items resolved
> **Last Updated**: 2026-11-08 16:32
> **Workflow**: make-requirements → make-plan (same chain)
> **Policy version**: 1
> **Root invocation ID**: `certificate-ui-2026-11-08T16:32Z`
> **Authority mode**: `--auto-design` for eligible technical decisions; product, scope, security-policy,
> and release decisions remain user-owned.

## Scope baseline

The user wants a certificate management screen in the OpenVault web UI that reaches parity with the
existing certificate API and CLI. The user confirmed full lifecycle coverage, audited private-key
access, a v1.1.0 release target, a new feature set, a deleted-certificate view, version-by-id reads,
precise private-key gating, and paste-or-file PEM input. The codebase already owns certificate
storage, validation, RBAC, audit, and CLI commands; this feature exposes them through the browser.

## Register

| # | Category | Ambiguity / Gap | Options Presented | User Decision / Delegated Resolution | Status |
|---|----------|-----------------|-------------------|--------------------------------------|--------|
| 1 | Scope | Where the feature lives and which requirement owns it | New feature set / extend v1.0 set / standalone plan outside CodeOps | User chose **new feature set**: `certificate-ui`, RD-01, nested plan under it. ID resets per feature per the layout convention. | ✅ Resolved |
| 2 | Feature gaps | How much of the certificate lifecycle the UI covers | Full CLI parity / read and create only / read-only | User chose **full lifecycle**: list, detail, import, generate, renew, tags, delete, recover, purge, public material, private key. | ✅ Resolved |
| 3 | Security policy | Whether the browser may reveal or download a private key | Include with confirmation / CLI-only | User chose **include with confirmation**, audited reveal and download. | ✅ Resolved |
| 4 | Scope | Which release carries the UI | v1.1.0 minor / v1.0.2 patch / no decision | User chose **v1.1.0 minor**. | ✅ Resolved |
| 5 | Feature gaps | Deleted certificates are invisible in the list API, so recover/purge need a route | Add status filter / recover by name / drop lifecycle from UI | User chose **add a `status=active|deleted` list filter** and a Deleted view. | ✅ Resolved |
| 6 | Integration | No certificate version-history endpoint exists | Current + view by id / current only / add history endpoint | User chose **current version plus view by version id**, matching `ov cert get --version-id`; no new history endpoint. | ✅ Resolved |
| 7 | Security policy | The UI cannot tell whether the caller may read a private key | Add `canReadPrivate` / reuse `canWrite` / always show and let the server deny | User chose **add `canReadPrivate`** computed from `certificate.read_private`. | ✅ Resolved |
| 8 | UX | How operators supply PEM material | Paste + local file picker / paste only / file picker only | User chose **paste + local file picker**; files are read in the browser and never uploaded separately. | ✅ Resolved |
| 9 | Scope | Explicit exclusions | — | User-confirmed scope excludes a new CA, ACME, public issuance, host trust-store changes, bulk operations, remote hosts, Kubernetes identity, new locales, and a new dependency. | ✅ Resolved |
| 10 | Security policy | How actions are authorized in the UI | Capability-driven / role-name checks / show everything | **Capability-driven**: metadata flags hide unavailable actions; the server remains authoritative for every request. | ✅ Resolved |
| 11 | Security policy | Audit and secret-handling boundary | — | Every public read, private-key read, import, generate, metadata change, delete, recover, and purge is audited by the existing server paths. The browser never stores PEM or keys in local storage, session storage, IndexedDB, cookies, URLs, console output, or application logs. | ✅ Resolved |
| 12 | UX / Integration | The current `q` filter searches the certificate subject only; operators know names | Name or subject / subject only / new `name` parameter | **AI delegated** — `q` matches certificate name or subject, case-insensitively; `san` stays an exact typed match; expiry bounds are unchanged. | ✅ Resolved |
| 13 | UX | How deleted certificates are presented and which actions appear | Status select / tabs / separate page | **AI delegated** — a Status select in the existing filter bar defaults to Active; the Deleted view hides Import and Generate and shows Recover/Purge on the detail page. | ✅ Resolved |
| 14 | Technical | Where `canReadPrivate` and the recover capability live | Shared capability flags / certificate-only field / proxy flag | **AI delegated** — extend the shared capability flags with `canReadPrivate` and `canRecover`; secrets map them to `secret.read` and `secret.recover`; certificates map them to `certificate.read_private` and `certificate.recover`. | ✅ Resolved |
| 15 | Technical | How the detail page loads metadata and public material | List lookup + explicit read / direct read / new metadata endpoint | **AI delegated** — load metadata through the list route (`status` + `q=name`); fetch public material only on an explicit action and pass the selected version id so an expired current certificate stays inspectable. | ✅ Resolved |
| 16 | Security policy | Private-key reveal mechanics | 60s timer + blur clear / persistent / copy to clipboard | **AI delegated** — 60-second countdown, clear on region blur, window blur, route change, and unmount; download only, no clipboard write for private keys. | ✅ Resolved |
| 17 | UX | Import/generate success and warning presentation | Result panel / toast / navigate away | **AI delegated** — replace the form with a success result panel showing the new version id and warnings, with Open certificate and Close actions. | ✅ Resolved |
| 18 | Behavioral | Renewal must not overwrite a newer version by accident | Expected version on renew / no guard / always overwrite | **AI delegated** — renew from the detail page prefills the name and sends the current `expectedVersionId`; creating from the list warns that an existing name adds a new version. | ✅ Resolved |
| 19 | Behavioral | Tags and purge protection are two metadata writes with one endpoint | Combined dialog / separate dialogs / tags only | **AI delegated** — one Edit metadata dialog edits tags and the one-way purge-protection flag; protection cannot be turned off once set, matching the server's 409 rule. | ✅ Resolved |
| 20 | Behavioral | Delete, recover, and purge have different preconditions | Confirm + gate / optimistic / hide entirely | **AI delegated** — confirmations for Delete and Purge; Recover is immediate; Purge is disabled with a reason until the certificate is deleted, unprotected, and past `purgeAfter`. | ✅ Resolved |
| 21 | Non-functional | List size, pagination, and capability computation | Cursor + 25 / load all / server sort | **AI delegated** — reuse cursor pagination with a 25-row first page and Load more; capabilities are computed in one policy snapshot per page, as the existing list routes do. | ✅ Resolved |
| 22 | UX | Error, empty, loading, and expired states | Existing components / new patterns | **AI delegated** — reuse `AsyncPanel`, `EmptyState`, `ErrorAlert`, `StatusBadge`, and `Loading`; show specific text for version conflict, purge protection, retention active, not found, and access denied, and never render raw server internals. | ✅ Resolved |
| 23 | Data & state | Client-side validation and file bounds | Validate client + server / server only / trust the client | **AI delegated** — reuse the name and tag validators; add subject, SAN, and validity checks; cap PEM reads at 256 KiB for leaf/chain and 64 KiB for the key; the server remains authoritative. | ✅ Resolved |
| 24 | Integration | The generated browser client has no certificate group | Add controller / hand-write calls / reuse CLI client | **AI delegated** — add `CertificatesController` to `WEB_CONTRACT_CONTROLLERS`, regenerate the browser client, and use it from pages; no hand-written transport and no new dependency. | ✅ Resolved |
| 25 | Technical | Test strategy and specification-first ordering | Spec-first + component/integration / implementation-first / manual only | **AI delegated** — specification tests precede implementation in every phase; web tests use `FakeVault` and real generated clients; server tests cover the new list and capability behavior; docs tests guard the version and public wording. | ✅ Resolved |
| 26 | Naming | File, component, route, and docs names | Several candidates | **AI delegated** — `CertificatesPage`, `CertificateDetailPage`, `CertificateImportDialog`, `CertificateGenerateDialog`, `CertificateMetadataDialog`; routes `/projects/:project/certificates` and `/projects/:project/certificates/:name`; docs path `/guide/certificates`. | ✅ Resolved |
| 27 | Data & state | Download formats and filenames | PEM with typed names / ZIP / no download | **AI delegated** — public leaf `<name>-certificate.pem`, chain `<name>-chain.pem`, private key `<name>-<version-id>.key.pem`; the server-validated name is safe to use as a filename. | ✅ Resolved |
| 28 | Scope | Docs and release sequencing | Feature and release in one phase / docs after release / no version bump | **AI delegated** — implement and verify the feature under the current 1.0.1 labels, then run a final documentation and release-metadata phase that moves the product to 1.1.0. The plan does not tag or publish; the release workflow remains a separate, user-authorized action. | ✅ Resolved |
| 29 | Technical | Complexity baseline | Reuse existing stack / new UI library / new state store | **AI delegated** — no new dependency, service, framework, state store, or infrastructure. Reuse the existing Fluent UI and BlendSDK components, generated client, hooks, and test helpers. | ✅ Resolved |
| 30 | Non-functional | Accessibility and responsive behavior | Existing patterns / new design system | **AI delegated** — every field has a label and error; table captions, dialog focus management, keyboard operation, text-and-icon status, horizontal table scroll at 768 px, and axe coverage for the new list and detail screens. | ✅ Resolved |

## Resolution Notes

**AR-1:** The user selected "New feature set" in the planning interview. Nested layout rules reset
RD ids per feature, so this feature owns `RD-01`; the earlier v1.0 set keeps its existing ids.

**AR-2:** The user selected "Full CLI parity" and the option text enumerated list, detail, import,
generate, renew, tags, delete, recover, purge, and public chain download.

**AR-3:** The user selected "Include with confirmation" for audited private-key reveal and download.

**AR-4:** The user selected "v1.1.0 minor".

**AR-5:** The user selected "Add a status filter". The current repository query hard-codes
`c.deleted_at IS NULL` (`apps/server/src/certificates/repository.ts:741`), so a `status=deleted`
branch is required for the chosen lifecycle.

**AR-6:** The user selected "Current + view by id". The existing read route accepts a `version`
query (`packages/api-contract/src/certificates.ts:137-140`); no history endpoint is added.

**AR-7:** The user selected "Add canReadPrivate". The current capability projection has five flags
(`apps/server/src/rbac/policy-service.ts:94-107`) and omits `certificate.read_private`.

**AR-8:** The user selected "Paste + local file picker". The browser reads files locally; no upload
endpoint or multipart handling is added.

**AR-9:** Scope exclusions were presented with the feature overview and confirmed by the user's
choice of the full-parity option without additions.

**AR-10:** Existing pages already gate actions from metadata capabilities
(`apps/web/src/pages/secret-detail-page.tsx`); the certificate pages follow the same rule. The
server re-checks every action.

**AR-11:** The server already audits certificate reads, private-key reads, and lifecycle writes.
The new browser screens call those routes and do not add a second audit path.

**AR-12:** Authority: AI — delegated by `--auto-design`. Eligibility: implementation mechanism for
the user-confirmed certificate search/filter scope; it adds no product surface and removes no
result. Objective: let an operator find a certificate by the identifier they know (name) as well as
its subject. Decision: `q` matches `c.name` or `v.subject`, case-insensitively; `san` stays exact;
expiry bounds are unchanged. Evidence: `apps/server/src/certificates/repository.ts:743-745`
currently applies `q` to `v.subject` only; the list page pattern in
`apps/web/src/pages/secrets-page.tsx:44-70` shows the filter bar and query shape. Rejected
alternatives: subject-only search (misses the primary identifier); a new `name` parameter
(redundant with `q` and a larger contract). Strongest counterargument: broadening `q` changes the
meaning of an existing filter; it is additive and removes no results, and the route documentation
is updated. Confidence: High. Hardening: in-context challenge only; low blast radius, no security
or data effect. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: a need for relevance ranking, separate name/subject matching, or a dedicated name filter.

**AR-13:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation mechanism inside
the user-confirmed deleted-certificate view. Objective: make deleted certificates reachable without
turning the default list into a mixed state. Decision: a Status select defaults to Active; the
Deleted view hides Import and Generate and exposes Recover/Purge on the detail page. Evidence: the
existing filter bar is the established list control (`apps/web/src/pages/secrets-page.tsx:110-160`);
`apps/server/src/certificates/repository.ts:741` excludes deleted rows. Rejected alternatives:
tabs (a new navigation pattern for one filter); a separate route (duplicates the list page).
Strongest counterargument: hiding create actions in the Deleted view could surprise an operator;
the empty state explains that new certificates are created from the Active view. Confidence: High.
Hardening: in-context challenge only. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: operators regularly create from the Deleted
view, or a status filter is needed elsewhere.

**AR-14:** Authority: AI — delegated by `--auto-design`. Eligibility: implementation mechanism for
the user-confirmed capability-gated lifecycle; it does not change role policy. Objective: let the
UI hide private-key and recover actions accurately. Decision: add `canReadPrivate` and `canRecover`
to the shared capability flags; secrets map them to `secret.read` and `secret.recover`;
certificates map them to `certificate.read_private` and `certificate.recover`. Evidence:
`apps/server/src/rbac/policy-service.ts:94-107` owns the mapping; `packages/api-contract/src/rbac.ts:226-232`
defines the flags; `apps/server/src/rbac/roles.ts:119-135` shows the officer/reader split. Rejected
alternatives: reuse `canWrite` (couples distinct permissions); certificate-only fields (splits one
concept across two response shapes). Strongest counterargument: adding fields to a shared contract
touches secret responses; the change is additive and the values are semantically meaningful for
both resource types. Confidence: High. Hardening: in-context challenge; contract tests and
generated-client checks cover the change. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: a resource gains a distinct private-read
permission outside this mapping.

**AR-15:** Authority: AI — delegated by `--auto-design`. Eligibility: data-flow mechanism for the
confirmed detail screen. Objective: show metadata even when the current certificate is expired,
while keeping public reads explicit and audited. Decision: the detail page finds metadata through
the list route with `status` and `q=name`; public material is fetched only when the operator asks,
with the selected version id. Evidence: `apps/server/src/certificates/service.ts:481-506` returns
410 for an expired current version, while `#selectedVersion` accepts an explicit version
(`service.ts:813-822`). Rejected alternatives: read on page load (adds audit noise); a new metadata
endpoint (new API surface). Strongest counterargument: passing a version id relies on the current
version id from the list; the page has it in metadata. Confidence: High. Hardening: in-context
challenge. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: the API starts returning public material without an audit event.

**AR-16:** Authority: AI — delegated by `--auto-design`. Eligibility: security mechanism inside the
user-approved private-key policy. Objective: minimize private-key exposure in the browser. Decision:
60-second reveal, clear on focus loss, window blur, route change, and unmount; download only, no
clipboard write. Evidence: the secret reveal already uses this lifecycle
(`apps/web/src/pages/secret-detail-page.tsx:60-125`), and the server rate-limits the private-key
route. Rejected alternatives: persistent reveal (exposure); clipboard write (extra copy surface).
Strongest counterargument: download creates a file on disk; the operator explicitly asks for it and
the action is audited. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root
invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the product requires clipboard
delivery or a longer reveal window.

**AR-17:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation mechanism for
confirmed import/generate behavior. Objective: show non-fatal warnings without adding a notification
system. Decision: the dialog switches to a result panel with the new version id and warnings, plus
Open certificate and Close. Evidence: the write response already includes `warnings`
(`packages/api-contract/src/certificates.ts:116-125`); the existing UI has no toast layer.
Rejected alternatives: toast (new infrastructure); navigate immediately (loses warnings). Strongest
counterargument: a modal result is an extra click; warnings matter more than speed. Confidence:
High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: a general notification pattern is introduced.

**AR-18:** Authority: AI — delegated by `--auto-design`. Eligibility: correctness mechanism for the
confirmed renew action. Objective: prevent a stale retry from moving the current pointer backwards.
Decision: renew from detail sends `expectedVersionId`; create from list warns that an existing name
adds a version. Evidence: `packages/api-contract/src/certificates.ts:174-182` exposes
`expectedVersionId`; `apps/server/src/certificates/service.ts` returns
`certificate_version_conflict` on a stale value. Rejected alternatives: no guard (silent
regression); always block existing names (breaks the create-or-renew contract). Strongest
counterargument: the warning adds copy; it prevents an accidental overwrite. Confidence: High.
Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the server changes create-or-renew semantics.

**AR-19:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation mechanism for the
confirmed metadata actions. Objective: edit tags and one-way purge protection without a second
screen. Decision: one dialog; tags replace the map; the protection switch can be turned on but not
off when already set. Evidence: `packages/api-contract/src/certificates.ts:174-182` and
`apps/server/src/certificates/lifecycle.ts:133-143` enforce the one-way rule. Rejected alternatives:
two dialogs (more navigation); tags only (drops a supported action). Strongest counterargument: a
combined form can confuse the one-way rule; the disabled switch carries an explanatory note.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: purge protection becomes reversible.

**AR-20:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation mechanism for
the confirmed lifecycle. Objective: make destructive actions deliberate and make blocked purges
understandable. Decision: confirm Delete and Purge; Recover is immediate; Purge is disabled with a
reason until deleted, unprotected, and past `purgeAfter`. Evidence:
`apps/server/src/certificates/lifecycle.ts:312-360` enforces the three purge preconditions.
Rejected alternatives: optimistic actions (destructive); always-enabled purge (server error is a
poor explanation). Strongest counterargument: the client clock can differ from the database clock;
the server error remains the final authority. Confidence: High. Hardening: in-context challenge.
Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: a new
purge precondition or a server-provided purge eligibility flag.

**AR-21:** Authority: AI — delegated by `--auto-design`. Eligibility: performance and pagination
mechanism using existing patterns. Objective: keep the list responsive at the current object limits.
Decision: 25-row first page, cursor pagination, one capability snapshot per page. Evidence: the
secret list already uses this shape (`apps/web/src/pages/secrets-page.tsx:44-100`), and
`capabilitiesForMany` exists for list routes (`apps/server/src/rbac/policy-service.ts:518-558`).
Rejected alternatives: load all certificates (unbounded); per-row policy calls (N+1). Strongest
counterargument: 25 is smaller than the API's 100 maximum; the limit is a UI choice and Load more
is explicit. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation
ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: a project routinely holds hundreds of
certificates and the list needs server-side sorting.

**AR-22:** Authority: AI — delegated by `--auto-design`. Eligibility: UX presentation using existing
components; no new product behavior. Objective: consistent error, loading, empty, and expired
states. Decision: reuse `AsyncPanel`, `EmptyState`, `ErrorAlert`, `StatusBadge`, and `Loading`;
map version conflict, purge protection, retention active, not found, and access denied to specific
text; never render raw server internals. Evidence: those components already define the house style
(`apps/web/src/components/feedback.tsx`, `status.tsx`). Rejected alternatives: a new error layer
(unnecessary); raw API messages (inconsistent and potentially internal). Strongest counterargument:
specific mapping can drift from server codes; unknown codes fall back to the generic error. Confidence:
High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: server error codes change.

**AR-23:** Authority: AI — delegated by `--auto-design`. Eligibility: input-validation mechanism;
the server remains authoritative. Objective: catch obvious mistakes before a round trip without
duplicating the server's cryptographic validation. Decision: reuse name/tag validators; add subject,
SAN, validity, and file-size checks; cap leaf/chain at 256 KiB and key at 64 KiB. Evidence: the
shared schemas are in `packages/api-contract/src/certificates.ts`; the UI already validates names
and tags in `apps/web/src/validation.ts`. Rejected alternatives: server-only validation (slower
feedback); reimplementing certificate parsing client-side (unsafe and duplicated). Strongest
counterargument: client checks can diverge from server rules; the server rejects anything the client
misses. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: certificate import limits change.

**AR-24:** Authority: AI — delegated by `--auto-design`. Eligibility: integration mechanism for the
confirmed feature; no new dependency or transport. Objective: give the browser typed certificate
calls. Decision: add `CertificatesController` to `WEB_CONTRACT_CONTROLLERS`, regenerate the client,
and use the generated group. Evidence: the web client currently omits certificates
(`apps/server/scripts/api-contract.ts:556-566`; `apps/web/src/generated/client.ts:10-18`), while the
CLI client already has the routes. Rejected alternatives: hand-written fetch wrappers (drift); reuse
the CLI client (wrong auth model). Strongest counterargument: the browser contract grows; it is the
same controller and schema, generated from the real routes. Confidence: High. Hardening:
`pnpm api:check` and the generated-client review cover it. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the browser contract intentionally excludes a
certificate route.

**AR-25:** Authority: AI — delegated by `--auto-design`. Eligibility: testing strategy using the
existing runners and helpers. Objective: prove each accepted behavior before implementation and
guard the public docs. Decision: spec tests first in each phase; web tests through `FakeVault` and
the real generated client; server integration tests for the list/capability changes; docs tests for
the version and public wording. Evidence: existing patterns in `apps/web/tests/secrets-list.test.tsx`
and `apps/server/tests/integration/`; the docs guard is `tests/docs.spec.test.mjs`. Rejected
alternatives: implementation-first (violates the standard); manual-only (no regression safety).
Strongest counterargument: server integration tests need a database; CI already provides one.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the project changes its test runner or
integration database setup.

**AR-26:** Authority: AI — delegated by `--auto-design`. Eligibility: naming and file layout within
the existing web app conventions. Objective: keep the new surface discoverable and consistent.
Decision: `CertificatesPage`, `CertificateDetailPage`, `CertificateImportDialog`,
`CertificateGenerateDialog`, `CertificateMetadataDialog`; routes `/projects/:project/certificates`
and `/projects/:project/certificates/:name`; docs path `/guide/certificates`. Evidence: existing
page names in `apps/web/src/pages/` and section names in `apps/web/src/projects/project-route.tsx`.
Rejected alternatives: nested "data" namespace (the UI is project-first); a single page with drawers
(harder to deep-link). Strongest counterargument: five components is more files; each owns one
dialog or page and stays reviewable. Confidence: High. Hardening: in-context challenge. Policy
version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the app adopts
a different routing or naming convention.

**AR-27:** Authority: AI — delegated by `--auto-design`. Eligibility: download mechanism within the
approved private-key policy. Objective: produce files operators can use without leaking through
clipboard. Decision: PEM downloads; `<name>-certificate.pem`, `<name>-chain.pem`,
`<name>-<version-id>.key.pem`; the name is already validated by the server. Evidence: the CLI writes
PEM files for the same material (`apps/cli/src/commands/cert.ts:169-226`). Rejected alternatives:
ZIP bundle (extra dependency and ambiguity); clipboard (rejected in AR-16). Strongest
counterargument: filenames can collide on repeated downloads; the browser's normal duplicate-name
handling applies. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root
invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the product needs a bundle
export.

**AR-28:** Authority: AI — delegated by `--auto-design`. Eligibility: sequencing and documentation
within the user-confirmed v1.1.0 target. Objective: ship the feature without publishing a release as
a side effect. Decision: implement and verify under the current 1.0.1 labels; the final phase moves
the product metadata and docs to 1.1.0; the plan never tags or publishes. Evidence: the 1.0.1
release flow used a feature PR followed by a version/docs PR and a tag-driven release. Rejected
alternatives: bump before implementation (docs claim an unreleased version); bump after release
(docs lag the code). Strongest counterargument: main will briefly carry 1.1.0 labels before the tag;
this matches the repository's established release flow. Confidence: High. Hardening: in-context
challenge. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: the release process changes or the feature slips to a different version.

**AR-29:** Authority: AI — delegated by `--auto-design`. Eligibility: complexity baseline; it selects
the smallest viable implementation. Objective: deliver the feature without a new support surface.
Decision: no new dependency, service, framework, state store, queue, or infrastructure; reuse the
existing UI components, generated client, hooks, and test helpers. Evidence: `apps/web/package.json`
already carries Fluent UI and BlendSDK; the pages use local state and `useAsync`. Rejected
alternatives: a data-fetching library (new dependency); a global certificate store (unneeded for
one page pair). Strongest counterargument: a cache could reduce reads; the audit model wants
explicit reads and the list is small. Confidence: High. Hardening: the Complexity Escalation Gate
was checked and no material support surface is added, so no packet is required. Policy version: 1.
Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen triggers: the feature needs
cross-page caching, offline behavior, or a new runtime dependency.

**AR-30:** Authority: AI — delegated by `--auto-design`. Eligibility: accessibility and responsive
implementation using existing project patterns. Objective: keep the new screens usable by keyboard
and assistive technology. Decision: labeled fields, described errors, table captions, dialog focus
management, text-and-icon status, horizontal table scroll at 768 px, and axe coverage for the list
and detail screens. Evidence: the accessibility contract is documented in `docs/guide/web-ui.md` and
tested by `apps/web/tests/accessibility.test.tsx`. Rejected alternatives: a new design system
(unnecessary); visual-only checks (not testable). Strongest counterargument: axe catches only a
subset; the existing manual keyboard checks remain. Confidence: High. Hardening: in-context
challenge. Policy version: 1. Root invocation ID: `certificate-ui-2026-11-08T16:32Z`. Reopen
triggers: WCAG conformance requirements expand.

## Gate review

- [x] Every row is `✅ Resolved`; no open or silently deferred item.
- [x] Every product, scope, security-policy, and release decision has an explicit user answer.
- [x] Every delegated technical row records eligibility, evidence, rejected alternatives, a
  counterargument, confidence, policy version, root invocation ID, and reopen triggers.
- [x] No row authorizes a new dependency, service, framework, infrastructure surface, or
  cross-cutting refactor. The Complexity Escalation Gate did not fire.
- [x] Every planned artifact can trace to an `AR-*` entry.

**Specialist check:** None — the repository has no specialist briefs, and the capability-gap check
found no recurring project-specific invariant beyond the existing web, API, RBAC, and test patterns.
A dynamic packet covers this work.

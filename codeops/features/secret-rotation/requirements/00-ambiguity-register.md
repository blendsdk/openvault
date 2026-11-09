# Ambiguity Register: Secret Rotation Workflow

> **Status**: ✅ GATE PASSED — all 28 items resolved
> **Last Updated**: 2026-11-09 09:54
> **Workflow**: make-requirements → make-plan (same chain)
> **Policy version**: 1
> **Root invocation ID**: `secret-rotation-2026-11-09T09:54Z`
> **Authority mode**: `--auto-design` for eligible technical decisions; product, scope, security-policy,
> and release decisions remain user-owned.

## Scope baseline

The user wants a secret rotation workflow for OpenVault v1.2.0. A secret can carry a rotation
policy; operators see due and overdue secrets, rotate with a supplied or generated value, and the
existing agent delivery picks up the new version. Notifications are in-app plus an optional signed
webhook. Consumer visibility is metadata only; there is no version-level delivery tracking. The old
version remains readable. The workflow is available in the web UI and the CLI.

## Register

| # | Category | Ambiguity / Gap | Options Presented | User Decision / Delegated Resolution | Status |
|---|----------|-----------------|-------------------|--------------------------------------|--------|
| 1 | Scope | Where the feature lives and which requirement owns it | New feature set / extend v1.1 set / standalone plan | User chose **new feature set**: `secret-rotation`, RD-01, nested plan. | ✅ Resolved |
| 2 | Feature gaps | What the workflow does | Policy + reminders + guided rotation / automatic rotation / external provider rotation | User chose **policy + reminders + guided rotation**. No automatic value changes. | ✅ Resolved |
| 3 | Integration | How far consumer delivery is tracked | Visibility only / delivered agent versions / no consumer view | User chose **visibility only**: show consumers and `lastSeen`; the operator restarts applications. | ✅ Resolved |
| 4 | UX / Integration | How due and overdue rotations reach the operator | In-app + optional webhook / in-app only / email | User chose **in-app + optional webhook**, signed and metadata-only. | ✅ Resolved |
| 5 | Behavioral | How a new value is supplied | Manual + optional generator / manual only / server-generated only | User chose **manual + optional generator**, using the existing write path and showing the generated value once. | ✅ Resolved |
| 6 | Data & state | What happens to the old version | Keep history / retire after grace / delete immediately | User chose **keep history**. No per-version deletion in this feature. | ✅ Resolved |
| 7 | Scope | Release target and surfaces | v1.2.0 UI + CLI / UI only / CLI only | User chose **v1.2.0, UI + CLI**. | ✅ Resolved |
| 8 | Scope | Automatic or provider-specific rotation | In scope / out of scope | User confirmed **out of scope**; the workflow is operator-driven. | ✅ Resolved |
| 9 | Technical | How rotation due dates are modeled | Interval days from current version / explicit date / both | **AI delegated** — per-secret `rotationIntervalDays` (1–3650, nullable); due date is `currentVersion.createdAt + interval`; no separate mutable due-date column. | ✅ Resolved |
| 10 | Behavioral | Due-soon and overdue definitions | 7-day window / 30-day / configurable | **AI delegated** — `due_soon` when `dueAt - warningDays <= now < dueAt`; `overdue` when `now >= dueAt`; `ok` otherwise. Warning window defaults to 7 days and is configurable 1–30. | ✅ Resolved |
| 11 | Security | Which action authorizes policy and rotation | Add `secret.rotate` / reuse `secret.write` | **AI delegated** — reuse `secret.write`; no new action or role matrix. Viewing uses the existing read/list actions. | ✅ Resolved |
| 12 | Integration | How the API exposes policy and due state | New routes / extend secret metadata and list query | **AI delegated** — add `rotationIntervalDays`, `rotationDueAt`, and `rotationStatus` to secret metadata; add `rotation=policy|due|overdue` to the existing list query; policy changes use the existing PATCH route. | ✅ Resolved |
| 13 | Technical | How the optional webhook is scheduled and deduplicated | Reuse certificate expiry pattern / new generic scheduler / no scheduler | **AI delegated** — mirror the certificate-expiry pattern with a dedicated secret-rotation scan, notification table, claim lease, and daily UTC hour; do not generalize the certificate service. | ✅ Resolved |
| 14 | Security | What the webhook may contain and how it is protected | Metadata only + HMAC / include value / plain | **AI delegated** — metadata only; `X-OpenVault-Timestamp` and HMAC-SHA256 signature; HTTPS validation and SSRF protections mirror the certificate-expiry webhook; no value, key, or ciphertext. | ✅ Resolved |
| 15 | Integration | How a warning is audited | New action / reuse secret.write / no audit | **AI delegated** — add `secret.rotation_warning` to the business audit actions and a detail allowlist; the payload records status, days until due, version, webhook outcome, and no value. | ✅ Resolved |
| 16 | Naming | CLI command placement and names | New `rotation` group / `secret` subcommands / no CLI | **AI delegated** — root `ov rotation` group with `set`, `clear`, `list`, `status`, and `rotate`; it reuses the generated client. | ✅ Resolved |
| 17 | Security | Generated value format and delivery | 32-byte base64url / passphrase / UUID | **AI delegated** — 32 random bytes encoded as base64url; CLI uses Node `crypto.randomBytes`; UI uses `crypto.getRandomValues`; show once; CLI `--out` writes mode 0600; UI copy only; never store in browser storage or logs. | ✅ Resolved |
| 18 | UX | Where the workflow lives in the web UI | Dedicated project page + detail card / filter only / global page | **AI delegated** — project section `Rotation` at `/projects/:project/rotation`, a rotation card on secret detail, a status column on the secrets list, and due/overdue counts on the project overview. | ✅ Resolved |
| 19 | Data & state | List defaults and scope | Only policy secrets on the rotation page / mixed list / global | **AI delegated** — the rotation page lists only secrets with a policy; the normal secrets list shows all secrets and a rotation status when present; `rotation=policy` lists any policy, `rotation=due` includes due-soon and overdue, `rotation=overdue` only overdue. | ✅ Resolved |
| 20 | UX | How consumers appear | Name/state/lastSeen / version tracking / none | **AI delegated** — show Compose project/service, state, and `lastSeen` from the existing summary; no version claim. | ✅ Resolved |
| 21 | Integration | Purge, dump, and grants for the new notification table | Full integration / leave orphan rows | **AI delegated** — add the table to the purger allowlist and delete, the database dump table list, and the role grants/documentation. | ✅ Resolved |
| 22 | Technical | Configuration surface | Env vars / database settings / hard-coded | **AI delegated** — `OPENVAULT_ROTATION_SCAN_HOUR` (default 4), `OPENVAULT_ROTATION_WARNING_DAYS` (default 7), `OPENVAULT_ROTATION_WEBHOOK_URL`, and `OPENVAULT_ROTATION_WEBHOOK_SECRET`; validated at boot like the certificate-expiry settings. | ✅ Resolved |
| 23 | Behavioral | Webhook failure and concurrency behavior | Retry with lease / fail once / in-memory | **AI delegated** — durable claim with a one-hour lease, retry on a later scan, audit failure, and no duplicate per `(secret, version, status, dueAt)`. | ✅ Resolved |
| 24 | Compatibility | Schema and API compatibility | Additive migration / breaking change | **AI delegated** — add one nullable column and one new table; no existing route, field, or response is removed; older clients ignore the new fields. | ✅ Resolved |
| 25 | Technical | Test strategy and ordering | Spec-first / implementation-first / manual | **AI delegated** — specification tests first in every phase, server integration tests for policy/list/scheduler/webhook/audit/purge, web tests with `FakeVault`, CLI tests, and axe coverage. | ✅ Resolved |
| 26 | Scope | Documentation and release sequencing | Feature + docs + release metadata / release separately | **AI delegated** — implement and verify under the v1.1.0 labels, then a final phase moves the product metadata and reader docs to v1.2.0. The plan does not tag or publish. | ✅ Resolved |
| 27 | Technical | Complexity baseline | Reuse stack and certificate-expiry pattern / new dependency or generic scheduler | **AI delegated** — no new dependency, service, queue, or external scheduler; mirror the existing certificate-expiry pattern and reuse existing UI/test helpers. | ✅ Resolved |
| 28 | Behavioral | Does rotation reload a running application? | No, document restart / attempt reload / auto-restart | **AI delegated** — no application control; the docs and UI state that the agent fetches the new version on refresh and the application must restart or watch the file. | ✅ Resolved |

## Resolution Notes

**AR-1:** User selected "New feature set". Nested layout resets RD ids per feature, so this feature
owns `RD-01`.

**AR-2:** User selected "Policy + reminders + guided rotation". Automatic and external-provider
rotation are out of scope.

**AR-3:** User selected "Visibility only". The agent cannot prove that an application process
reloaded a value, so the workflow does not claim application-level acknowledgement.

**AR-4:** User selected "In-app + optional webhook". The existing certificate-expiry webhook is
the precedent; the secret webhook carries metadata only.

**AR-5:** User selected "Manual + optional generator". The generator produces a value locally in
the CLI or browser and submits it through the existing `PUT` route; there is no server-generated
value endpoint.

**AR-6:** User selected "Keep history". Old versions remain readable as they are today.

**AR-7:** User selected "v1.2.0, UI + CLI".

**AR-8:** User confirmed automatic and provider-specific rotation are out of scope.

**AR-9:** Authority: AI — delegated by `--auto-design`. Eligibility: data-model mechanism inside
the confirmed policy workflow. Objective: a durable due date that resets when a new version is
written. Decision: store `rotation_interval_days` on `secrets`; compute the due date from the
current version's `created_at`. Evidence: the current version is already the rotation anchor
(`secret_versions.created_at`) and is loaded with every list row. Rejected alternatives: a
mutable `rotation_due_at` column (must be kept in sync); an explicit date (less natural for
"every N days"). Strongest counterargument: changing the interval recomputes the due date from
the current version, which may make an old secret immediately overdue; that is honest and visible.
Confidence: High. Hardening: in-context challenge; integration tests pin the boundary. Policy
version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a need for
per-secret explicit schedules or a different rotation anchor.

**AR-10:** Authority: AI — delegated by `--auto-design`. Eligibility: status semantics inside the
confirmed reminder workflow. Objective: a single, testable definition for the UI and webhook.
Decision: `due_soon` in the warning window before `dueAt`; `overdue` at or after `dueAt`; `ok`
before the window; `null` when no policy. Evidence: the certificate expiry service already uses
threshold-based warnings. Rejected alternatives: only overdue (no lead time); multiple thresholds
(more notification rows for little value). Strongest counterargument: a 7-day default is arbitrary;
it is configurable. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root
invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: operators need multiple lead
times or per-secret lead times.

**AR-11:** Authority: AI — delegated by `--auto-design`. Eligibility: authorization mechanism
inside the existing RBAC model. Objective: avoid a new action and role matrix. Decision: policy
and rotation require `secret.write`; viewing requires `secret.list`/`secret.read`. Evidence:
`apps/server/src/secrets/service.ts` already authorizes writes and metadata updates with
`secret.write`. Rejected alternatives: a new `secret.rotate` action (new role matrix and tests).
Strongest counterargument: rotation is a distinct operation; it still writes a value, so
`secret.write` is the correct capability. Confidence: High. Hardening: in-context challenge.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a role
must rotate without general write access.

**AR-12:** Authority: AI — delegated by `--auto-design`. Eligibility: API shape within the
confirmed policy workflow. Objective: expose due state without a second read. Decision: add
metadata fields and a list filter; policy changes use PATCH. Evidence: `secretMetadataSchema` and
`secretListQuerySchema` already carry metadata and filters. Rejected alternatives: a new due
route (duplicates list); a separate rotation object (more joins). Strongest counterargument: the
metadata response grows; the fields are small and additive. Confidence: High. Hardening:
contract tests and `api:check`. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the UI needs a dedicated due endpoint.

**AR-13:** Authority: AI — delegated by `--auto-design`. Eligibility: scheduler and persistence
mechanism using an existing pattern. Objective: durable, deduplicated warnings without a new
queue. Decision: mirror the certificate-expiry repository/service/scheduler/webhook and add a
`secret_rotation_notifications` table. Evidence:
`apps/server/src/certificates/expiry/{service,repository,scheduler,webhook}.ts` and the
`certificate_expiry_notifications` table. Rejected alternatives: a generic notification framework
(cross-cutting refactor); no durable table (duplicate sends). Strongest counterargument: code
duplication; the two workflows have different payloads and thresholds, so a focused copy is
smaller and safer than a premature abstraction. Confidence: High. Hardening: in-context
challenge; scheduler tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a third notification workflow appears.

**AR-14:** Authority: AI — delegated by `--auto-design`. Eligibility: security mechanism inside
the approved webhook feature. Objective: deliver only public metadata and resist SSRF. Decision:
reuse the certificate-expiry URL validation, timeout, timestamp, and HMAC scheme; payload has
secret metadata only. Evidence: `apps/server/src/certificates/expiry/webhook.ts`. Rejected
alternatives: include the value (unacceptable); unsigned payload (no authenticity). Strongest
counterargument: an operator could still leak metadata through a misconfigured endpoint; the URL
is operator-controlled and the payload is minimal. Confidence: High. Hardening: security tests.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the
webhook needs additional fields or a different transport.

**AR-15:** Authority: AI — delegated by `--auto-design`. Eligibility: audit integration within the
confirmed warning feature. Objective: a queryable, value-free warning event. Decision: add
`secret.rotation_warning` to the business audit actions and a detail allowlist. Evidence: the
certificate expiry action `certificate.expiry_warning` and its `EXPIRY_DETAIL_KEYS`. Rejected
alternatives: reuse `secret.write` (confuses warnings with writes). Strongest counterargument: the
closed action catalog grows; the event is distinct and filterable. Confidence: High. Hardening:
audit tests. Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen
triggers: the audit catalog is reorganized.

**AR-16:** Authority: AI — delegated by `--auto-design`. Eligibility: CLI composition using the
existing command framework. Objective: discoverable commands that compose with the existing
client. Decision: add a root `ov rotation` group with `set`, `clear`, `list`, `status`, and
`rotate`. Evidence: `apps/cli/src/commands/index.ts` lists root groups; `secret.ts` shows the
command parser pattern. Rejected alternatives: adding five commands to `ov secret` (crowded);
only a single rotate command (policy management missing). Strongest counterargument: a new root
group is a larger help surface; the workflow is a first-class operator task. Confidence: High.
Hardening: CLI tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the CLI groups are reorganized.

**AR-17:** Authority: AI — delegated by `--auto-design`. Eligibility: cryptographic mechanism
inside the approved optional generator. Objective: a strong, URL-safe value with clear handling.
Decision: 32 random bytes, base64url; CLI `--out` uses the existing secure file writer; without
`--out` the value is printed once; UI shows it once with copy; no storage or logs. Evidence: the
CLI already has `writeOutputFile` and the UI has `copyCredential`. Rejected alternatives: UUID
(lower entropy); server-side generation (a new endpoint and reveal flow). Strongest
counterargument: printing to stdout can leak through terminal history; the command states the
risk and supports `--out`. Confidence: High. Hardening: tests assert no logging. Policy version:
1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a server-side
generator is required.

**AR-18:** Authority: AI — delegated by `--auto-design`. Eligibility: navigation and presentation
mechanism inside the confirmed UI workflow. Objective: make the due set visible without hiding it
inside a filter. Decision: a project `Rotation` section, a detail card, a list badge, and overview
counts. Evidence: `project-route.tsx` section navigation and the certificate UI page pattern.
Rejected alternatives: a filter on Secrets only (easy to miss); a global page (cross-project scope
is not in the product model). Strongest counterargument: another section in the project nav; the
workflow deserves a dedicated home. Confidence: High. Hardening: axe and route tests. Policy
version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the nav
hierarchy changes.

**AR-19:** Authority: AI — delegated by `--auto-design`. Eligibility: list-filter mechanism.
Objective: distinguish "all policy secrets" from "needs attention". Decision: the Rotation page
lists only policy secrets; `rotation=policy` lists any policy; `rotation=due` means due-soon or
overdue; `rotation=overdue` means overdue only; the normal secrets list is unchanged and shows a
status when a policy exists.
Evidence: the existing list query and page filters. Rejected alternatives: `rotation=all` (no
useful filter); separate endpoints (duplication). Strongest counterargument: "due" including
due-soon is a slight semantic stretch; the UI labels it "Needs attention". Confidence: High.
Hardening: query tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: operators need a distinct due-soon filter.

**AR-20:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation of existing
consumer metadata. Objective: show who reads the secret without claiming application
acknowledgement. Decision: Compose project/service, state, and `lastSeen`; no version. Evidence:
`secretConsumerSummarySchema` and the secret detail consumers table. Rejected alternatives:
version tracking (rejected by AR-3). Strongest counterargument: last seen is a weak signal; it is
honest about what the product knows. Confidence: High. Hardening: in-context challenge. Policy
version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the agent
heartbeat starts reporting versions.

**AR-21:** Authority: AI — delegated by `--auto-design`. Eligibility: data-lifecycle integration
required by the new notification table. Objective: no orphan rows and a restorable backup.
Decision: add the table to the purger allowlist/delete, the dump table list, and the role grants
and docs. Evidence: `vault-purger.ts`, `ops/database-dump.ts`, `deploy/postgres/grants.sql`, and
the certificate-expiry table precedent. Rejected alternatives: leave orphan rows (purge
integrity failure). Strongest counterargument: more integration points; the tests pin them.
Confidence: High. Hardening: purge/dump tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the dump format changes.

**AR-22:** Authority: AI — delegated by `--auto-design`. Eligibility: configuration mechanism
inside the approved optional webhook. Objective: operator control without a database settings
surface. Decision: four env vars, validated at boot. Evidence: the certificate-expiry config
block in `config/loader.ts` and `docs/reference/configuration.md`. Rejected alternatives: database
settings (new UI and audit surface); hard-coded schedule (inflexible). Strongest counterargument:
more env vars; they are optional and documented. Confidence: High. Hardening: config tests.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the
configuration surface is centralized elsewhere.

**AR-23:** Authority: AI — delegated by `--auto-design`. Eligibility: failure and concurrency
mechanism using the certificate-expiry pattern. Objective: at-most-once-ish delivery without
losing retries. Decision: durable claim with a one-hour lease, retry on later scans, audit failure,
unique per `(secret, version, status, dueAt)`. Evidence: certificate expiry claim/lease logic. Rejected
alternatives: in-memory dedupe (lost on restart); at-least-once without a unique key (duplicates).
Strongest counterargument: a crash can delay a warning; the next scan recovers the claim.
Confidence: High. Hardening: scheduler tests. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the scan cadence or delivery guarantee
changes.

**AR-24:** Authority: AI — delegated by `--auto-design`. Eligibility: compatibility mechanism.
Objective: an additive schema and API change. Decision: one nullable column, one new table, new
optional response fields and query filter; no removals. Evidence: the current schema and strict
object schemas accept additive optional fields. Rejected alternatives: a breaking metadata
reshape. Strongest counterargument: strict schemas reject unknown fields on input; the new input
field is optional and validated. Confidence: High. Hardening: contract tests and integration.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a
future major version removes the fields.

**AR-25:** Authority: AI — delegated by `--auto-design`. Eligibility: testing strategy using the
existing runners. Objective: prove each behavior before implementation. Decision: spec tests first
in every phase; server integration tests for policy/list/scheduler/webhook/audit/purge; web tests
through `FakeVault`; CLI tests; docs guard. Evidence: existing `certificates` and `secrets` test
suites. Rejected alternatives: implementation-first (violates the standard); manual only.
Strongest counterargument: scheduler tests are slower; they are deterministic with an injected
clock. Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the test runner changes.

**AR-26:** Authority: AI — delegated by `--auto-design`. Eligibility: release sequencing within
the user-confirmed v1.2.0 target. Objective: docs and version metadata without publication.
Decision: implement under the current 1.1.0 labels; final phase moves packages, CLI, API, Compose,
README, and docs to 1.2.0; no tag or publish. Evidence: the 1.1.0 release flow. Rejected
alternatives: bump first (claims an unreleased version); bump after release (docs lag). Strongest
counterargument: main briefly says 1.2.0 before the tag; this matches the repository flow.
Confidence: High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the release process changes.

**AR-27:** Authority: AI — delegated by `--auto-design`. Eligibility: complexity baseline. Objective:
no new support surface. Decision: reuse the existing stack, the certificate-expiry pattern, and
the current UI/test helpers; no new dependency, service, queue, or external scheduler. Evidence:
the existing scheduler/service/webhook and Fluent UI components. Rejected alternatives: a generic
notification framework (premature abstraction); a workflow engine (unnecessary). Strongest
counterargument: a generic framework would reduce future duplication; there is no third workflow
today. Confidence: High. Hardening: the Complexity Escalation Gate was checked and did not fire.
Policy version: 1. Root invocation ID: `secret-rotation-2026-11-09T09:54Z`. Reopen triggers: a
third notification workflow appears.

**AR-28:** Authority: AI — delegated by `--auto-design`. Eligibility: presentation of the existing
delivery limitation. Objective: no false promise of application reload. Decision: the UI and docs
state that the agent fetches the new version on refresh and the application must restart or watch
the file; no application control is added. Evidence: `docs/guide/rotation.md` already says the
agent picks up the new version on the next refresh. Rejected alternatives: attempt to restart
containers (no Docker socket by design); claim delivery is complete (false). Strongest
counterargument: operators may expect seamless rotation; the limitation is explicit. Confidence:
High. Hardening: in-context challenge. Policy version: 1. Root invocation ID:
`secret-rotation-2026-11-09T09:54Z`. Reopen triggers: the agent gains an application reload hook.

## Gate review

- [x] Every row is `✅ Resolved`.
- [x] Every product, scope, security-policy, and release decision has an explicit user answer.
- [x] Every delegated technical row records eligibility, evidence, rejected alternatives, a
  counterargument, confidence, policy version, root invocation ID, and reopen triggers.
- [x] No row authorizes a new dependency, service, framework, infrastructure surface, or
  cross-cutting refactor. The Complexity Escalation Gate did not fire.
- [x] Every planned artifact can trace to an `AR-*` entry.

**Specialist check:** None — the repository has no specialist briefs; the work reuses the
certificate-expiry and secret UI/API patterns, and a dynamic packet covers it.

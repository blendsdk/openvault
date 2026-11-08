# Certificate UI Implementation Plan

> **Feature**: Full certificate management in the OpenVault web UI, backed by the existing certificate API, RBAC, and audit trail.
> **Status**: Planning Complete (preflight ready)
> **Created**: 2026-11-08 16:32
> **Implements**: certificate-ui/RD-01
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault's certificate API and CLI are complete, but the browser exposes only a certificate
count. This plan adds a Certificates section to every project with a list, a detail page, import,
generate, renew, version-by-id reads, tag and purge-protection editing, delete/recover/purge, public
material, and audited private-key reveal/download.

The work has three parts. The server gains a `status` list filter, a name-or-subject search, and two
additive capability flags (`canRecover`, `canReadPrivate`). The generated browser client gains the
existing certificate controller. The web app gains the pages, dialogs, navigation entry, and tests.
Documentation and the v1.1.0 release metadata close the plan. No certificate authority, ACME
client, new dependency, database migration, or deployment change is introduced.

## Minimum-Sufficient Baseline

**Original goal:** an operator can perform every supported certificate task in the browser with the
same permissions and audit behavior as the CLI.

**Smallest viable design:** one server list query with a status branch and a broader `q`, two
additive capability flags, one generated client group, two pages, three dialogs, and small PEM
helpers. Reuse the existing Fluent UI and BlendSDK components, `useAsync`, `FakeVault`, and the
documentation guard.

**Excluded machinery:** no new UI library, state store, data-fetching layer, notification system,
upload service, certificate authority, ACME client, queue, or infrastructure.

**Approved complexity:** None. The Complexity Escalation Gate did not fire.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Plan Ambiguity Register](00-ambiguity-register.md) | Plan-local decisions; inherits the requirements register |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements Delta](01-requirements.md) | Thin view of RD-01 and plan-local scope |
| 02 | [Current State](02-current-state.md) | Existing certificate API, generated client gap, web patterns |
| 03-01 | [Web UI](03-01-web-ui.md) | Routes, pages, dialogs, state, validation, accessibility |
| 03-02 | [Server Contract](03-02-server-contract.md) | List filter, search, capability flags, browser contract |
| 03-03 | [Docs and Release](03-03-docs-release.md) | Documentation changes, version metadata, release boundary |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Usage Examples

```text
/projects/payments/certificates
  Search: Name or subject
  Status: Active | Deleted
  Rows: api-tls | active | CN=api.payments.internal | 12 Mar 2027 (in 124 days) | env=prod

/projects/payments/certificates/api-tls
  Version: [01J... current]
  [View public certificate] [View private key] [Edit metadata] [Import new version]
```

### Key Decisions

| Decision | Outcome | Ref |
|---|---|---|
| Feature location | `codeops/features/certificate-ui/`, RD-01 | AR-1 |
| Lifecycle coverage | Full API coverage | AR-2 |
| Private key | Confirmation, 60s reveal, download only | AR-3, AR-16 |
| Deleted certificates | `status=active|deleted` list filter | AR-5 |
| Version access | Current or a known version id | AR-6 |
| Capability flags | Add `canRecover` and `canReadPrivate` | AR-7, AR-14 |
| PEM input | Paste + local file picker | AR-8 |
| Release | v1.1.0, final metadata phase, no tag | AR-4, AR-28 |
| Transport | Generated browser client | AR-24, PAR-04 |
| Complexity | Reuse only; no new dependency | AR-29, PAR-16 |

## Specialist Agents

**None** — the capability-gap check found no recurring project-specific invariant beyond the
existing web, API, RBAC, and test patterns. The repository has no specialist briefs, and a dynamic
packet covers this work.

_Detection evidence: `codeops/specialists/` is absent; the work reuses documented patterns in
`apps/web/src/pages/`, `apps/server/src/certificates/`, and `apps/server/src/rbac/`; no isolated
large-context migration or protocol invariant is present._

## Related Files

**Server and contract**

- `packages/api-contract/src/certificates.ts`
- `packages/api-contract/src/rbac.ts`
- `apps/server/src/certificates/repository.ts`
- `apps/server/src/certificates/service.ts`
- `apps/server/src/rbac/policy-service.ts`
- `apps/server/src/secrets/service.ts`
- `apps/server/scripts/api-contract.ts`
- `packages/api-contract/openapi.json`
- `apps/web/src/generated/*`

**Web**

- `apps/web/src/App.tsx`
- `apps/web/src/projects/project-route.tsx`
- `apps/web/src/layout/app-shell.tsx`
- `apps/web/src/docs.ts`
- `apps/web/src/pages/certificates-page.tsx` (new)
- `apps/web/src/pages/certificate-detail-page.tsx` (new)
- `apps/web/src/components/certificate-import-dialog.tsx` (new)
- `apps/web/src/components/certificate-generate-dialog.tsx` (new)
- `apps/web/src/components/certificate-metadata-dialog.tsx` (new)
- `apps/web/src/components/pem.ts` (new)
- `apps/web/src/validation.ts`
- `apps/web/tests/*`

**Docs and release**

- `docs/guide/web-ui.md`
- `docs/guide/certificates.md`
- `docs/security/known-limitations.md`
- `docs/reference/api.md`
- `docs/changelog.md`
- `docs/guide/versioning.md`
- `docs/index.md`
- `README.md`
- `tests/docs.spec.test.mjs`
- `codeops/features/certificate-ui/00-roadmap.md`
- `codeops/00-roadmap.md`

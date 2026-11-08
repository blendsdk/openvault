# Current State: Certificate UI

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What exists

The certificate backend is complete:

- `CertificatesController` exposes list, import, generate, read, private-key read, metadata update,
  delete, recover, and purge under `/v1/data/:project/certificates`
  (`apps/server/src/controllers/certificates.ts`).
- The repository supports name, SAN, and expiry filters with cursor pagination, but always excludes
  soft-deleted rows and applies `q` to the subject only
  (`apps/server/src/certificates/repository.ts:729-780`).
- The service returns metadata with five capability flags and public material; private-key reads use
  a separate route (`apps/server/src/certificates/service.ts:473-570`, `938-943`).
- The policy service maps secret and certificate capabilities
  (`apps/server/src/rbac/policy-service.ts:94-107`); `certificate.read_private` and
  `certificate.recover` exist as actions but are not projected into metadata.
- The CLI has `ov cert import`, `generate`, `get`, `list`, and `delete`
  (`apps/cli/src/commands/cert.ts`).

The web side is missing the feature:

- The project shell lists Overview, Secrets, Identities, Permissions, Audit, and Consumers
  (`apps/web/src/projects/project-route.tsx:35-42`).
- The router has no certificate route (`apps/web/src/App.tsx`).
- The project overview and projects table show only a certificate count
  (`apps/web/src/pages/project-overview-page.tsx:51`, `apps/web/src/pages/projects-page.tsx:154`).
- The generated browser client has no `certificates` group
  (`apps/web/src/generated/client.ts:10-18`), because the browser contract excludes the controller
  (`apps/server/scripts/api-contract.ts:556-566`).
- The docs say certificate management is CLI-only (`docs/guide/web-ui.md`, "Out of scope in v1.0";
  `docs/security/known-limitations.md`).

### Relevant files

| File | Purpose | Change |
|---|---|---|
| `packages/api-contract/src/certificates.ts` | Certificate schemas | Add `status` to the list query |
| `packages/api-contract/src/rbac.ts` | Capability flags | Add `canRecover`, `canReadPrivate` |
| `apps/server/src/certificates/repository.ts` | List SQL and cursor | Status branch; name/subject `q` |
| `apps/server/src/certificates/service.ts` | Metadata and lifecycle | Pass status; zero flags; comments |
| `apps/server/src/rbac/policy-service.ts` | Capability projection | Map the new flags |
| `apps/server/src/secrets/service.ts` | Secret metadata | Zero flags gain the new fields |
| `apps/server/scripts/api-contract.ts` | CLI and browser contracts | Add the certificate controller to the browser document |
| `packages/api-contract/openapi.json` | Published CLI contract | Regenerated |
| `apps/web/src/generated/*` | Generated browser client | Regenerated |
| `apps/web/src/App.tsx` | Routes | Add list and detail |
| `apps/web/src/projects/project-route.tsx` | Section navigation | Add Certificates |
| `apps/web/src/layout/app-shell.tsx` | Launcher | Add Certificates |
| `apps/web/src/docs.ts` | Docs link resolver | Map certificate routes |
| `apps/web/src/pages/certificates-page.tsx` | New list page | Create |
| `apps/web/src/pages/certificate-detail-page.tsx` | New detail page | Create |
| `apps/web/src/components/certificate-*-dialog.tsx` | New dialogs | Create |
| `apps/web/src/components/pem.ts` | PEM read/download helpers | Create |
| `apps/web/src/validation.ts` | Client validation | Add certificate helpers |
| `apps/web/tests/helpers/fake-vault.ts` | Test adapter | Add certificate routes |
| `apps/web/tests/accessibility.test.tsx` | Axe suite | Add certificate screens |
| `docs/*` | Reader documentation | Update |
| `tests/docs.spec.test.mjs` | Docs guard | Update version and coverage |

### Code analysis

```text
Browser route tree (today)
  /projects/:project
    ├── index        Overview
    ├── secrets      list + detail
    ├── identities
    ├── permissions
    ├── audit
    └── consumers

Certificate API (today, no browser client)
  GET    /v1/data/:project/certificates
  POST   /v1/data/:project/certificates/import
  POST   /v1/data/:project/certificates/generate
  GET    /v1/data/:project/certificates/:name
  GET    /v1/data/:project/certificates/:name/private-key
  PATCH  /v1/data/:project/certificates/:name
  DELETE /v1/data/:project/certificates/:name
  POST   /v1/data/:project/certificates/:name/recover
  POST   /v1/data/:project/certificates/:name/purge
```

The list route uses `listActiveCertificates` and hard-codes `c.deleted_at IS NULL`
(`apps/server/src/certificates/repository.ts:741`). The query's `q` parameter is applied to
`v.subject` only (`repository.ts:743-745`). The metadata projection is shared by list and detail, so
the new capability fields appear everywhere once added to the flags.

The certificate read route returns 410 for an expired current version
(`apps/server/src/certificates/service.ts:494-505`). Reading a specific version bypasses that check
(`service.ts:493-494`), which lets the detail page inspect an expired current certificate by passing
its version id.

## Gaps Identified

### Gap 1: No certificate browser surface

**Current behavior:** the browser shows a count and directs operators to the CLI.
**Required behavior:** a project Certificates section with list, detail, and lifecycle actions.
**Fix required:** routes, sections, launcher entry, pages, dialogs, docs mapping.

### Gap 2: Deleted certificates are unreachable

**Current behavior:** the list always excludes `deleted_at IS NOT NULL`; recover and purge exist
only in the API.
**Required behavior:** a `status=deleted` view with recover/purge.
**Fix required:** list query parameter, repository branch, UI status filter.

### Gap 3: Private-key and recover permissions are invisible

**Current behavior:** metadata exposes five flags; `certificate.read_private` and
`certificate.recover` are omitted.
**Required behavior:** precise flags so the UI hides unavailable actions.
**Fix required:** add `canReadPrivate` and `canRecover` to the shared flags and map them.

### Gap 4: No browser client group

**Current behavior:** `OpenVaultWebClient` has no `certificates` group; the controller is excluded
from the browser document.
**Required behavior:** typed browser calls generated from the real routes.
**Fix required:** add the controller to `WEB_CONTRACT_CONTROLLERS`, regenerate, check drift.

### Gap 5: Docs claim certificates are CLI-only

**Current behavior:** the web UI guide and limitations page say so.
**Required behavior:** the docs describe the UI and the 1.1.0 release.
**Fix required:** update reader docs, API reference, changelog, versioning, README/index.

## Dependencies

### Internal dependencies

- RD-09 certificate service and lifecycle.
- RD-12 web UI shell, components, generated client, and test harness.
- RBAC policy service and capability projection.
- Audit writer and existing certificate read/write events.
- Documentation guard in `tests/docs.spec.test.mjs`.

### External dependencies

None. The feature adds no package.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Adding fields to the shared capability shape breaks fixtures or generated types | Medium | Medium | TypeScript and `pnpm api:check` catch drift; update all fixtures in the same phase |
| The list status filter exposes deleted metadata to a caller who should not see it | Low | High | The existing `certificate.list` authorization still gates the route; deleted rows contain no PEM or key; tests cover reader and officer |
| A stale renew overwrites a newer version | Low | High | `expectedVersionId` on detail renew; version-conflict message; server 409 |
| Private key leaks through browser storage, logs, or clipboard | Low | High | Component-state only; no clipboard; 60s + blur clear; tests assert storage and console stay clean |
| Expired certificate detail is blocked by the 410 current-version gate | Medium | Low | Read with the current version id; test covers it |
| Version bump touches many release files and drifts | Medium | Low | Final phase uses the 1.0.1 bump checklist and `pnpm verify` |
| The browser contract regeneration changes unrelated files | Low | Medium | Review the generated diff; `api:check` is deterministic |

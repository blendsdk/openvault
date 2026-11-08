# Docs and Release: Certificate UI

> **Document**: 03-03-docs-release.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the reader-facing documentation changes and the v1.1.0 release metadata.
It does not create a tag, publish an image, create a GitHub release, or change the release
workflow. The plan ends with a verified tree whose version labels say 1.1.0; publication remains a
separate, user-authorized action.

## Documentation changes

### `docs/guide/web-ui.md`

- The opening sentence includes certificates in the day-to-day surface.
- The navigation paragraph names the certificate list and detail screens.
- The daily-flows table gains rows:

| Screen | What it does |
|---|---|
| Certificates | Search by name or subject, filter by SAN, expiry, and status, paginate, import, and generate |
| Certificate detail | Metadata, public leaf/chain, version-by-id read, tags, purge protection, delete/recover/purge, audited private-key reveal and download |

- The capabilities paragraph lists `canRecover` and `canReadPrivate`.
- The accessibility section includes the certificate list and detail.
- The “Out of scope in v1.0” paragraph no longer lists certificate screens. It keeps rotation
  wizards, settings, self-registration, password reset, rich secret editing, and additional
  locales; backup/restore and KEK rotation remain CLI tasks.

### `docs/guide/certificates.md`

Add a **Web UI** section after the API sections:

- Where the Certificates section is.
- List, search, status filter, and pagination.
- Import and generate, including local PEM files.
- Renew and `expectedVersionId`.
- Read current or a known version id.
- Public material copy/download.
- Private-key confirmation, 60-second hide, download, and audit.
- Tags, purge protection, delete, recover, purge.
- Capability gating.

Link to `/guide/web-ui` for the shared screen patterns.

### `docs/security/known-limitations.md`

Replace the certificate row:

> OpenVault is not a public certificate authority. Certificate management is available through the
> API, CLI, and web UI. Certificate version history is not listed in the UI; read the current version
> or a known version id.

Keep CA rotation, remote-host, and external-key limitations.

### `docs/reference/api.md`

- Update the certificate list query table: `q` matches name or subject; `status` is
  `active` (default) or `deleted`.
- Add `canRecover` and `canReadPrivate` to the capability fields in the certificate metadata
  description.
- Do not expose implementation internals or internal test paths. [PAR-13]

### `docs/changelog.md`

Add a 1.1.0 entry at the top:

```markdown
## 1.1.0 — <release date>

### Added

- Certificate management in the web UI: list, search, status filter, import, generate, renew,
  version-by-id read, public leaf/chain download, tags, purge protection, delete, recover, purge,
  and audited private-key reveal/download.
- Certificate list filters for name or subject, SAN, expiry, and active/deleted status.
- Capability flags for certificate recovery and private-key reads.
```

The exact release date is filled when the release is prepared; until then use the version heading
without a fabricated date or leave the date placeholder out. Do not invent a date.

### `docs/guide/versioning.md`

State that 1.0.0 is the first stable release and 1.1.0 is the current minor release. The v1 promise
still covers the `/v1` API and data format.

### `docs/index.md` and `README.md`

At the end of the final phase, state **Current release: 1.1.0** and update the release link. Until
the final phase, keep 1.0.1.

### `tests/docs.spec.test.mjs`

Update the version expectations to 1.1.0 and keep the implementation-term guard. Add a check that
`docs/guide/web-ui.md` mentions `Certificates` and that `docs/security/known-limitations.md` no
longer contains `not the web UI` / `not in the web UI`.

## Release metadata

The final phase moves the product labels from 1.0.1 to 1.1.0. Use the 1.0.1 bump as the checklist:

| Area | Files |
|---|---|
| Workspace packages | root `package.json`; `apps/agent`, `apps/cli`, `apps/server`, `apps/web`; `packages/api-contract`, `packages/core`, `packages/test-support` |
| CLI | `apps/cli/src/version.ts`; every `version: "1.0.1"` command parser; `apps/cli/src/client/authenticated.ts` User-Agent; `apps/cli/tests/dispatcher.spec.test.ts` |
| Web | `apps/web/src/session/session-api-provider.tsx` User-Agent |
| Server | `apps/server/src/ops/archive.ts`; `apps/server/scripts/api-contract.ts` document versions; `apps/server/src/scaffold/compose.ts` agent image |
| Contract | `packages/api-contract/openapi.json`; generated CLI/web clients |
| Compose | `deploy/compose/compose.yaml`, `deploy/compose/agent.example.yaml`, `examples/compose-env/compose.yaml` |
| Docs | `README.md`, `docs/index.md`, `docs/guide/getting-started.md`, `docs/guide/versioning.md`, `docs/guide/docker-compose.md`, `docs/changelog.md` |
| GitHub | `.github/ISSUE_TEMPLATE/bug.yml` placeholder; `.github/workflows/release.yml` description example |
| Tests | `tests/compose-env.spec.test.mjs`, `tests/docs.spec.test.mjs` |

Do not change:

- The internal security evidence and claims ledgers, except where the release process updates them
  after the tag.
- The release workflow logic, image names, or signing configuration.
- Any `latest` tag or published image. [AR-28, PAR-14, PAR-18]

## Release boundary

The plan stops after:

1. The feature and docs pass `pnpm verify`.
2. The version metadata says 1.1.0.
3. The roadmap records the plan as done.

The plan does not:

- Create or push a `v1.1.0` tag.
- Publish a Docker image.
- Create a GitHub release.
- Update the public release evidence with digests.

Those steps belong to the release workflow and a separate user authorization. [PAR-18]

## Documentation guard

`tests/docs.spec.test.mjs` currently rejects implementation terms such as `Codex`, `pnpm`, and
`React` in reader pages and checks the release labels. The final phase must keep those guards green.
When the version changes to 1.1.0, update the assertions, not the guards' intent. [PAR-13]

## Verification

- `pnpm docs:build`
- `pnpm test:root`
- `pnpm verify`
- A live check that the docs site shows the certificate UI and 1.1.0 after the docs deployment,
  if the release process deploys it. The plan itself does not deploy. [AR-28]

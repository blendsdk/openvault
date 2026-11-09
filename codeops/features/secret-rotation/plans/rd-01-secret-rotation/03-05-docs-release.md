# Docs and Release: Secret Rotation Workflow

> **Document**: 03-05-docs-release.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the reader-facing documentation and the v1.2.0 release metadata. It does not
create a tag, publish an image, or create a release.

## Documentation changes

### `docs/guide/rotation.md`

Replace the short "Secret rotation" section with the workflow:

- A rotation policy is an interval in days.
- The due date is derived from the current version.
- The Rotation page and `ov rotation` commands.
- Manual or generated values.
- The agent fetches the new version on its next refresh; restart or watch the file.
- Old versions remain readable.
- Optional signed webhook; metadata only.
- No automatic rotation and no version-level consumer tracking.

Keep the KEK, certificate, and browser-session sections.

### `docs/guide/secrets.md`

- Add the rotation metadata fields to the versions/expiry section.
- Link to `/guide/rotation`.
- Note that a new write resets the rotation due date.

### `docs/guide/web-ui.md`

- Add the Rotation page and secret-detail card to the daily flows.
- Add the status values and the generated-value handling.
- Add the restart note.
- Add the Rotation page and dialog to the accessibility coverage.
- Remove “rotation workflow” from any out-of-scope list if present.

### `docs/guide/cli.md` and `docs/reference/cli.md`

- Add the `ov rotation` group and every command/option.
- Explain `--generate`, `--out`, stdout warning behavior, and file mode `0600`.

### `docs/reference/api.md`

- Add the rotation metadata fields and the `rotation=policy|due|overdue` list filter.
- Add the webhook event/payload? The API reference covers the public API; the webhook is an
  operator integration. Add a short note in the rotation guide and configuration reference.

### `docs/reference/configuration.md`

- Add `OPENVAULT_ROTATION_SCAN_HOUR`, `OPENVAULT_ROTATION_WARNING_DAYS`,
  `OPENVAULT_ROTATION_WEBHOOK_URL`, and `OPENVAULT_ROTATION_WEBHOOK_SECRET`.
- Add the new table to the purge grants and dump notes.

### `docs/changelog.md`

Add a 1.2.0 entry:

```markdown
## 1.2.0 — <release date>

### Added

- Per-secret rotation policies, due-soon and overdue status, and a project Rotation screen.
- Guided rotation with a manual or generated value in the web UI and `ov rotation`.
- Optional signed rotation-reminder webhook with metadata-only payloads.
```

Do not invent a release date; use the prepared date or leave it for the release step.

### `docs/guide/versioning.md`, `docs/index.md`, and `README.md`

At the end of the final phase, state **Current release: 1.2.0**, update the release link and status
badge, and remove “rotation workflow” from the README roadmap because it now ships. Preserve the
1.0/1.1 history.

## Release metadata

Move every 1.1.0 label to 1.2.0 using the 1.1.0 release checklist:

| Area | Files |
|---|---|
| Workspace packages | root `package.json`; `apps/agent`, `apps/cli`, `apps/server`, `apps/web`; `packages/*/package.json` |
| CLI | `apps/cli/src/version.ts`; command parser versions; `authenticated.ts` User-Agent; dispatcher test |
| Web | `apps/web/src/session/session-api-provider.tsx` User-Agent |
| Server | `apps/server/src/ops/archive.ts`; `apps/server/scripts/api-contract.ts`; scaffold agent image |
| Contract | `packages/api-contract/openapi.json`; generated clients |
| Compose | `deploy/compose/compose.yaml`, `agent.example.yaml`, `examples/compose-env/compose.yaml` |
| Docs | README, docs index, getting started, versioning, docker-compose, changelog |
| GitHub | issue template placeholder; release workflow description example |
| Tests | compose example and docs guard expectations |

Do not change the release workflow logic, image names, or signing configuration. Do not tag or
publish. [AR-26, PAR-13, PAR-18]

## Documentation guard

`tests/docs.spec.test.mjs` checks the release labels, version labels, and implementation-term bans.
Update the expected version and add a check that the rotation guide and web UI guide mention the new
workflow. Keep the guard's intent. [PAR-13]

## Verification

- `pnpm docs:build`
- `pnpm test:root`
- `pnpm verify`
- A live docs check after the release process deploys, if applicable. The plan itself does not
  deploy.

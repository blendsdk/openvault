# Requirements: Certificate UI

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-01](../../requirements/RD-01-certificate-ui.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan

- RD-01 §Functional Requirements — navigation, list, filters, pagination, status, and tags.
- RD-01 §Functional Requirements — detail metadata, current or version-by-id read, public
  leaf/chain copy/download.
- RD-01 §Functional Requirements — import, generate, and renew with `expectedVersionId`.
- RD-01 §Functional Requirements — tag and purge-protection editing, delete, recover, purge.
- RD-01 §Functional Requirements — audited private-key confirmation, 60-second reveal, download.
- RD-01 §Functional Requirements — capability-gated actions, audit coverage, no browser storage of
  keys.
- RD-01 §API contract changes — list status/search, additive capability flags, generated browser
  client.
- RD-01 §Error handling, §Accessibility, §Performance, and §Integration Points.
- RD-01 §Acceptance Criteria 1–27.

### Deferred / out of this plan

- RD-01 Won't Have: CA/ACME/public issuance, host trust-store changes, bulk operations, remote
  hosts, Kubernetes identity, external KMS/HSM, new locales, new dependencies, automatic renewal.
- Certificate version-history listing. The UI supports the current version and a known version id.
- Release tagging, publishing, or releasing images. The plan ends at 1.1.0 release metadata.

## Plan-local decisions

| Decision | Chosen | Ref |
|---|---|---|
| One repository list method with a status branch | Keep one method, parameterize status | PAR-02 |
| Shared capability flags | Add `canRecover` and `canReadPrivate` to the shared shape | PAR-03 |
| Browser transport | Add the certificate controller to the generated browser client | PAR-04 |
| Detail metadata lookup | List query with `status` and `q=name`; explicit public read | PAR-05 |
| Component split | Two pages, three dialogs, small PEM helpers | PAR-06 |
| State | Local state + `useAsync` | PAR-07 |
| Local file reading | `readPemFile` with `FileReader` and size caps | PAR-08 |
| Private-key clear | Timer + blur/window/route/unmount | PAR-09 |
| Test harness | Extend `FakeVault`; real pages and generated client | PAR-11 |
| Phase ordering | Seven spec-first phases | PAR-12 |
| Release boundary | Final metadata phase; no tag or publish | PAR-14, PAR-18 |
| Commit mode | `--auto-commit` after each verified task | PAR-17 |

## Acceptance Criteria

The RD owns the acceptance criteria. This plan adds no product criteria beyond RD-01. The plan's
completion conditions are:

1. All RD-01 acceptance criteria pass.
2. Every phase's specification tests were written before implementation and observed red.
3. `pnpm verify` passes.
4. `pnpm api:check` reports no drift.
5. The certificate list and detail screens pass the axe suite.
6. The published docs describe the certificate UI and state 1.1.0.
7. No new dependency, service, database migration, or deployment change exists.
8. The plan does not create a tag, publish an image, or create a release.

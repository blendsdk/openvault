# Requirements: Secret Rotation Workflow

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-01](../../requirements/RD-01-secret-rotation.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan

- RD-01 §Data model — nullable interval column and derived due date.
- RD-01 §Metadata API — `rotationIntervalDays`, `rotationDueAt`, `rotationStatus`, and PATCH.
- RD-01 §List API — `rotation=policy|due|overdue`.
- RD-01 §Webhook scan and §Notification persistence — table, schedule, HMAC, retries.
- RD-01 §Audit, purge, and dump.
- RD-01 §Configuration — four env vars.
- RD-01 §CLI — `ov rotation` group.
- RD-01 §Web UI — Rotation page, detail card, list badge, rotate dialog.
- RD-01 §Documentation — reader docs and v1.2.0 metadata.
- RD-01 acceptance criteria 1–22.

### Deferred / out of this plan

- Automatic rotation, external provider rotation, version-level consumer tracking, old-version
  deletion, email/chat notifications, a global rotation page, and new support machinery.
- Release tagging, image publication, and the GitHub release. The plan ends at metadata.

## Plan-local decisions

| Decision | Chosen | Ref |
|---|---|---|
| Interval column | One nullable column on `secrets` | PAR-02 |
| Status computation | SQL filters + service response fields | PAR-03 |
| Notification service | Mirror certificate expiry with a dedicated table | PAR-04 |
| Webhook | Reuse expiry URL validation and HMAC | PAR-05 |
| Audit | Add `secret.rotation_warning` | PAR-06 |
| Purge/dump/grants | Full integration | PAR-07 |
| CLI | Root `ov rotation` group | PAR-08 |
| Web | Rotation page + detail card + dialogs | PAR-09 |
| Generated value | Show once; copy/regenerate; no storage | PAR-10 |
| Tests | Extend `FakeVault`; real server integration | PAR-11 |
| Phase ordering | Seven spec-first phases | PAR-12 |
| Release boundary | Final metadata phase; no tag or publish | PAR-13, PAR-18 |
| Commit mode | `--auto-commit` after each verified task | PAR-17 |

## Acceptance Criteria

The RD owns the acceptance criteria. This plan adds no product criteria beyond RD-01. The plan's
completion conditions are:

1. All RD-01 acceptance criteria pass.
2. Every phase's specification tests were written before implementation and observed red.
3. `pnpm verify` passes.
4. `pnpm api:check` reports no drift.
5. The Rotation page and rotate dialog pass the axe suite.
6. The generated value never appears in storage, the URL, the console, or logs in tests.
7. The purge and dump tests cover the new notification table.
8. The reader docs describe the restart requirement and state 1.2.0.
9. No new dependency, service, queue, workflow engine, or generic notification framework exists.
10. The plan does not create a tag, publish an image, or create a release.

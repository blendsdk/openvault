# Goal Prompt: Execute the OpenVault Secret Rotation Workflow

Use this file to start a coding-agent session. It is a maintainer artifact; it is not part of the
published documentation.

---

## Goal

Implement the OpenVault secret rotation workflow exactly as specified in
`codeops/features/secret-rotation/plans/rd-01-secret-rotation/`. Operators must be able to set a
per-secret rotation interval, see due-soon and overdue secrets, rotate with a manual or generated
value from the web UI or CLI, and optionally receive a signed metadata-only webhook reminder. The
workflow must not rotate automatically, call external providers, track application version
acknowledgement, or delete old versions.

Work in:

```text
/home/gevik/workdir/blendsdk/openvault
```

The plan artifacts are committed on `docs/secret-rotation-plan`. Start the session on that branch
(`git switch docs/secret-rotation-plan`), or merge the plan into `main` before executing.

Target release: **v1.2.0**. Do not create or push a tag, publish an image, or create a GitHub
release. The plan stops at release metadata.

## Read first

Read these files in order before touching code:

1. `codeops/features/secret-rotation/requirements/RD-01-secret-rotation.md`
2. `codeops/features/secret-rotation/requirements/00-ambiguity-register.md`
3. `codeops/features/secret-rotation/plans/rd-01-secret-rotation/00-index.md`
4. `codeops/features/secret-rotation/plans/rd-01-secret-rotation/00-ambiguity-register.md`
5. `codeops/features/secret-rotation/plans/rd-01-secret-rotation/02-current-state.md`
6. `03-01-data-api.md`, `03-02-notifications.md`, `03-03-cli.md`, `03-04-web-ui.md`, `03-05-docs-release.md`
7. `07-testing-strategy.md`
8. `99-execution-plan.md` — the task checklist and single source of progress truth

Also read the repository guidance in `AGENTS.md`, and the cited files before editing them.

## Execution mode

Use the `exec-plan` skill with this feature and both flags:

```text
exec-plan secret-rotation --auto-design --auto-commit
```

If the skill's argument syntax differs, use the equivalent that selects the `secret-rotation`
feature, delegates eligible technical decisions, and commits plus pushes after each verified task.
Do not ask for permission for eligible technical decisions. Stop for reserved decisions: product
behavior, scope, security policy, access policy, destructive or irreversible external actions,
release publication, credentials, spending, or a complexity escalation.

Before execution, run the `preflight` skill against the plan if it is available. Resolve eligible
technical findings under the active auto-design policy. Stop and report any reserved finding.

## Workflow rules

1. Work one task at a time, in plan order.
2. Write the phase's specification tests before the implementation. Run them, confirm the expected
   red failures, then implement.
3. Update `99-execution-plan.md` after every task: `[~]` with a timestamp while implementing, `[x]`
   when verification passes, `[!]` with a reason when blocked. Update the Progress header and Last
   Updated stamp every time.
4. Run the phase's `Verify` command before moving on. At the end, run `pnpm verify`.
5. Commit after each verified task with a Conventional Commit message. Push the branch. Never use
   `--no-verify`, never force-push, and never commit a secret, generated value, `.env`, or sensitive
   evidence.
6. If a task is blocked by missing information, a failing external dependency, or a reserved
   decision, stop and report the exact blocker. Do not guess.
7. Clean up temporary files under `$CODEOPS_TMPDIR` (fallback: the OS temp directory). Do not leave
   scratch files in the repository.

## Non-negotiable constraints

- **No new dependency, service, framework, state store, queue, workflow engine, or generic
  notification framework.** Reuse the existing stack and the certificate-expiry pattern.
- **One nullable interval column**, one notification table, and additive metadata/list-filter
  fields. No breaking API change.
- **Status is server-computed** from the current version's `createdAt`, the interval, and the
  warning window. The UI and CLI display the returned status.
- **Authorization** uses the existing `secret.write` for policy and rotation; viewing uses
  `secret.list`/`secret.read`. The server remains authoritative.
- **Generated values** are 32 random bytes base64url. Show them once. Never write them to storage,
  the URL, the console, logs, the webhook, or the audit event. CLI `--out` uses mode `0600`.
- **Old versions remain readable.** Do not delete or expire them as part of rotation.
- **No application control.** The agent fetches the new version on refresh; the docs and UI state
  that the application must restart or watch the file.
- **Webhook** carries metadata only, is HMAC-signed, validates the URL, and retries on a later scan.
- **No automatic rotation** and no external provider calls.
- **Release.** Stop after the 1.2.0 metadata and `pnpm verify`. Do not tag, publish, or create a
  release.

## Definition of done

1. Every task in `99-execution-plan.md` is `[x]`.
2. Every RD-01 acceptance criterion is covered by a passing test or a recorded manual check.
3. `pnpm verify` exits 0.
4. `pnpm api:check` exits 0.
5. The Rotation page and rotate dialog pass the axe suite.
6. The manual review-stack E2E sequence in `07-testing-strategy.md` is completed, or its
   environment limitation is recorded.
7. No generated value appears in storage, the URL, the console, logs, the webhook, or the audit
   event in tests.
8. Purge and dump cover the notification table.
9. The reader docs describe the restart requirement and state 1.2.0.
10. No tag, published image, or GitHub release was created.

## Report format

```text
Secret rotation — execution summary

Phases completed: X/7
Tasks completed: X/79
Verification: pnpm verify <pass/fail>; api:check <pass/fail>; axe <pass/fail>
Evidence: <test counts and key commands>
Docs: <files updated; live check if applicable>
Release boundary: no tag, no publish, no release
Open issues: <none, or exact blockers/decisions>
```

Do not claim a task or phase is complete without the command output that proves it.

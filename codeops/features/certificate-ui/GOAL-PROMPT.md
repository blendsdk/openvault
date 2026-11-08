# Goal Prompt: Execute the OpenVault Certificate UI

Use this file to start a coding-agent session. It is a maintainer artifact; it is not part of the
published documentation.

---

## Goal

Implement the OpenVault Certificate UI exactly as specified in
`codeops/features/certificate-ui/plans/rd-01-certificate-ui/`. The web UI must reach parity with the
existing certificate API and CLI: list active and deleted certificates, search by name or subject,
filter by SAN and expiry, inspect metadata and public material, read a version by id, import,
generate, renew, edit tags and purge protection, delete, recover, purge, and reveal/download a
private key after an explicit confirmation. Every action uses the existing server routes, RBAC, and
audit trail.

Work in:

```text
/home/gevik/workdir/blendsdk/openvault
```

Target release: **v1.1.0**. Do not create or push a tag, publish an image, or create a GitHub
release. The plan stops at release metadata.

## Read first

Read these files in order before touching code:

1. `codeops/features/certificate-ui/requirements/RD-01-certificate-ui.md` — behavior, scope,
   security, and acceptance criteria.
2. `codeops/features/certificate-ui/requirements/00-ambiguity-register.md` — product decisions
   (`AR-01..AR-30`).
3. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/00-index.md` — plan overview.
4. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/00-ambiguity-register.md` — plan
   decisions (`PAR-01..PAR-20`).
5. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/02-current-state.md` — existing code
   and gaps.
6. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/03-01-web-ui.md` — browser spec.
7. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/03-02-server-contract.md` — server
   and generated-client spec.
8. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/03-03-docs-release.md` — docs and
   release metadata.
9. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/07-testing-strategy.md` — test cases.
10. `codeops/features/certificate-ui/plans/rd-01-certificate-ui/99-execution-plan.md` — the task
    checklist and single source of progress truth.

Also read the repository guidance in `AGENTS.md`, and the plan's cited files before editing them.

## Execution mode

Use the `exec-plan` skill with this feature and both flags:

```text
exec-plan certificate-ui --auto-design --auto-commit
```

If the skill's argument syntax differs, use the equivalent that selects the
`certificate-ui` feature, delegates eligible technical decisions, and commits plus pushes after each
verified task. Do not ask for permission for eligible technical decisions. Stop for reserved
decisions: product behavior, scope, security policy, access policy, destructive or irreversible
external actions, release publication, credentials, spending, or a complexity escalation.

Before execution, run the `preflight` skill against the plan if it is available. Resolve eligible
technical findings under the active auto-design policy. Stop and report any reserved finding.

## Workflow rules

1. Work one task at a time, in plan order.
2. Write the phase's specification tests before the implementation. Run them, confirm the expected
   red failures, then implement.
3. Update `99-execution-plan.md` after every task: `[~]` with a timestamp while implementing, `[x]`
   when the task's verification passes, `[!]` with a reason when blocked. Update the Progress header
   and Last Updated stamp every time.
4. Run the phase's `Verify` command before moving on. At the end, run `pnpm verify`.
5. Commit after each verified task with a Conventional Commit message. Push the branch. Never use
   `--no-verify`, never force-push, and never commit a secret, private key, `.env`, or generated
   evidence that contains sensitive data.
6. If a task is blocked by missing information, a failing external dependency, or a reserved
   decision, stop and report the exact blocker. Do not guess.
7. Clean up temporary files under `$CODEOPS_TMPDIR` (fallback: the OS temp directory). Do not leave
   scratch files in the repository.

## Non-negotiable constraints

- **No new dependency, service, framework, state store, upload service, queue, or infrastructure.**
  Reuse Fluent UI, BlendSDK components, the generated client, `useAsync`, and the existing test
  helpers.
- **No database migration.** The API changes are additive: a list `status` filter, a broader
  name-or-subject `q`, and the `canRecover` / `canReadPrivate` capability fields.
- **No hand-written transport.** Add `CertificatesController` to `WEB_CONTRACT_CONTROLLERS` and use
  the generated `client.certificates` group.
- **Server authority.** The UI hides actions from capability flags, but every request is still
  authorized by the server. Do not add client-side permission logic beyond the flags.
- **Private keys.** Reveal only after an explicit confirmation. Clear after 60 seconds, on region
  blur, window blur, route change, and unmount. Never write a private key to local storage, session
  storage, IndexedDB, cookies, the URL, the console, or application logs. Do not copy it to the
  clipboard automatically. Download only.
- **Public material.** Public leaf and chain reads are explicit and audited. Pass the selected
  version id so an expired current certificate remains inspectable.
- **Destructive actions.** Delete and purge require confirmations. Purge is disabled until the
  certificate is deleted, unprotected, and past `purgeAfter`.
- **Docs.** Reader pages must not mention internal implementation or assurance records. Keep the
  existing docs guard green.
- **Release.** Stop after the 1.1.0 metadata and `pnpm verify`. Do not tag, publish, or create a
  release.

## Definition of done

The work is done only when:

1. Every task in `99-execution-plan.md` is `[x]`.
2. Every RD-01 acceptance criterion is covered by a passing test or a recorded manual check.
3. `pnpm verify` exits 0.
4. `pnpm api:check` exits 0.
5. The certificate list and detail pass the axe suite.
6. The manual review-stack E2E sequence in `07-testing-strategy.md` is completed, or its
   environment limitation is recorded.
7. No private key appears in storage, the URL, the console, or the clipboard in tests.
8. The reader docs describe the certificate UI and state 1.1.0.
9. No tag, published image, or GitHub release was created.
10. The feature and portfolio roadmaps record the plan as done.

## Report format

At the end, report:

```text
Certificate UI — execution summary

Phases completed: X/7
Tasks completed: X/74
Verification: pnpm verify <pass/fail>; api:check <pass/fail>; axe <pass/fail>
Evidence: <test counts and key commands>
Docs: <files updated; live check if applicable>
Release boundary: no tag, no publish, no release
Open issues: <none, or exact blockers/decisions>
```

Do not claim a task or phase is complete without the command output that proves it.

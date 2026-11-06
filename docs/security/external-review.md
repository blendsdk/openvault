# External security review

> **Status**: Pending
> **Release**: none
> **Commit**: none
> **Open Critical**: 0
> **Open High**: 0
> **Reviewer**: not assigned
> **Packet version**: 2026-11-06

This file is the production-label gate. The release workflow reads the
machine-readable fields above. A production tag fails unless `Status` is
`Approved`, `Release` matches the tag, `Commit` matches the tagged commit,
`Reviewer` is named, and `Open Critical` and `Open High` are both `0`. Do not edit these fields without an independent reviewer's signed
report.

## Scope

The release-candidate review covers:

| Area | Questions |
|---|---|
| Cryptographic design | Envelope construction, AAD domain separation, KEK/DEK custody, keyring permission checks, CA key wrapping, restore behavior |
| Authentication and sessions | Local and OIDC login, cookie flags, CSRF, session and refresh rotation, token reuse detection, forced password change |
| Agent isolation | Join and renewal, mTLS profile, revocation, per-service tmpfs, application compromise boundary |
| Deployment | Compose topology, non-root containers, database roles, secret delivery, backup and restore, release pipeline |

Out of scope: UI copy, marketing claims, SOC 2, ISO 27001, and a bug bounty
program.

## Packet

Give the reviewer:

- The threat model: [`threat-model.md`](threat-model.md).
- The evidence matrix: [`evidence-matrix.md`](evidence-matrix.md).
- The security claims ledger: [`claims.md`](claims.md).
- The cryptography and identity architecture pages.
- The known limitations: [`limitations.md`](limitations.md).
- The internal review reports under
  `codeops/features/openvault-v0-1/plans/rd-14-release/reviews/`.
- The release commit and the image digest produced by the alpha workflow.
- Reproduction commands: `pnpm verify`, `pnpm security:evidence:check`,
  `pnpm check:compose`, and the PostgreSQL 16/17 integration suites.

The reviewer must not receive production secrets, real customer values, or a
live production database. Use the seeded test fixtures and the restore drill.

## Finding disposition

| Severity | Required action |
|---|---|
| Critical | Fix before the production label; no exception |
| High | Fix, or record an explicit written acceptance with rationale and compensating control |
| Medium | Fix or schedule with an owner and target release |
| Low | Track in the backlog |

Every accepted High finding is recorded in this file under `Accepted risks` and
the `Open High` count is decremented only after the acceptance is signed.

## Approval protocol

1. The reviewer writes a report with a verdict and a finding table.
2. The maintainer resolves or accepts every Critical and High finding.
3. The maintainer updates `Status`, `Release`, `Commit`, `Reviewer`, `Open Critical`, and
   `Open High` in this file in a separate commit. `Commit` is the full SHA under review.
4. The production tag is created from that commit.
5. The release workflow re-runs the gate; it fails if the fields do not match.

## Accepted risks

None yet.

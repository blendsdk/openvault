# Independent security review

> **Status**: Pending
> **Release**: none
> **Commit**: none
> **Reviewed Commit**: none
> **Scanner**: OpenAI Codex Security
> **Scan ID**: none
> **Scanned At**: none
> **Open Critical**: 0
> **Open High**: 0
> **Report**: none

This file is the production-label gate. The release workflow reads the
machine-readable fields above. A production tag fails unless `Status` is
`Approved`, `Release` matches the tag, `Commit` matches the approval/tag commit,
`Reviewed Commit` is the full code commit the scanner analyzed, `Scanner` is
`OpenAI Codex Security`, `Scan ID` and `Scanned At` are recorded, the report
file exists, and `Open Critical` and `Open High` are both `0`.

The review is an automated independent scan, not a human engagement. It
analyzes the repository for security issues in the crypto, authentication,
agent, deployment, and configuration surfaces. It does not replace human
judgment for UI copy, operational procedures, or issues that require business
context; those remain the maintainer's responsibility. Record every accepted
High finding and its compensating control under [Accepted risks](#accepted-risks).

## Scope

| Area | Questions |
|---|---|
| Cryptographic design | Envelope construction, AAD domain separation, KEK/DEK custody, keyring permission checks, CA key wrapping, restore behavior |
| Authentication and sessions | Local and OIDC login, cookie flags, CSRF, session and refresh rotation, token reuse detection, forced password change |
| Agent isolation | Join and renewal, mTLS profile, revocation, per-service tmpfs, application compromise boundary |
| Deployment | Compose topology, non-root containers, database roles, secret delivery, backup and restore, release pipeline |
| Configuration and transport | Fail-closed validation, TLS/mTLS listeners, proxy trust, body limits, readiness, redaction |

Out of scope: UI copy, marketing claims, SOC 2, ISO 27001, and a bug bounty
program.

## Packet

The scanner reads the repository directly. Supporting context:

- The threat model: [`threat-model.md`](threat-model.md).
- The evidence matrix: [`evidence-matrix.md`](evidence-matrix.md).
- The security claims ledger: [`claims.md`](claims.md).
- The cryptography and identity architecture pages.
- The known limitations: [`limitations.md`](limitations.md).
- The internal review reports under
  `codeops/features/openvault-v0-1/plans/rd-14-release/reviews/`.

The scan must run against a clean checkout. It must not receive production
secrets, real customer values, or a live production database. Use the seeded
test fixtures and the restore drill.

## Run the review

```bash
# Run on the release-candidate code commit with a clean working tree.
codex-security scan . --headless --fail-on-severity high --max-cost 50

# Review the findings.
codex-security findings

# Export evidence outside the repository until Critical/High findings are fixed.
codex-security export --scan <scan-id> --export-format json --output /tmp/openvault-codex.json
```

The standard scan is the release gate. A Deep scan may be used when the change
surface is unusually large, but it is not required for a routine release.

## Finding disposition

| Severity | Required action |
|---|---|
| Critical | Fix before the production label; no exception |
| High | Fix before approval; do not accept a High finding for v0.1 |
| Medium | Fix or record an owner and target release |
| Low | Track in the backlog |

A production approval requires `Open Critical: 0` and `Open High: 0`. Fixing a
finding changes the code commit, so re-run the scan on the new commit before
approval.

## Approval protocol

1. Check out the release-candidate code commit with a clean working tree.
2. Run the scan and resolve every Critical/High finding. Re-run after any fix.
3. Export the finding summary and add a sanitized report under
   `docs/security/` (for example `codex-security-<short-sha>.md`). Do not commit
   raw findings that describe an unfixed vulnerability.
4. Add the approval record in a docs-only commit. Set `Reviewed Commit` to the
   scanned code commit and `Commit` to the approval commit that will be tagged.
5. Set `Status: Approved`, `Release: v0.1.0`, the scanner fields, both severity
   counts to `0`, and the report path. Merge the approval commit to `main`.
6. Tag the approval commit and push the tag. The release workflow re-runs this
   gate and fails closed if any field is missing or mismatched.

The two-commit shape keeps the scanned code and the release tag auditable: the
approval commit changes only the review record, while the code under review is
the recorded `Reviewed Commit`.

## Accepted risks

None.

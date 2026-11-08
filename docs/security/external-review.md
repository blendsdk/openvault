# Manual security scan record

> **Status**: Not run
> **Release**: none
> **Commit**: none
> **Reviewed Commit**: none
> **Scanner**: OpenAI Codex Security
> **Scan ID**: none
> **Scanned At**: none
> **Open Critical**: 0
> **Open High**: 0
> **Report**: none

This file records a manual OpenAI Codex Security scan. The scan needs a specific
runtime environment that is not available in CI/CD, so it is run by the
maintainer from time to time and is **not** part of the automated pipeline. It is
not a release gate, has no fail-closed approval mechanism, and does not block a
production tag.

The scan covers the crypto, authentication, agent, deployment, and configuration
surfaces. It does not replace human judgment for UI copy, operational
procedures, or issues that require business context; those remain the
maintainer's responsibility. Record accepted findings under
[Accepted risks](#accepted-risks).

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

Run the scan against a clean checkout. It must not receive production secrets,
real customer values, or a live production database. Use the seeded test
fixtures and the restore drill.

## Run the review manually

```bash
# Run on a clean working tree; this is a local, manual command.
codex-security scan . --headless --fail-on-severity high --max-cost 50

# Review the findings.
codex-security findings

# Export evidence outside the repository until Critical/High findings are fixed.
codex-security export --scan <scan-id> --export-format json --output /tmp/openvault-codex.json
```

The standard scan is the recommended manual check. A Deep scan may be used when
the change surface is unusually large, but it is not required.

## Finding disposition

| Severity | Suggested action |
|---|---|
| Critical | Fix as soon as practical; the maintainer decides the release impact |
| High | Fix or record the accepted risk and compensating control |
| Medium | Fix or record an owner and target release |
| Low | Track in the backlog |

These are review guidelines, not automated release conditions. The maintainer
decides whether a finding affects a release.

## Recording a scan

1. Check out the commit to scan with a clean working tree.
2. Run the scan manually and review the findings.
3. Export a sanitized report under `docs/security/` if useful. Do not commit raw
   findings that describe an unfixed vulnerability.
4. Update the fields at the top of this file with the scanned commit, scan id,
   timestamp, open counts, and report path.
5. Commit the record as documentation. No workflow reads it and no release step
   depends on it.

## Accepted risks

None.

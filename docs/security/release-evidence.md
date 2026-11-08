# Release evidence

> **Snapshot**: 2026-11-08, `main` after the dependency upgrade (PR #57); release review pending
> **Production image**: not published

## Branch protection

Queried with `gh api repos/blendsdk/openvault/branches/main/protection`:

| Control | State |
|---|---|
| Required pull request reviews | Enabled; stale reviews dismissed |
| Required status checks | Strict; `Verify`, `Gitleaks`, `CodeQL`, `Integration (16)`, `Integration (17)`, `Audit`, `Review dependency changes` |
| Required linear history | Enabled |
| Force pushes | Disabled |
| Branch deletion | Disabled |
| Enforce for administrators | Enabled |
| Conversation resolution | Enabled |

The repository settings satisfy the RD-14 branch-protection requirement. No
change was needed.

## CI evidence

| Gate | Where |
|---|---|
| Build, typecheck, API contract, lint, unit tests, artifacts, docs | `pnpm verify` / `Verify` |
| PostgreSQL 16 and 17 integration | `Integration (16)` and `Integration (17)`; 92 files and 741 tests each locally |
| Dependency audit | `Audit` and the weekly `Security scans` workflow |
| CodeQL | `CodeQL` |
| Secret scan | `Gitleaks` |
| Dependency review | `Review dependency changes` |
| Docs build | `Build documentation` |
| Compose hardening | `pnpm check:compose` inside `Verify` |
| Container images | Server, agent, and web images built locally from the merged tree; server `ov --version` and web CSP/health smoke passed |
| Security evidence and claims | `pnpm security:evidence:check` and `pnpm security:claims:check` inside `Verify` |

## Security scanner remediation

A fresh Codex Security scan at `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a` reported seven
findings: two High, three Medium, and two Low. All seven are fixed on this branch with
regression tests, threat-model rows T-24 through T-30, and updated limitations. The external
review remains the production-release gate.

## Release image evidence

The release workflow publishes, scans, signs, and attests the images. The first
alpha image is produced by a manual dispatch. A production image is blocked
until the independent-review file is approved. The workflow writes the digest and
SBOM list to the GitHub release and the job summary.

## Independent review

`docs/security/external-review.md` is the gate. It currently records
`Status: Pending`, so a production tag fails before any registry login.

## Reproduce locally

```bash
pnpm verify
pnpm security:evidence:check
pnpm security:claims:check
pnpm check:compose
node scripts/check-release-gate.mjs --mode alpha --version v0.1.0-alpha.1
node scripts/check-release-gate.mjs --mode production --version v0.1.0 --commit "$(git rev-parse HEAD)"
```

The production command intentionally fails until the Codex Security review is
approved.

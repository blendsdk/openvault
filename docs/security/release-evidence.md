# Release evidence

> **Snapshot**: 2026-11-06, `af95d02` after the RD-13/RD-14 work
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
| PostgreSQL 16 and 17 integration | `Integration (16)` and `Integration (17)`; 90 files and 701 tests each locally |
| Dependency audit | `Audit` and the weekly `Security scans` workflow |
| CodeQL | `CodeQL` |
| Secret scan | `Gitleaks` |
| Dependency review | `Review dependency changes` |
| Docs build | `Build documentation` |
| Compose hardening | `pnpm check:compose` inside `Verify` |
| Container images | Server, agent, and web images built locally from the merged tree; server `ov --version` and web CSP/health smoke passed |
| Security evidence and claims | `pnpm security:evidence:check` and `pnpm security:claims:check` inside `Verify` |

## Release image evidence

The release workflow publishes, scans, signs, and attests the images. The first
alpha image is produced by a manual dispatch. A production image is blocked
until the external review file is approved. The workflow writes the digest and
SBOM list to the GitHub release and the job summary.

## External review

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

The production command intentionally fails until the external review is
approved.

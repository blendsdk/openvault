# Release evidence

> **Snapshot**: 2026-11-08, `v1.0.1` release
> **Production image**: `v1.0.1` published to Docker Hub

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
| Container images | Server, agent, and web images published to Docker Hub; the v1.0.1 digests are below |
| Security evidence and claims | `pnpm security:evidence:check` and `pnpm security:claims:check` inside `Verify` |

## Security scanner remediation

A fresh Codex Security scan at `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a` reported seven
findings: two High, three Medium, and two Low. All seven are fixed on this branch with
regression tests, threat-model rows T-24 through T-30, and updated limitations. The Codex
scan is a manual, advisory check; it is not part of CI/CD and does not block a release.

## Release image evidence

The release workflow publishes the images to Docker Hub under `blendsdk`,
scans, signs, and attests them. The first stable image is produced by the
`v1.0.0` tag. Later releases use a deliberate `v*.*.*` tag or tagged dispatch.
The workflow writes the digest list to the GitHub release and the job summary.
SBOM and provenance attestations are attached to the images.

### v1.0.1

Published on 2026-11-08. Cosign signatures were verified against
`refs/tags/v1.0.1`. This patch fixes the agent response envelope, the scaffolded
agent command, and the healthcheck startup window.

| Image | Digest |
|---|---|
| `blendsdk/openvault` | `sha256:9a7aa456047e00eb64fd4d2ff7cebbed95539935b44d85197791e42e31be847d` |
| `blendsdk/openvault-agent` | `sha256:8e92dbb89874cf3535cc06db25ca29adfc3b2504692f06aa635c5f70e2470cc0` |
| `blendsdk/openvault-web` | `sha256:8a993297db3347253ac449e36430d56c1882fc449d1f9183e31d90b89400edad` |

### v1.0.0

Published on 2026-11-08. Cosign signatures were verified against
`refs/tags/v1.0.0`.

| Image | Digest |
|---|---|
| `blendsdk/openvault` | `sha256:db9aa9aaa664a97885874a78f15cf240fea8d652a7066a114db03afba3ffdf60` |
| `blendsdk/openvault-agent` | `sha256:3ab890f7e4989551f51b1e2407b62fd250c726aabc1544394952a484a4b84f61` |
| `blendsdk/openvault-web` | `sha256:7507d6e62908fe0274f53a9bea51f2fca07504dce610af58f12109cf618d9e1b` |

## Manual security scan

`docs/security/external-review.md` records the optional OpenAI Codex Security
scan. It is run manually from time to time because it needs a specific runtime
environment that is not available in CI/CD. It is not a workflow step and does
not block a release.

## Reproduce locally

```bash
pnpm verify
pnpm security:evidence:check
pnpm security:claims:check
pnpm check:compose
```

The Codex Security scan is not part of this list and is not a release gate.

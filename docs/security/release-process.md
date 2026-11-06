# Release process

## Labels

| Label | Allowed before external review | Image tags | OCI label |
|---|---|---|---|
| Alpha | Yes, explicit `workflow_dispatch` | `alpha`, `sha-<12>` | `not-for-production=true` |
| Production | No | `v0.1.0`, `0.1.0`, `latest`, `sha-<12>` | `production=true` |

A production tag is any push matching `v*.*.*`. The release workflow runs
`scripts/check-release-gate.mjs` before it logs in to the registry, builds,
scans, signs, or publishes.

## Pipeline

```text
tag v0.1.0 (or alpha dispatch)
  → release gate
  → build amd64 images to staging tags
  → BuildKit SBOM and max provenance attestations
  → Trivy scan; fail on HIGH or CRITICAL
  → SPDX SBOM asset
  → Cosign keyless signature by digest
  → signature verification
  → promote the already-scanned digest to release tags
  → GitHub release with SBOM and digest list
```

The workflows are:

- `.github/workflows/release.yml` — build, scan, sign, attest, publish.
- `.github/workflows/security-scan.yml` — weekly dependency audit and container
  rescan of `latest`.

All third-party actions are pinned by full commit SHA. The release job has
`contents: write`, `packages: write`, `id-token: write`, and
`attestations: write`; the build job has only the permissions it needs. No
release workflow runs on a pull request, so untrusted code never receives the
signing identity.

## Publish an alpha

```bash
gh workflow run release.yml \
  -f mode=alpha \
  -f version=v0.1.0-alpha.1
```

The resulting image is labelled not for production. Do not put it in front of
real secrets.

## Publish a production release

1. Complete the external review in [`external-review.md`](external-review.md).
2. Update `Status: Approved`, `Release: v0.1.0`, `Commit: <reviewed SHA>`,
   `Reviewer: <name>`, `Open Critical: 0`, and `Open High: 0`.
3. Run the local gates and merge the approval commit to `main`.
4. Create and push the tag:

```bash
git tag -s v0.1.0 -m "OpenVault v0.1.0"
git push origin v0.1.0
```

5. Watch the release workflow and verify the digest in the release notes.

## Verify an image

```bash
IMAGE=ghcr.io/blendsdk/openvault@sha256:<digest>
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github.com/blendsdk/openvault/.github/workflows/release.yml@refs/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

docker buildx imagetools inspect "$IMAGE"
docker pull "$IMAGE"
```

The SBOM and digest list are attached to the GitHub release. The image also
carries BuildKit SBOM and provenance attestations; inspect them with
`docker buildx imagetools inspect` or `cosign download attestation`.

## Rescan

The weekly `Security scans` workflow runs `pnpm audit:prod`, `pnpm audit:full`,
and Trivy against the published `latest` images. A HIGH or CRITICAL finding
fails the run. The release gate checks the scan at release time; the schedule
covers CVEs disclosed afterwards.

## Branch protection

The `main` branch requires a pull request, strict status checks, linear history,
no force pushes, no deletion, conversation resolution, and applies to admins.
The current checks are `Verify`, `Gitleaks`, `CodeQL`, `Integration (16)`,
`Integration (17)`, `Audit`, and `Review dependency changes`. The evidence is
recorded in [`release-evidence.md`](release-evidence.md).

## What is not automated

- The independent external review is a human engagement.
- The production tag is a deliberate operator action.
- A real-browser accessibility pass is a release-candidate manual check; the
  automated axe suite runs in jsdom.

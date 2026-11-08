# Release process

## Labels

| Label | Trigger | Image tags | OCI label |
|---|---|---|---|
| Alpha | Explicit `workflow_dispatch` | `alpha`, `sha-<12>` | `not-for-production=true` |
| Production | Deliberate `v*.*.*` tag push or tagged dispatch | `v0.1.0`, `0.1.0`, `latest`, `sha-<12>` | `production=true` |

A production tag is any push matching `v*.*.*`. Creating that tag is the
deliberate operator approval. The release workflow validates the mode and tag,
then builds, scans, signs, and publishes. It does not call a Codex Security
approval gate.

## Pipeline

```text
tag v0.1.0 (or alpha dispatch)
  → release metadata validation
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

1. Optionally run the OpenAI Codex Security scan manually on the release-candidate
   commit. It is advisory and does not block the release. See
   [`external-review.md`](external-review.md).
2. Run the local gates and merge the release commit to `main`.
3. Create and push the tag on the release commit:

```bash
git tag -a v0.1.0 -m "OpenVault v0.1.0"
git push origin v0.1.0
```

4. Watch the release workflow and verify the digest in the release notes.

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
fails the run. The release pipeline runs Trivy on the new image before
promotion; the schedule covers CVEs disclosed afterwards.

## Branch protection

The `main` branch requires a pull request, strict status checks, linear history,
no force pushes, no deletion, conversation resolution, and applies to admins.
The current checks are `Verify`, `Gitleaks`, `CodeQL`, `Integration (16)`,
`Integration (17)`, `Audit`, and `Review dependency changes`. The evidence is
recorded in [`release-evidence.md`](release-evidence.md).

## What is not automated

- The production tag is a deliberate operator action.
- The OpenAI Codex Security scan is a manual, periodic check. It needs a
  specific runtime environment that is not available in CI/CD, so it is not a
  workflow step and not a release blocker.
- A real-browser accessibility pass is a release-candidate manual check; the
  automated axe suite runs in jsdom.

Use `git tag -s` instead of `git tag -a` when a release signing key is configured. The
mandatory release signature is the Cosign keyless signature on the image, not the Git tag.

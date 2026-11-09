# Release process

## Labels

| Label | Trigger | Image tags | OCI label |
|---|---|---|---|
| Alpha | Explicit `workflow_dispatch` | `alpha`, `sha-<12>` | `not-for-production=true` |
| Production | Deliberate `v*.*.*` tag push or tagged dispatch | `v1.2.0`, `1.2.0`, `latest`, `sha-<12>` | `production=true` |

A production tag is any push matching `v*.*.*`. Creating that tag is the
deliberate operator approval. The release workflow validates the mode and tag,
then builds, scans, signs, and publishes. It does not call a Codex Security
approval gate.

## Pipeline

```text
tag v1.2.0 (or pre-release dispatch)
  → release metadata validation
  → build amd64 and arm64 images to staging tags
  → BuildKit SBOM and max provenance attestations
  → Trivy scan; fail on HIGH or CRITICAL
  → BuildKit SBOM attestation
  → Cosign keyless signature by digest
  → signature verification
  → promote the already-scanned digest to release tags
  → GitHub release with SBOM and digest list
```

The workflows are:

- `.github/workflows/release.yml` — build, scan, sign, attest, publish.
- `.github/workflows/security-scan.yml` — weekly dependency audit and container
  rescan of `latest`.

Images are published to Docker Hub under `blendsdk`. All third-party actions
are pinned by full commit SHA. The release job has `contents: write`; the build
job has `contents: read`, `id-token: write`, and `attestations: write`. Registry
credentials come from the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository
secrets. No release workflow runs on a pull request, so untrusted code never
receives the signing identity.

## Publish a pre-release

```bash
gh workflow run release.yml \
  -f mode=alpha \
  -f version=v1.3.0-alpha.1
```

The resulting image is labelled not for production. Pre-releases are for
testing and do not carry the v1 compatibility promise.

## Publish a production release

1. Optionally run the OpenAI Codex Security scan manually on the release-candidate
   commit. It is advisory and does not block the release. See
   [`external-review.md`](external-review.md).
2. Run the local gates and merge the release commit to `main`.
3. Create and push the tag on the release commit:

```bash
git tag -a v1.2.0 -m "OpenVault v1.2.0"
git push origin v1.2.0
```

4. Watch the release workflow and verify the digest in the release notes.

## Verify an image

```bash
IMAGE=docker.io/blendsdk/openvault@sha256:<digest>
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github.com/blendsdk/openvault/.github/workflows/release.yml@refs/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

docker buildx imagetools inspect "$IMAGE"
docker pull "$IMAGE"
```

The image carries BuildKit SBOM and provenance attestations; inspect them with
`docker buildx imagetools inspect` or `cosign download attestation`. The digest
list is attached to the GitHub release.

## Rescan

The weekly `Security scans` workflow runs `pnpm audit:prod`, `pnpm audit:full`,
and Trivy against the published `latest` image. A HIGH or CRITICAL finding
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

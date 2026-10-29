# RD-14: Security Assurance and Release

> **Document**: RD-14-security-release.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: All prior RDs
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the evidence and release controls that make the security claims
credible: a threat-model-to-test matrix, specification tests, security tests, independent
review gates, an external review at release candidate, a signed amd64 image, SBOM, image
scanning, provenance, SHA-pinned actions, branch protection, and a docs-accuracy gate.

## Functional Requirements

### Must Have

- [ ] A threat-model-to-test matrix maps every threat-model row to at least one automated test
  or a documented manual check.
- [ ] Every security-sensitive behavior has a `*.spec.test.ts` derived from the RDs and
  written before implementation.
- [ ] Security tests cover: authorization matrix, service-identity ceiling, injection,
  path traversal, oversized bodies, rate limits, CSRF, session rotation, token reuse, mTLS
  rejection, audit tamper, redaction, tmpfs isolation, and no-value leakage.
- [ ] A `security-auditor` gate runs on auth, crypto, audit, agent, and deploy phases; a
  `design-challenger` reviews the auth/crypto design.
- [ ] An independent external review of crypto, auth/session, agent isolation, and deploy
  happens at release candidate before the production-labelled v0.1.
- [ ] A signed amd64 image is published only after all gates pass.
- [ ] The image has an SBOM and provenance attestation.
- [ ] Trivy or Grype scans the image at release and on a schedule; high/critical findings block
  a production label.
- [ ] GitHub Actions are pinned to full commit SHAs; workflow permissions are least privilege;
  checkout does not persist credentials.
- [ ] Branch protection requires pull request, green checks, linear history, and no force
  pushes.
- [ ] The docs-accuracy gate ensures every security claim is either implemented with a test
  link or explicitly labelled planned.
- [ ] A security incident runbook covers revocation, key rotation, session invalidation,
  backup restore, and disclosure.
- [ ] No production image is published before the gates; the repo may publish alpha images
  explicitly labelled not for production.

### Should Have

- [ ] Cosign verification instructions in the install guide.
- [ ] A scheduled dependency audit and container rescan.
- [ ] A public security advisory template.

### Won't Have (Out of Scope)

- Multi-arch images.
- Full-product external review of UI copy and docs.
- SOC 2 or ISO 27001 certification.
- Bug bounty program.

## Technical Requirements

### Evidence matrix

| Control | Evidence |
|---|---|
| Envelope encryption | Crypto spec tests, fixed vector, external review |
| Keyring custody | File permission test, serialization redaction test, rotation test |
| Browser auth | Local/OIDC spec tests, CSRF tests, cookie flags |
| CLI auth | JWT/refresh/reuse tests |
| Agent identity | Join/renew/revoke tests, mTLS rejection matrix |
| RBAC | 9 roles × 25 actions × scopes matrix |
| Audit | Tamper, truncation, checkpoint, fail-closed tests |
| Secrets | Limits, versions, soft delete, purge protection, no-value-leak tests |
| Certificates | Key match, private-key split, AAD domain separation |
| Agent delivery | Cross-project tmpfs isolation, atomic write, revocation |
| Deployment | Non-root, cap drop, read-only rootfs, network isolation tests |
| Supply chain | SHA pins, SBOM, scan, signature, provenance |

### Release pipeline

```text
tag v0.1.0
  → build amd64 image from pinned base digests
  → generate SBOM (Syft or Buildx)
  → scan (Trivy/Grype); fail on high/critical
  → sign (cosign keyless)
  → attest provenance
  → publish GHCR by digest and tag
  → create GitHub release with notes, SBOM, digest, verification command
```

### Review gates

| Phase | Gate |
|---|---|
| Requirements | Zero-Ambiguity Gate passed; preflight no unresolved Critical/Major |
| Crypto/keyring | `security-auditor` + `design-challenger` + external review |
| Auth/session | `security-auditor` + `correctness-reviewer` |
| Audit | `security-auditor` + tamper tests |
| Agent/deploy | `security-auditor` + `concurrency-auditor` |
| Release candidate | External review findings resolved or explicitly accepted |
| Production label | All gates green; signed image; docs accuracy |

## Integration Points

- All prior RDs supply behavior and tests.
- RD-01 supplies CI.
- RD-02 supplies transport.
- RD-07 supplies audit evidence.
- RD-10 supplies agent isolation.
- RD-13 supplies deployment and backup.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| External review | None / scoped / full | Scoped at RC | Independent check without full-product cost | AR-7 |
| Image architecture | amd64 / multi-arch | amd64 | Security value over compatibility | AR-23 |
| Signing | None / cosign keyless | cosign keyless | Bind image to workflow identity | AR-23 |
| Scanning | One-time / release + scheduled | Release + scheduled rescan | New CVEs appear after release | AR-23 |
| Reviewers | Two everywhere / one + challenger | One security-auditor + design-challenger | Reduce correlated review | AR-18 |
| Alpha fallback | No image / alpha label | Alpha label allowed before external review | Honest early access | AR-7 |

## Security Considerations

- **Data sensitivity:** evidence artifacts may include logs and test fixtures; no real
  secrets.
- **Input validation:** release inputs are commit/tag metadata; no user input.
- **Authentication & authorization:** release workflow uses OIDC and least privilege.
- **Injection risks:** no untrusted PR code in a privileged release workflow.
- **Encryption needs:** signing keys in GitHub OIDC; no long-lived signing secret.
- **Rate limiting:** N/A.
- **Infrastructure:** pinned actions, pinned base images, isolated build, SBOM, scan.

## Acceptance Criteria

1. [ ] The threat-model-to-test matrix has no unaddressed row.
2. [ ] Every security-sensitive RD has at least one `*.spec.test.ts`; the suite fails if the
   test file is removed.
3. [ ] The authorization matrix, crypto tamper, audit tamper, CSRF, token reuse, mTLS
   revocation, and cross-project tmpfs tests pass.
4. [ ] A `security-auditor` report exists for each security-sensitive phase with no unresolved
   Critical/Major finding.
5. [ ] The external review report is attached; every Critical/High finding is fixed or
   explicitly accepted with rationale.
6. [ ] The release image is amd64, signed with cosign keyless, has an SBOM, and verifies with
   the documented command.
7. [ ] Trivy/Grype reports no high or critical finding at release; the scheduled rescan is
   configured.
8. [ ] GitHub Actions are SHA-pinned; workflow permissions are least privilege; branch
   protection is enabled.
9. [ ] Every security claim in README/docs is implemented with a test link or labelled
   planned.
10. [ ] The incident runbook covers revocation, rotation, session invalidation, restore, and
    disclosure.
11. [ ] No production-labelled image exists before the external review gate.
12. [ ] Security requirements verified: evidence, review, signature, scan, provenance.

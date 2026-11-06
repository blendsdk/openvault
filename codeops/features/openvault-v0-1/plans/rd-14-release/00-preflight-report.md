# Preflight Report: RD-14 Release Assurance

> **Status**: ✅ PASS — no unresolved Critical or Major finding
> **Date**: 2026-11-06 18:00
> **Scope**: RD-14 requirements against `main` at `cae3197`

## Method

Read the RD-14 requirement, the threat model, the CI workflows, the security test inventory,
the docs, and the repository settings through the GitHub API. Checked action pinning, branch
protection, and the current release surfaces.

## Findings

| ID | Severity | Finding | Evidence | Resolution |
|---|---|---|---|---|
| PF-14-01 | Major | There is no threat-model-to-test matrix and no machine check that every threat has evidence. | `docs/security/threat-model.md` is prose only | Task 1.1 adds the ledger, generator, and checker. |
| PF-14-02 | Major | No release workflow builds, scans, signs, or attests an image. | `.github/workflows/` has CI, CodeQL, dependency review, docs, and secret scan only | Task 2.1 adds the release pipeline. |
| PF-14-03 | Major | No production-label gate exists, so a tag could publish an un-reviewed image. | No release workflow | Task 2.1 adds a fail-closed external-review check and an alpha-only override. |
| PF-14-04 | Major | No container rescan runs after release. | No container workflow | Task 2.2 adds a weekly Trivy rescan. |
| PF-14-05 | Major | The docs contain stale claims: the keyring is described as plaintext "until age support lands", the reference stack as "not bootable", and the scaffold CLI as future work. | `docs/security/threat-model.md` accepted risks, `deploy/compose/README.md:3-5,60-67`, `docs/guide/docker-compose.md:3-5` | Task 3.1 adds the claims ledger and updates the pages. |
| PF-14-06 | Major | There is no incident response runbook. | `docs/security/reporting.md` only covers disclosure | Task 3.2 adds revocation, rotation, session invalidation, restore, and disclosure procedures. |
| PF-14-07 | Minor | Branch protection is enabled but not recorded as evidence. | GitHub API shows PR required, strict checks, linear history, no force pushes, no deletions | Task 3.3 records the API evidence. |
| PF-14-08 | Minor | Internal review reports are not stored per security-sensitive phase. | No `reviews/` directory under a plan | Task 1.3 runs and stores reviewer reports. |
| PF-14-09 | Minor | The external review cannot be performed inside this repository. | No reviewer identity or engagement | Packet and approval file; production publish remains an operator gate. |
| PF-14-10 | Info | The existing CI already pins every action by SHA and uses least-privilege permissions. | `.github/workflows/*.yml` | Preserve the pattern in new workflows. |

## Security Review Notes

- Release workflows run only on tags or manual dispatch, never on untrusted pull requests.
- Production labels require a committed approval file; the check runs before any push or sign.
- The SBOM and provenance are attached to the image and the GitHub release.
- The incident runbook distinguishes credential revocation from value rotation.

## Verdict

No unresolved Critical or Major finding. The external review is an operator-provided gate,
not a repository task; the release workflow enforces it. The plan is ready to execute.

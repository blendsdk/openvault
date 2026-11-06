# Current State: RD-14 Release Assurance

> **Snapshot**: `main` at `cae3197`, 2026-11-06

## What Exists

| Area | State |
|---|---|
| Specification tests | 89 integration files and 696 tests on PostgreSQL 16/17, plus unit suites for every app and package. |
| Security tests | Authorization matrix, CSRF, cookie flags, token rotation and reuse, mTLS rejection, audit tamper, redaction, tmpfs isolation, oversized bodies, rate limits, injection, and no-value leakage. |
| CI | `Verify`, `Audit`, `Integration (16/17)`, CodeQL, dependency review, docs build, and Gitleaks. Every action uses a full commit SHA. |
| Branch protection | PR required, strict status checks, linear history, no force push, no deletion, enforce admins. |
| Release | No release workflow, no Dockerfile, no signed image, no SBOM, no container scan. |
| Evidence | Threat model and limitations are prose; no matrix or checker. |
| Docs | Several pages still describe RD-11/RD-12 work as future or the keyring as plaintext. |
| Incident response | Disclosure policy exists; revocation/rotation/restore runbook does not. |

## Gaps Closed by This Plan

1. Machine-readable threat-model evidence with generated docs.
2. Required spec-test coverage per security-sensitive RD.
3. Stored internal review reports.
4. External-review packet and production gate.
5. Release workflow with amd64 build, SBOM, provenance, Trivy, and Cosign.
6. Weekly container rescan.
7. Docs-accuracy ledger and checker.
8. Incident response runbook.
9. Release verification instructions.
10. Branch-protection evidence.

## Constraints

- No production image may be published during this work. Only an alpha image is allowed, and
  it must be labelled not for production.
- The release workflow cannot be fully executed here without a tag, registry credentials, and
  an external review. YAML syntax and the gate script are tested locally; the workflow steps
  are pinned and reviewable.
- The external review is the only item that cannot be completed by repository work alone.

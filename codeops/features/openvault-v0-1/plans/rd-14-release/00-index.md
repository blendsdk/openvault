# RD-14 Release Assurance Implementation Plan

> **Feature**: Threat-model evidence, security review gates, signed release pipeline, SBOM, scanning, provenance, branch protection, and release documentation.
> **Status**: Done
> **Created**: 2026-11-06 18:00
> **Completed**: 2026-11-06 18:30
> **Preflight**: [00-preflight-report.md](00-preflight-report.md)
> **Implements**: openvault-v0-1/RD-14
> **CodeOps Artifact Schema**: 1

## Overview

The codebase already carries a large specification test suite: authorization, auth, CSRF,
token reuse, mTLS, audit tamper, redaction, tmpfs, and secret-value leakage all have tests.
What is missing is the evidence layer that proves the mapping, the release workflow that
turns the source into a signed and scanned image, and the docs-accuracy gate that prevents
claims from drifting ahead of behavior.

This plan adds a machine-checked evidence matrix, release and rescan workflows, a production
label gate, a review report set, and an incident runbook. The external review itself is an
operator-provided independent review; the repository prepares the packet and refuses a
production label until an approval file exists.

## Minimum-Sufficient Baseline

**Original goal:** a reviewer can follow every security claim to a test or a documented manual
check, and an operator can verify a signed release image.

**Smallest viable design:** one JSON evidence ledger rendered to docs and checked in `verify`;
one release workflow that builds amd64 images, attests SBOM/provenance, scans, signs, and
publishes; one scheduled rescan; one docs-claims checker; review reports under the plan.

**Excluded machinery:** multi-arch images, SOC 2, bug bounty, full-product external review,
and a custom signing service.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-14 |
| 02 | [Current State](02-current-state.md) | Existing tests, CI, and gaps |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Release Gate

A production-labelled image is published only when all of the following are true:

1. `pnpm verify` passes and the evidence checker reports no missing row.
2. The security review reports under `codeops/features/openvault-v0-1/plans/rd-14-release/reviews/`
   have no open Critical or High finding.
3. `docs/security/external-review.md` records an approved independent review for the release
   candidate, or the release is explicitly dispatched as `alpha` with the not-for-production
   label.
4. Trivy reports no HIGH or CRITICAL finding.
5. Cosign keyless signing and provenance attestation succeed.

The workflow fails closed when the external-review file is absent or not approved.

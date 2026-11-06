# Execution Plan: RD-14 Release Assurance

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Status**: Done
> **Last Updated**: 2026-11-06 18:30
> **Progress**: 32/32 tasks (100%)

> **Rule:** one task at a time. Mark `[x]` only after the task verifies, update the Progress
> header after every task, and record a finding in [05-findings.md](05-findings.md) when
> reality diverges from the plan.

**Total: 32 tasks across 4 phases**

---

## Phase 1: Evidence

> **Reasoning**: high — review claims must be traceable to executable evidence.

### Step 1.1: Evidence ledger

- [x] 1.1.1 Add `docs/security/evidence-matrix.json` covering every threat row, the named security categories, and a required spec file per security-sensitive RD
- [x] 1.1.2 Add `scripts/security-evidence.mjs` to validate test names, required specs, and manual-check links, and to generate/write the Markdown page
- [x] 1.1.3 Add `docs/security/evidence-matrix.md` and wire the checker into `pnpm verify` and CI

**Verify**: `pnpm security:evidence:check`

### Step 1.2: Claims ledger

- [x] 1.2.1 Add `docs/security/claims.json` with implemented and planned security claims, evidence links, and status
- [x] 1.2.2 Add `scripts/security-claims.mjs` to validate evidence and publish the docs page
- [x] 1.2.3 Wire the claims checker into `pnpm verify`

**Verify**: `pnpm security:claims:check`

### Step 1.3: Review gates

- [x] 1.3.1 Run an independent security review of auth, crypto, and audit and store the report
- [x] 1.3.2 Run an independent design challenge of the auth/crypto design and store the report
- [x] 1.3.3 Run an independent correctness/concurrency review of agent, deployment, and operations changes and store the report
- [x] 1.3.4 Add `docs/security/review-gates.md` summarizing scope, status, and open findings

**Verify**: every report has a verdict line and no unresolved Critical/High finding

---

## Phase 2: Release Pipeline

> **Reasoning**: high — signing and publishing are the supply-chain boundary.

### Step 2.1: Release workflow

- [x] 2.1.1 Add a release workflow for amd64 server, agent, and web images with pinned actions, least-privilege permissions, BuildKit SBOM/provenance, Syft SPDX, Trivy HIGH/CRITICAL gate, Cosign keyless signing, digest output, and GitHub release assets
- [x] 2.1.2 Add `scripts/check-release-gate.mjs` and make production tags fail closed without an approved external-review file
- [x] 2.1.3 Add alpha-only manual dispatch with explicit not-for-production labels

**Verify**: parse the YAML and run the gate script against both alpha and production fixtures

### Step 2.2: Scheduled rescan

- [x] 2.2.1 Add a weekly Trivy workflow for the published image tags
- [x] 2.2.2 Add a scheduled dependency audit and document the rescan policy

**Verify**: workflow YAML parses and every action is SHA-pinned

### Step 2.3: Release documentation

- [x] 2.3.1 Add `docs/security/release-process.md` with the gate, tag, SBOM, digest, and verification commands
- [x] 2.3.2 Add Cosign verification to the install guide
- [x] 2.3.3 Add the external-review packet and approval-file instructions

**Verify**: `pnpm docs:build`

---

## Phase 3: Security Operations and Docs Accuracy

> **Reasoning**: high — an incident runbook is only useful if it matches the shipped controls.

### Step 3.1: Incident runbook

- [x] 3.1.1 Add `docs/security/incident-response.md` covering disclosure, identity/certificate revocation, browser and CLI session invalidation, KEK rotation, value rotation, backup restore, and evidence preservation
- [x] 3.1.2 Link it from the security reporting page, README, and sidebar

**Verify**: every procedure references a real command or route

### Step 3.2: Documentation correction

- [x] 3.2.1 Update the threat model, limitations, Compose, install, README, and changelog to match the shipped behavior
- [x] 3.2.2 Remove or label every stale "deferred", "not bootable", and "not implemented" security claim
- [x] 3.2.3 Add the new pages to the VitePress sidebar

**Verify**: `pnpm docs:build && pnpm security:claims:check`

### Step 3.3: Branch-protection and release evidence

- [x] 3.3.1 Record the GitHub branch-protection API evidence in the release evidence document
- [x] 3.3.2 Add a release checklist that names the external review, alpha label, scan, signature, and SBOM checks
- [x] 3.3.3 Add the public security advisory template

**Verify**: evidence document links are valid and the checklist matches the workflow steps

---

## Phase 4: Verification and Delivery

> **Reasoning**: high — the release evidence must be reproducible.

### Step 4.1: Final verification

- [x] 4.1.1 Run `pnpm verify`, docs build, and PostgreSQL 16/17 integration
- [x] 4.1.2 Run the evidence, claims, Compose, and release-gate checks
- [x] 4.1.3 Review the workflows for untrusted-code execution and secret exposure

**Verify**: all gates green

### Step 4.2: Delivery

- [x] 4.2.1 Update findings, roadmap, changeset, and plan status
- [x] 4.2.2 Commit, open a pull request, and pass CI
- [x] 4.2.3 Squash-merge and delete the branch

**Verify**: `gh pr checks <number> --watch` and a clean `main`

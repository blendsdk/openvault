# Security Findings Remediation Implementation Plan

> **Feature**: Fix the six confirmed security findings in issues #39–#44.
> **Status**: Complete
> **Created**: 2026-11-06 19:19
> **Completed**: 2026-11-06 20:52
> **Implements**: openvault-v0-1/RD-14
> **CodeOps Artifact Schema**: 1

## Overview

A scanner review at revision `6ed6396ce613299707b149638515c7ab1c150992` reported six findings. All six mechanisms were reproduced against the real services and a disposable PostgreSQL database. The findings cover the runtime database trust boundary, JWT signing-key import, privileged Compose preparation, OIDC endpoint trust, purge evidence ordering, and name enumeration.

This plan fixes each root cause, adds regression tests that prove the attack path is closed, and updates the security documentation so the remaining limitations are explicit. The work is intentionally split into six independently verifiable phases; each phase follows specification tests → implementation → implementation tests and full verification.

## Minimum-Sufficient Baseline

**Original goal:** remove the six confirmed security findings without introducing a new framework, dependency, or generalized security subsystem.

**Smallest viable design:**

- #41: a dedicated PostgreSQL control-plane role and a second connection pool for auth/RBAC/identity/agent-identity writes; no new service or framework.
- #39: unwrap and compare the previous signing seed; one schema trigger for immutable key lifecycle fields.
- #40: symlink rejection and atomic file creation in the existing shell script.
- #42: one validated origin allowlist in the existing OIDC client; disable redirects.
- #43: move the authorization event before the delete and add a completion event; keep the existing audit chain.
- #44: one collection-visibility helper used by existing name-addressed routes.

**Excluded machinery:** a KEK-keyed row-integrity MAC layer, a purge outbox table and worker, a general policy engine, a new test framework, and a new service. The auth role is a direct PostgreSQL privilege control required by the finding.

**Approved complexity:** none beyond the direct PostgreSQL role separation recorded in AR-2…AR-5. It is a direct privilege control, not a generalized layer.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Plan-local requirements and scope |
| 02 | [Current State](02-current-state.md) | Existing implementation and gaps |
| 03-01 | [Database Auth Boundary](03-01-database-auth-boundary.md) | #41 control-plane role and connection |
| 03-02 | [Signing Key Integrity](03-02-signing-key-integrity.md) | #39 previous-key authentication |
| 03-03 | [Prepare Symlink Safety](03-03-prepare-symlink-safety.md) | #40 filesystem hardening |
| 03-04 | [OIDC Endpoint Trust](03-04-oidc-endpoint-trust.md) | #42 endpoint allowlist |
| 03-05 | [Purge Evidence](03-05-purge-evidence.md) | #43 intent-first audit |
| 03-06 | [Name Enumeration](03-06-name-enumeration.md) | #44 collection visibility |
| 05 | [Findings Ledger](05-findings.md) | Post-phase quality review rulings |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Auth trust boundary | Separate `openvault_auth` role and `OPENVAULT_AUTH_DB_URL`; app role loses DML on eight control-plane tables, including agent identity | AR-2…AR-5 |
| Previous signing key | Unwrap seed, derive public key, compare; immutable lifecycle trigger | AR-6, AR-7 |
| Prepare script | Reject symlinks, atomic create, explicit ownership checks | AR-8 |
| OIDC trust | Default issuer-origin allowlist, explicit multi-origin override, redirects disabled | AR-9 |
| Purge evidence | Allow event before delete; completion after; update limitation | AR-10 |
| Enumeration | Collection-visibility rule; 403 only when the caller can list | AR-11 |

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| security-auditor | reviewer (generic packet) | Phase 1 and Phase 4 post-phase review: auth boundary, OIDC trust | AR-2, AR-9 |
| correctness-reviewer | reviewer (generic packet) | Every phase diff: failure paths, tests, compatibility | AR-1 |

_Detection evidence: no project-local specialist agent files exist under `codeops/specialists/`; the repository’s quality profile supplies the generic reviewer contracts. The independent external review remains the RD-14 release gate and is not replaced by these reviews._

## Related Files

- `deploy/postgres/grants.sql`, `deploy/postgres/roles.sql`, `deploy/postgres/init-roles.sh`
- `deploy/compose/prepare.sh`, `deploy/compose/compose.yaml`
- `apps/server/src/config/loader.ts`, `apps/server/src/config/types.ts`, `apps/server/src/main.ts`, `apps/server/src/app.ts`
- `apps/server/src/auth/`, `apps/server/src/rbac/`, `apps/server/src/identity/`
- `apps/server/src/security/signing-keys.ts`, `apps/server/src/database/schema.ts`, `apps/server/migrations/`
- `apps/server/src/auth/oidc/client.ts`
- `apps/server/src/secrets/service.ts`, `apps/server/src/certificates/lifecycle.ts`
- `apps/server/tests/integration/`, `apps/server/tests/auth/`
- `docs/security/limitations.md`, `docs/security/threat-model.md`, `docs/reference/api.md`, `docs/reference/configuration.md`

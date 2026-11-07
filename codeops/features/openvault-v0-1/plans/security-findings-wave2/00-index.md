# Security Findings Wave 2 Implementation Plan

> **Feature**: Fix the seven confirmed scanner findings in issues #46–#52.
> **Status**: Planning Complete
> **Created**: 2026-11-07 01:46
> **Implements**: openvault-v0-1/RD-14
> **CodeOps Artifact Schema**: 1

## Overview

A fresh Codex Security scan at revision `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a` reported seven findings: two High, three Medium, and two Low. All seven were verified against the current code. They cover CLI credential origin binding, audit-prune database authority, secret-read audit ordering, join-token clipboard retention, data-plane read access to authentication verifiers, scaffold project-name enumeration, and browser-session successor recovery.

This plan fixes each root cause, adds regression tests that prove the attack path is closed, and updates the threat model, limitations, reference docs, and evidence matrix.

## Minimum-Sufficient Baseline

**Original goal:** remove the seven confirmed findings without weakening the threat model or adding a generalized security subsystem.

**Smallest viable design:**

- #46: one shared origin comparison in the CLI; no new transport.
- #47: one authorization table, one receipt table, and one `SECURITY DEFINER` procedure in the existing audit chain.
- #48: move one audit write after decrypt and add the existing error-event path.
- #50: explicit per-table grants, one restricted view, and one dedicated read-only backup role.
- #49: one credential mode on the existing copy component.
- #51: the collection-visibility rule already used by secrets and certificates.
- #52: one hashed CSRF proof added to the existing ten-second receipt.

**Excluded machinery:** a new queue, broker, workflow engine, policy engine, test framework, or service. No new dependency.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Plan-local requirements and scope |
| 02 | [Current State](02-current-state.md) | Existing implementation and gaps |
| 03-01 | [CLI Origin Binding](03-01-cli-origin-binding.md) | #46 |
| 03-02 | [Audit Prune Procedure](03-02-audit-prune-procedure.md) | #47 |
| 03-03 | [Secret Read Audit](03-03-secret-read-audit.md) | #48 |
| 03-04 | [App Role Least Privilege](03-04-app-role-least-privilege.md) | #50 |
| 03-05 | [Join Token Clipboard](03-05-join-token-clipboard.md) | #49 |
| 03-06 | [Scaffold Visibility](03-06-scaffold-visibility.md) | #51 |
| 03-07 | [Session Rotation Proof](03-07-session-rotation-proof.md) | #52 |
| 05 | [Findings Ledger](05-findings.md) | Post-phase quality rulings |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Doctor credential binding | Shared origin helper; no bearer to an override origin | AR-3 |
| Pruner authority | Single-use authorization + definer procedure; pruner `EXECUTE` only | AR-4, AR-5 |
| Secret read evidence | Allow after decrypt/encode; error event on every failure | AR-6 |
| App-role reads | Explicit allowlist + restricted consumer view + backup role | AR-7, AR-8 |
| Join-token clipboard | 30-second best-effort clear that survives dialog close | AR-9 |
| Scaffold visibility | Collection-visibility rule; uniform hidden/missing 404 | AR-10 |
| Rotation receipt | Pre-rotation CSRF hash as second proof; single use | AR-11 |

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| security-auditor | reviewer (generic packet) | Database authority, credential handling, session proof | AR-4, AR-7, AR-11 |
| correctness-reviewer | reviewer (generic packet) | Every phase diff: failure paths, tests, compatibility | AR-1 |

_Detection evidence: no project-local specialist agent files exist under `codeops/specialists/`; the repository quality profile supplies the generic reviewer contracts. The independent external review remains the RD-14 release gate._

## Related Files

- `apps/cli/src/commands/doctor.ts`, `apps/cli/src/client/authenticated.ts`
- `apps/server/src/audit/audit-prune.ts`, `prune-connection.ts`, `cli.ts`, `audit-verify.ts`
- `apps/server/src/secrets/service.ts`, `repository.ts`
- `apps/server/src/certificates/service.ts`
- `apps/server/src/scaffold/service.ts`
- `apps/server/src/auth/sessions.ts`, `apps/server/src/controllers/auth.ts`
- `apps/web/src/components/copy.tsx`, `apps/web/src/pages/identities-page.tsx`
- `apps/server/src/database/schema.ts`, `apps/server/migrations/`
- `deploy/postgres/grants.sql`, `roles.sql`, `init-roles.sh`, `ensure-*.sql`, `deploy/compose/`
- `apps/server/tests/`, `apps/cli/tests/`, `apps/web/tests/`
- `docs/security/`, `docs/reference/`, `docs/guide/`

# Findings Ledger: RD-10 Agent Delivery and Compose

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Open — execution reviews pending
> **Last Updated**: 2026-11-05 10:20
> **CodeOps Artifact Schema**: 1

## Purpose

This ledger records post-phase correctness and security/concurrency review findings, their
rulings, and accepted residuals. It is updated during Phase 5 of the
[execution plan](99-execution-plan.md).

## Planning-Stage Findings

The planning-stage preflight findings and resolutions are recorded in
[00-preflight-report.md](00-preflight-report.md) and are not duplicated here.

## Execution Findings

| ID | Review | Phase | Severity | Finding | Ruling | Status |
|---|---|---|---|---|---|---|
| — | — | — | — | No execution review has run yet | — | Pending |

## Accepted Residuals (to confirm during Phase 5)

| ID | Residual | Reason | Documentation target |
|---|---|---|---|
| RR-01 | Wrapper same-UID trust exposes the state directory and private key to the wrapped application | RD-10 mandates same-UID wrapper mode; sidecar is the secure default | `docs/security/limitations.md` |
| RR-02 | Expired client certificates cannot update consumer state before authentication | Middleware rejects before a principal exists; renewal prevents expiry | `docs/security/limitations.md` |
| RR-03 | A network failure leaves consumer state stale until the next successful fetch/heartbeat | The server cannot observe an unreachable agent | `docs/security/limitations.md` |
| RR-04 | Renewal replay is not durable across a server restart | RD-05's replay cache is process-local | `docs/security/limitations.md` |
| RR-05 | The shared consumer contract accepts arbitrary 1–100 character Compose names | Upstream RD-05 contract; the agent validates its own values | `docs/security/limitations.md` |
| RR-06 | The agent image is not published by this plan | RD-14 owns image build/signing/publishing | `docs/changelog.md`, deployment docs |

## Verification Evidence

| Gate | Result | Date |
|---|---|---|
| Planning preflight | Passed after revision | 2026-11-05 |
| `pnpm verify` | Pending execution | — |
| `pnpm db:types:check` | Pending execution | — |
| `pnpm changeset status` | Pending execution | — |
| `pnpm audit:prod` | Pending execution | — |
| Docs build | Pending execution | — |
| Integration, PostgreSQL 16 | Pending execution | — |
| Integration, PostgreSQL 17 | Pending execution | — |
| Correctness review | Pending execution | — |
| Security/concurrency review | Pending execution | — |

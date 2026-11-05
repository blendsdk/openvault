# Findings Ledger: RD-11 CLI

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Open — execution reviews pending
> **Last Updated**: 2026-11-05 15:35
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
| RR-01 | Native Windows credential store fails closed | Node cannot enforce an owner-only ACL without an untested external command | `docs/security/limitations.md` |
| RR-02 | Backup/restore/KEK rotate are gated on RD-13 | RD-13 owns the archive, restore, and rewrap operations | `docs/guide/cli.md`, roadmap |
| RR-03 | Bootstrap password is not force-changed in v0.1 | No CLI password-change route and RD-12 is not available | `docs/security/limitations.md` |
| RR-04 | `api:check` does not detect a controller schema change alone | The table is the schema source; command E2E tests catch drift | `docs/architecture/overview.md` |
| RR-05 | Scaffold serialization is in-process | RD-10 single-node decision | RD-10 ledger |
| RR-06 | Proxy and internal CA files must be kept distinct | Caddy uses its own root CA for `https://localhost` | `docs/guide/cli.md` |
| RR-07 | `ov run` uses a CLI-specific manifest | It avoids a service identity and join token | `docs/guide/cli.md` |

## Verification Evidence

| Gate | Result | Date |
|---|---|---|
| Planning preflight | Passed after revision | 2026-11-05 |
| `pnpm verify` | Pending execution | — |
| `pnpm api:check` | Pending execution | — |
| `pnpm db:types:check` | Pending execution | — |
| `pnpm changeset status` | Pending execution | — |
| `pnpm audit:prod` | Pending execution | — |
| Docs build | Pending execution | — |
| Integration, PostgreSQL 16 | Pending execution | — |
| Integration, PostgreSQL 17 | Pending execution | — |
| Correctness review | Pending execution | — |
| Security/concurrency review | Pending execution | — |

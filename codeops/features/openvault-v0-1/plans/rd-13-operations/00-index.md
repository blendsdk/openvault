# RD-13 Operations Implementation Plan

> **Feature**: Backup, rotation, deployment hardening, least-privilege roles, and scheduled off-box recovery evidence.
> **Status**: Done
> **Created**: 2026-11-06 18:00
> **Completed**: 2026-11-06 18:30
> **Preflight**: [00-preflight-report.md](00-preflight-report.md)
> **Implements**: openvault-v0-1/RD-13
> **CodeOps Artifact Schema**: 1

## Overview

RD-11 delivered the encrypted backup, restore, and KEK rotation commands. RD-13 still needs
the operational shell around them: a real hardened Compose stack, least-privilege PostgreSQL
roles, file-backed database credentials, a restore check for a pre-backup agent certificate,
scheduled checkpoint export, and a doctor that checks the host state rather than only the API.

The plan keeps the existing logical backup format. It adds proof where the schema can support
it and documents the one residual honestly: v0.1 does not store agent certificate PEMs in the
database, so the restore drill supplies a certificate captured before the backup and verifies
that it chains to the restored CA.

## Minimum-Sufficient Baseline

**Original goal:** an operator can deploy, back up, restore, rotate, and diagnose the stack
without reading source code.

**Smallest viable design:** harden the existing three-service Compose file and add one static
web container; provision four PostgreSQL roles with one SQL script and one init wrapper; add
`OPENVAULT_*_DB_URL_FILE` support; extend `ov doctor`; expose the existing checkpoint exporter
as `ov audit checkpoint`; add Dockerfiles and digest-pinned base images; validate the stack
with a checked Compose contract.

**Excluded machinery:** high availability, Kubernetes, external KMS/HSM, ACME, multi-arch
images, and a separate backup daemon. Off-box scheduling uses systemd units and operator cron,
not a new service.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-13 |
| 02 | [Current State](02-current-state.md) | What RD-11 already delivered and what is missing |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Key Invariants

- The server process connects as `openvault_app`; DDL runs as `openvault_migrator`.
- No database password, backup passphrase, join token, or secret value is written to a
  Compose file, environment example, or log.
- The proxy is the only published service; the admin and agent listeners are never published.
- Every application container is non-root, read-only, capability-dropped, and resource
  bounded.
- A backup is not considered usable until the restore drill passes.

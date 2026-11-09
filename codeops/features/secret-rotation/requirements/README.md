# OpenVault Secret Rotation — Requirements

> **Project**: OpenVault — self-hosted secrets and certificates for Docker Compose
> **Feature**: Secret rotation workflow
> **Status**: Draft (preflight ready)
> **Created**: 2026-11-09 09:54
> **Target Release**: v1.2.0
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault already writes immutable secret versions and delivers the newest active version to agents.
This feature adds an operator-facing rotation workflow: a per-secret interval, live due-soon and
overdue status, a project Rotation screen, a guided rotate action with an optional generated value,
CLI commands, and an optional signed webhook for reminders. It does not rotate automatically, does
not call external providers, does not track which application holds which version, and does not delete
old versions.

## Minimum-Sufficient Baseline

**Original goal:** an operator can define a rotation policy, see what needs rotation, and rotate a
secret with a supplied or generated value from the UI or CLI.

**Smallest viable design:** one nullable interval column, derived due/status fields, a list filter, a
project Rotation page, a rotate dialog, an `ov rotation` command group, and a focused daily
notification service that mirrors the existing certificate-expiry pattern.

**Excluded support machinery:** no new dependency, workflow engine, queue, generic notification
framework, automatic rotation, external provider integration, or version-level consumer tracking.

**Approved complexity:** None. The Complexity Escalation Gate did not fire.

## Domain Glossary

| Term | Definition |
|---|---|
| Rotation policy | An optional per-secret interval in days |
| Rotation due date | Current version creation time plus the interval |
| Due soon | The due date is inside the configured warning window |
| Overdue | The due date has passed |
| Rotation | Writing a new immutable secret version, which resets the due date |
| Generated value | 32 random bytes encoded as base64url, shown once |
| Warning window | Days before the due date at which a secret becomes due soon; default 7 |
| Consumer | A service identity/agent that can read the secret; the UI shows its state and last seen |

## Document Index

| # | Document | Description | Depends On |
|---|----------|-------------|------------|
| **AR** | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions | — |
| **RD-01** | [Secret Rotation Workflow](RD-01-secret-rotation.md) | Requirements, scope, security, acceptance | — |

## Dependency Graph

```text
openvault-v0-1/RD-08 (Secrets)
openvault-v0-1/RD-10 (Agent delivery)
openvault-v0-1/RD-11 (CLI)
openvault-v0-1/RD-12 (Web UI)
                 \   /
                  \ /
          secret-rotation/RD-01
                   |
         plans/rd-01-secret-rotation
```

## Suggested Implementation Order

| Phase | Documents | Description |
|-------|-----------|-------------|
| **A: Data and API** | RD-01 §Data model, §Metadata API, §List API | Interval column, metadata fields, list filter, contract |
| **B: Notifications** | RD-01 §Webhook scan, §Notification persistence | Table, scheduler, webhook, audit, purge/dump |
| **C: CLI** | RD-01 §CLI | `ov rotation` group |
| **D: Web** | RD-01 §Web UI | Rotation page, detail card, rotate dialog, overview |
| **E: Verification** | RD-01 §Acceptance Criteria | Spec tests, integration, axe, docs guard |
| **F: Release** | RD-01 §Documentation | Reader docs, version metadata, release boundary |

## Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Due date | Derived from current version + interval | Writing a new version naturally resets it |
| Status | Server-computed `ok`/`due_soon`/`overdue` | One definition for UI, CLI, and webhook |
| Authorization | Existing `secret.write` | Rotation writes a value |
| API | Metadata fields + list filter | No duplicate read path |
| Notifications | Mirror certificate expiry | Durable claims, retries, signed webhook |
| Consumer tracking | Visibility only | The agent cannot prove application reload |
| Old versions | Keep | Avoid a destructive lifecycle change |
| Release | v1.2.0, UI + CLI | Consistent with the certificate UI |

## Specialist Check

**None** — the repository has no specialist briefs; the work reuses the certificate-expiry and
secret UI/API patterns, and a dynamic packet covers it.

## How to Use These Documents

1. Read the [Ambiguity Register](00-ambiguity-register.md).
2. Read [RD-01](RD-01-secret-rotation.md).
3. Open the plan at [`../plans/rd-01-secret-rotation/00-index.md`](../plans/rd-01-secret-rotation/00-index.md).
4. Run preflight, then execute with the `exec-plan` skill.

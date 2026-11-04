# RD-08 Projects and Secrets Implementation Plan

> **Feature**: Project lifecycle plus versioned, encrypted, idempotent secrets with metadata, capabilities, consumers, expiry, recovery, and controlled purge.
> **Status**: Done
> **Created**: 2026-11-04 16:35
> **Implements**: openvault-v0-1/RD-08
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault already has the complete project, secret, version, consumer, and idempotency
tables, the append-only version triggers, a KEK keyring, an AES-256-GCM envelope helper, a
policy engine, and a persistent audit chain. What is missing is the product surface: no
project route, secret route, contract, repository, service, or purge path exists.

This plan adds the control-plane project lifecycle and the data-plane secret lifecycle. A
project is a named namespace with a soft-delete marker. A secret is a
named object in a project with immutable encrypted versions, mutable metadata, tags, optional
version expiry, soft delete with a configurable retention window, opt-in one-way purge
protection, and a controlled purge path that uses the schema's dedicated purger role. Every
state change writes its authorization decision inside the same transaction as the change; a
read writes its decision before any decrypted value is returned. Values never appear in
metadata, lists, errors, logs, or audit details.

Idempotency uses the existing `idempotency_keys` table. A retried create or value write with
the same key returns the original version, and a key reused for a different request is
rejected. Consumer summaries are derived from active same-project consumer rows whose live
role grants `secret.read` and covers the secret.

RD-08 does not implement certificates, agent delivery, CLI commands, the web UI, backup,
rotation, or the deployment roles themselves. Those belong to RD-09 through RD-13. RD-08
provides the data and handlers those requirements consume.

## Minimum-Sufficient Baseline

**Original goal:** Let an organization administrator manage projects and let authorized
users store, version, read, recover, and purge secrets without leaking values.

**Smallest viable design:** Add strict API contracts, one project repository/service, one
secret repository/service, one envelope mapper over the existing `packages/core` crypto,
one policy-joined audit write path, two thin controllers, one data rate limiter, and one
dedicated purge connection over the existing schema and triggers. Add no migration, no new
dependency, no scheduler, no queue, and no second datastore.

**Excluded machinery:** A generic repository framework, a secret-value cache, a background
purge/expiry job, a new audit store, a policy cache, a client SDK, a migration for an
encoding column, and a new testing harness. See AR-6, AR-11, AR-14, and AR-23.

**Approved complexity:** None beyond direct feature code. The `OPENVAULT_PURGE_DB_URL` pool
is the same dedicated-session pattern already required by the database trigger and used by
the audit pruner; it is not a new security surface.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded quality audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-08 |
| 02 | [Current State](02-current-state.md) | Existing schema, crypto, policy, and gaps |
| 03-01 | [Contracts and Crypto](03-01-contracts-crypto.md) | Public contracts and the object-type AAD change |
| 03-02 | [Projects](03-02-projects.md) | Project repository, service, routes, and assignment hiding |
| 03-03 | [Secrets](03-03-secrets.md) | Secret repository, encryption, write/read/list, versions, idempotency |
| 03-04 | [Lifecycle and Purge](03-04-lifecycle-purge.md) | Metadata, delete, recovery, protection, expiry, purge, consumers |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Manage a project

```http
POST /v1/admin/projects { "name": "payments" }
-> 201 { "id": "01J...", "name": "payments",
          "createdAt": "...", "updatedAt": "...", "deletedAt": null }
```

### Create and read a secret

```http
POST /v1/data/payments/secrets
{ "name": "db-password", "value": "s3cret", "tags": { "env": "prod" } }
-> 201 { "id": "01J...", "name": "db-password", "currentVersion": { "id": "01J...", ... },
          "capabilities": { "canRead": true, ... } }

GET /v1/data/payments/secrets/db-password
-> 200 { "name": "db-password", "value": "s3cret", "encoding": "utf8", ... }
```

### Retry a write

```http
PUT /v1/data/payments/secrets/db-password
Idempotency-Key: 6f1c2d3e
{ "value": "new-value" }
-> 200 { "currentVersion": { "id": "01J..." }, "version": { "id": "01J..." } }
```

### Lifecycle

```http
DELETE /v1/data/payments/secrets/db-password
POST   /v1/data/payments/secrets/db-password/recover
POST   /v1/data/payments/secrets/db-password/purge
```

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Project selector | Admin routes use the ULID; data routes use the active project name | AR-1 |
| Project deletion | Soft delete, no recovery route, repeated access 404 | AR-2 |
| Hidden assignments | Filtered from the actor snapshot and admin reads, not deleted | AR-3 |
| Project shape | `id`, `name`, timestamps, `deletedAt`; no display name | AR-4 |
| Secret writes | POST create, PUT value/version, PATCH metadata | AR-5 |
| Encoding | Bytes stored; empty/whitespace rejected; text only for safe UTF-8, else base64 | AR-6 |
| Envelope binding | AAD v2 includes `objectType` and `projectId`; strict validation | AR-7 |
| Expired versions | `latest` falls back to the newest active version; 410 if none | AR-8 |
| Validation | Strict tag, content-type, and future-expiry bounds | AR-9 |
| List | Search, `tagKey`/`tagValue`, name/id keyset cursor, 422 malformed cursor | AR-10 |
| Idempotency | Transactional claim; KEK-HMAC request hash; replay returns the written version | AR-11, AR-30 |
| Version limit | 1,000 active versions, then 409 | AR-12 |
| Retention | Database clock, `OPENVAULT_SOFT_DELETE_DAYS`, then purge gate | AR-13 |
| Purge authority | Dedicated `openvault_purger` pool with database/role-membership checks | AR-14, AR-28 |
| Consumers | Active same-project consumers with any live `secret.read` grant | AR-15 |
| Capabilities | Metadata and value responses; one actor snapshot per request | AR-16, AR-31 |
| Audit timing | Chain lock first; state-change allow joins the transaction; failures add error outcomes | AR-17, AR-26, AR-32 |
| Data limits | One 600/min bucket keyed by agent principal or user | AR-18 |
| Deleted name reuse | Reserved until purge; per-name advisory lock | AR-19, AR-29 |
| Secret rename | Not supported | AR-20 |
| Agent data access | Value read only | AR-21 |
| Error mapping | 500 integrity, 503 purge configuration, read error outcomes | AR-22, AR-32 |
| Test strategy | Real crypto, real PostgreSQL, disposable purge role; CI runs purge | AR-23 |
| Limits | Config max 65,536; `/v1/data` body guard 524,288 | AR-25 |
| Visibility | Access-explain and object assignment creation require an active parent | AR-27 |
| Specialist | None | AR-24 |

## Cross-RD Acceptance Ownership

| Item | This plan | Remaining owner |
|---|---|---|
| RD-07 data-plane read/write audit | Every project and secret route authorizes and writes the decision | None for secrets |
| RD-06 capability flags | Computed on every secret response | None for secrets |
| RD-08 consumer metadata | Returns the project consumers with effective read grants | RD-10 updates `last_seen`/state |
| RD-08 controlled purge | API path and purge credential check | RD-13 provisions the role and backup policy |
| RD-09 certificate lifecycle | Reuses the object-type AAD and lifecycle patterns | RD-09 |
| RD-10 agent fetch | Value read on the agent listener | RD-10 adds refresh/heartbeat |
| RD-11 and RD-12 | Consume the project and secret contracts | RD-11 and RD-12 |
| RD-13 backup/rotation | Secret versions are already versioned and encrypted | RD-13 |

## Specialist Agents

**None** — the repository's security, correctness, and concurrency lenses cover the domain.

_Detection evidence: the project already runs a correctness reviewer and a security/concurrency auditor at each phase gate; RD-08 adds ordinary TypeScript over the existing PostgreSQL, Node crypto, WebAFX, and Vitest patterns. Encryption lives in `packages/core/src/crypto.ts:1-166`, policy in `apps/server/src/rbac/policy-service.ts:189-760`, audit in `apps/server/src/audit/`, and the schema in `apps/server/src/database/schema.ts:46-57,253-339,461-472`. No repeated rework evidence exists._

## Related Files

| File | Change |
|---|---|
| `packages/api-contract/src/projects.ts` | Project contracts |
| `packages/api-contract/src/secrets.ts` | Secret, version, consumer, capability contracts |
| `packages/api-contract/src/index.ts` | Export the new contracts |
| `packages/core/src/crypto.ts` | Object-type/project AAD, strict envelope validation |
| `apps/server/src/security/keyring.ts` | Narrow `EnvelopeKeyring` compatibility |
| `apps/server/src/config/{types,loader,redact}.ts` | Optional `OPENVAULT_PURGE_DB_URL`; 65,536 value cap |
| `apps/server/src/transport/pre-stack.ts` | `/v1/data` body guard |
| `apps/server/src/projects/{repository,service,errors}.ts` | Project persistence and lifecycle |
| `apps/server/src/secrets/{repository,service,envelope,idempotency,errors,rate-limits,runtime,purge}.ts` | Secret persistence, encryption, idempotency, and lifecycle |
| `apps/server/src/controllers/projects.ts` | Project routes |
| `apps/server/src/controllers/secrets.ts` | Data routes, including the agent value read |
| `apps/server/src/rbac/policy-service.ts` | Capabilities for many resources; joinable decision option |
| `apps/server/src/rbac/audit.ts` | Decision event details and outcome mode |
| `apps/server/src/rbac/policy-repository.ts` | Hide assignments/resources for soft-deleted projects |
| `apps/server/src/audit/policy-audit.ts` | Decision write mode |
| `apps/server/src/audit/audit-writer.ts` | Explicit chain-lock helper |
| `apps/server/src/app.ts` | Data runtime, services, controllers, purge pool disposal |
| `apps/server/tests/integration/projects.*.test.ts` | Project specification and implementation tests |
| `apps/server/tests/integration/secrets*.test.ts` | Secret specification and implementation tests |
| `apps/server/tests/integration/helpers/purger.ts` | Disposable purge role |
| `docs/reference/api.md` | Project and secret request/response examples |
| `docs/architecture/crypto.md` | AAD v2 and object-type binding |
| `docs/.vitepress/config.ts` | Secrets guide sidebar entry |
| `docs/guide/secrets.md` | Lifecycle, encoding, idempotency, purge |
| `docs/reference/configuration.md` | `OPENVAULT_PURGE_DB_URL`, retention, value limit |
| `docs/changelog.md`, `.changeset/` | User-visible release note |

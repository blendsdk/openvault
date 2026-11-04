# RD-07 Audit Implementation Plan

> **Feature**: A persistent, append-only audit log with a SHA-256 hash chain, KEK-wrapped HMAC key, checkpoints, query/verify/export routes, fail-closed writes, and explicit retention pruning.
> **Status**: Planning Complete
> **Created**: 2026-11-04 00:16
> **Implements**: openvault-v0-1/RD-07
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault already defines the audit tables, their append-only triggers, and a narrow policy audit port. Every authorization decision and assignment mutation reaches a structured logger, but nothing durable is written. RD-07 replaces that logger adapter with a persistent writer and turns the existing schema into the system of record.

The writer serializes every insert under one transaction-scoped advisory lock, reads the previous hash, and stores a SHA-256 chain plus an HMAC-SHA256 computed with a key wrapped by the KEK. It checkpoints the tail at the first event, after every 1,000 further events, and after a day without a checkpoint. Three routes expose the log: a filtered, cursor-paginated event list; a chain verifier that anchors at the checkpoint immediately before the retained window (or includes the first event), checks every checkpoint, and detects tampering; and an NDJSON export that is itself audited. A maintenance command verifies, exports, checkpoints, and deletes rows past the 180-day retention window.

RD-07 also wires the current emitters: RBAC decisions and assignment changes, identity attempts, local/CLI/OIDC logins and lockouts, agent join and renewal, and consumer metadata changes. Future data-plane routes in RD-08 and RD-09 inherit the same policy port; their secret and certificate reads are already decision events once those routes authorize. RD-07 does not implement those routes, KEK rotation, backup, or the CLI and web clients.

## Minimum-Sufficient Baseline

**Original goal:** Persist every security-relevant action in a tamper-evident, queryable, verifiable log, and fail closed when evidence cannot be written.

**Smallest viable design:** Reuse the existing `audit_events`, `audit_keys`, and `audit_checkpoints` tables and their triggers. Add one canonical JSON encoder, one writer with a fixed advisory lock, one key-unwrap helper over the existing keyring, one policy adapter behind the existing port, three thin routes, a pre-prune verification gate, and two maintenance commands. Add no migration, no scheduler, no external service, and no new dependency.

**Excluded machinery:** A background checkpoint scheduler, SIEM forwarding, alerting, row-level audit encryption, external transparency logs, a separate audit database, a queue, and a custom cryptographic library. See [AR-11](00-ambiguity-register.md#resolution-notes) and [AR-24](00-ambiguity-register.md#resolution-notes).

**Approved complexity:** None beyond direct feature code. The advisory lock, key wrapping, and checkpoint table are required by the accepted integrity model; they are not generalized infrastructure. See AR-9, AR-10, and AR-11.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded quality audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-07 |
| 02 | [Current State](02-current-state.md) | Existing schema, port, emitters, and gaps |
| 03-01 | [Audit Core](03-01-audit-core.md) | Canonical JSON, event model, keys, writer, checkpoints, policy adapter |
| 03-02 | [Audit API](03-02-audit-api.md) | Contracts, query, cursor, verify, export, authorization, rate limits |
| 03-03 | [Audit Emitters](03-03-audit-emitters.md) | RBAC, identity, authentication, agent, and consumer integration |
| 03-04 | [Retention and Operations](03-04-retention-operations.md) | Prune command, checkpoint export, credentials, docs, release note |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Query events

```http
GET /v1/audit/events?action=secret.read&result=deny&from=2026-10-01T00:00:00.000Z&limit=50
-> 200 { "events": [ { "eventId": "01J...", "action": "secret.read",
                        "result": "deny", "hash": "9f2c...", "hmac": "41ab..." } ],
          "nextCursor": "eyJ2Ijox..." }
```

### Verify the chain

```http
GET /v1/audit/verify
-> 200 { "ok": true, "checkedRange": { "fromEventId": "01J...", "toEventId": "01J..." },
          "firstBrokenEventId": null, "reason": "ok" }
```

### Export NDJSON

```http
GET /v1/audit/export?projectId=01J...
-> 200 application/x-ndjson
   {"eventId":"01J...","hash":"...","hmac":"..."}
   {"eventId":"01J...","hash":"...","hmac":"..."}
```

### Prune past retention

```bash
OPENVAULT_PRUNE_DB_URL=postgres://openvault_pruner:...@.../openvault \
  pnpm --filter @openvault/server audit:prune -- --out /secure/audit-2026-11-04.ndjson
```

Both maintenance commands read the normal server configuration; the prune command additionally reads `OPENVAULT_PRUNE_DB_URL`.

### Export a checkpoint anchor

```bash
pnpm --filter @openvault/server audit:checkpoint -- --out /secure/audit-checkpoint.json
```

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Assignment evidence | One decision event per attempt plus one mutation event on success | AR-1 |
| Endpoint limits | 60 events, 10 verify, 5 export per minute per principal | AR-2 |
| Authentication coverage | Browser local, CLI local, and OIDC success/failure plus lockout | AR-3 |
| Prune authority | Dedicated `openvault_pruner` session through `OPENVAULT_PRUNE_DB_URL` | AR-4 |
| Action catalog | Frozen names, one allowlist for queries and details | AR-5 |
| Event shape | RD minimum plus `projectId`; hashes exposed as hex | AR-6 |
| Canonical JSON | Strict sorted-key serializer with bounds | AR-7 |
| Hash input | Hex canonical object, raw previous-hash prefix, millisecond timestamp | AR-8 |
| Audit key | Created on first write under the chain lock, KEK-wrapped, unwrapped per operation | AR-9 |
| Chain order | Fixed transaction advisory lock `780217001` | AR-10 |
| Checkpoints | First event, 1,000 further events, lazy daily, maintenance; HMAC over id and hash | AR-11 |
| Verification | Anchor at the checkpoint before the retained window or include the first event; check every checkpoint; edit, middle delete, tail delete, and empty-plus-checkpoint detection | AR-12 |
| Pagination | Descending sequence id with a signed, filter-bound cursor | AR-13 |
| Project scope | Query/export scoped; verify requires org scope | AR-14 |
| Export | Streamed NDJSON; export attempt event before first byte | AR-15 |
| Details | Per-action allowlist, reject unknown keys before hashing | AR-16 |
| Failure mode | Fail closed; one accepted credential-counter exception | AR-17 |
| Policy port | Persistent adapter behind the existing interface | AR-18 |
| Identity attempts | One audited decision; non-auditing visibility checks | AR-19 |
| Authentication events | `auth.login` plus `auth.lockout`, no credentials; allow only after the final credential recheck | AR-20 |
| Agent failures | System actor for unknown/expired/inactive; token owner for used/revoked; independent renew failure write; replay writes no duplicate | AR-21 |
| Consumer changes | Register on first row, update on metadata change, nothing for `last_seen` | AR-22 |
| Prune flow | Verify, export, checkpoint at the last deleted event, delete, record; pruner has `SELECT, DELETE` | AR-23 |
| Schema | Reuse existing tables and triggers; no migration; `objectId` requires `objectType` | AR-24 |
| Error mapping | 503 unavailable across all controllers, 422 invalid, 403 denied, 200 `ok:false` tamper | AR-25 |
| Test data | Fresh chain databases and a provisioned `SELECT, DELETE` pruner role | AR-26 |
| Documentation | API, guide, configuration, CLI, security limitations, changelog, changeset | AR-27 |
| Specialist | None — existing lenses cover the domain | AR-28 |

## Cross-RD Acceptance Ownership

| Item | This plan | Remaining owner |
|---|---|---|
| RD-07 secret/certificate read and write events | Ships the policy decision writer those routes call; no data routes exist here | RD-08 and RD-09 emit their decisions by authorizing before returning data |
| RD-07 KEK rotation event | Keeps `kek.rotate` in the catalog and supports multiple keys | RD-13 performs rotation and adds rotation details |
| RD-07 backup event | Defines `backup.create` in the catalog | RD-13 emits backup/restore events |
| RD-07 consumer refresh and state changes | Audits join/renew metadata changes | RD-10 adds the heartbeat/refresh path and must not audit `last_seen` alone |
| RD-06 acceptance 8 persisted audit evidence | Every current decision and mutation is persisted now | None; data-plane decisions close with RD-08/RD-09 |
| RD-06 denial counter | Preserved in the persistent adapter's details | RD-14 may aggregate it |

## Specialist Agents

**None** — the capability-gap check ran against this repository's evidence and found no gap a standing specialist would close.

_Detection evidence: the audit key hierarchy is already documented at `docs/architecture/crypto.md:5-73`; the append-only triggers already exist at `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27`; the policy port already exists at `apps/server/src/rbac/audit.ts:81-86`; the schema is fixed at `apps/server/src/database/schema.ts:397-455`. The work is ordinary TypeScript over existing PostgreSQL, Node crypto, WebAFX, and Vitest patterns. Existing security, crypto, and concurrency review lenses cover the risks, and no recurring audit-specific finding exists._

## Related Files

| File | Change |
|---|---|
| `packages/api-contract/src/audit.ts` | Event, query, verify, and action contracts |
| `packages/api-contract/src/index.ts` | Export the audit contracts |
| `apps/server/src/audit/actions.ts` | Per-action details allowlists and action helpers |
| `apps/server/src/audit/types.ts` | Shared event, request, and query-executor types |
| `apps/server/src/audit/errors.ts` | Audit error hierarchy and 503 mapping classes |
| `apps/server/src/audit/canonical-json.ts` | Deterministic serializer |
| `apps/server/src/audit/audit-key-store.ts` | KEK wrap/unwrap and key selection |
| `apps/server/src/audit/audit-writer.ts` | Chain insert, advisory lock, checkpoints |
| `apps/server/src/audit/policy-audit.ts` | Persistent `PolicyAuditPort` adapter |
| `apps/server/src/audit/audit-query.ts` | Filtered keyset query |
| `apps/server/src/audit/cursor.ts` | Signed, filter-bound cursor |
| `apps/server/src/audit/audit-verify.ts` | Chain verifier |
| `apps/server/src/audit/audit-export.ts` | NDJSON export |
| `apps/server/src/audit/audit-service.ts` | Facade used by controllers and emitters |
| `apps/server/src/audit/audit-rate-limits.ts` | Endpoint limiters |
| `apps/server/src/audit/audit-prune.ts` | Retention export/checkpoint/delete |
| `apps/server/src/audit/cli.ts` | `audit:prune` entry point |
| `apps/server/src/audit/checkpoint-cli.ts` | `audit:checkpoint` export entry point |
| `apps/server/src/audit/http.ts` | Request metadata helper |
| `apps/server/src/audit/runtime.ts` | Composition values |
| `apps/server/src/controllers/audit.ts` | Three audit routes |
| `apps/server/src/controllers/identity.ts` | Context plumbing |
| `apps/server/src/controllers/auth.ts` | Login audit hooks |
| `apps/server/src/controllers/cli-auth.ts` | CLI login audit hooks |
| `apps/server/src/controllers/oidc.ts` | OIDC login audit hooks |
| `apps/server/src/controllers/agent.ts` | Agent request context |
| `apps/server/src/agent/agent-join-service.ts` | Join audit and consumer change |
| `apps/server/src/agent/agent-renew-service.ts` | Renew audit and consumer change |
| `apps/server/src/agent/consumer-repository.ts` | Locked comparison read |
| `apps/server/src/identity/identity-authorizer.ts` | Context and non-auditing checks |
| `apps/server/src/identity/identity-service.ts` | One decision per attempt |
| `apps/server/src/rbac/audit.ts` | Mutation `projectId`; adapter contract |
| `apps/server/src/rbac/runtime.ts` | Accept the persistent adapter |
| `apps/server/src/rbac/policy-service.ts` | Non-auditing `hasAny` option |
| `apps/server/src/app.ts` | Audit runtime, services, controller |
| `apps/server/src/transport/secure-application.ts` | Optional audit runtime dependency |
| `apps/server/src/main.ts` | Audit runtime before the agent runtime |
| `apps/server/package.json` | `audit:prune` script |
| `apps/server/tests/integration/helpers/fixtures.ts` | Remove synthetic audit rows |
| `apps/server/tests/integration/helpers/pruner.ts` | Test role provisioning with `SELECT, DELETE` |
| `apps/server/tests/integration/agent-join.impl.test.ts` | Audit recorder and optional context |
| `apps/server/tests/integration/agent-renew.impl.test.ts` | Audit recorder and optional context |
| `apps/server/tests/integration/agent-renew.spec.test.ts` | Audit recorder and optional context |
| `docs/reference/api.md` | Audit routes and examples |
| `docs/reference/configuration.md` | Prune URL and role |
| `docs/reference/cli.md` | Prune and checkpoint commands |
| `docs/guide/audit.md` | Verify, export, retention |
| `docs/security/limitations.md` | Tail versus prefix truncation |
| `docs/changelog.md`, `.changeset/` | User-visible release note |

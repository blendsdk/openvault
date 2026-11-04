# Audit Core: RD-07 Audit

> **Document**: 03-01-audit-core.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the durable event model: the deterministic serializer, the frozen action and details catalog, the KEK-wrapped HMAC key, the chain writer, checkpoint creation, and the persistent adapter behind the existing policy audit port. It reuses the existing tables and triggers and requires no migration. The API restricts object filters to the existing composite `(object_type, object_id)` index, as described in the API document.

**Governing decisions:** AR-5, AR-6, AR-7, AR-8, AR-9, AR-10, AR-11, AR-16, AR-17, AR-18, AR-24.

## Architecture

### Current Architecture

`PolicyService` builds a `PolicyDecisionEvent` or `PolicyMutationEvent` and calls `PolicyAuditPort`. The only implementation writes to the logger error channel in `apps/server/src/rbac/audit.ts:107-170`. The database tables and append-only triggers already exist in `apps/server/src/database/schema.ts:397-455` and `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27`.

### Proposed Changes

```text
PolicyService ──► PolicyAuditPort ──► PersistentPolicyAudit ──┐
                                                              ├──► AuditWriter ──► audit_events
Business emitters ──► AuditService.record ────────────────────┘         │
                                                                        ├──► audit_keys
                                                                        └──► audit_checkpoints
```

`AuditWriter` is the only component that inserts audit rows. `AuditService` is the façade used by controllers and business emitters. It delegates to the writer and to the query/verify/export modules described in the API document.

## Implementation Details

### New Types

File: `apps/server/src/audit/types.ts`

```ts
/** Actor classes stored in `audit_events.actor_kind`. */
export type AuditActorKind = "user" | "service" | "system";

/** Stored outcome classes. */
export type AuditResult = "allow" | "deny" | "error";

/** Stored scope classes. */
export type AuditScopeType = "org" | "project" | "object" | "system";

/** Request metadata attached to an event when the transport provides it. */
export interface AuditRequestContext {
  readonly requestId?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/** A value accepted inside `details`. */
export type AuditDetailValue =
  | null
  | boolean
  | number
  | string
  | readonly AuditDetailValue[]
  | { readonly [key: string]: AuditDetailValue };

/** One event before the chain fields are computed. */
export interface AuditEventDraft {
  readonly projectId: string | null;
  readonly requestId: string;
  readonly actorId: string | null;
  readonly actorKind: AuditActorKind;
  readonly action: AuditAction;
  readonly scopeType: AuditScopeType;
  readonly scopeId: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly result: AuditResult;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly details: Readonly<Record<string, AuditDetailValue>>;
}

/** One event with its identity and timestamp assigned. */
export interface AuditEventInput extends AuditEventDraft {
  readonly eventId: string;
  readonly ts: Date;
}

/** One persisted event, including its sequence position. */
export interface AuditEventRecord extends AuditEventInput {
  /** `audit_events.id`; a decimal bigint string. */
  readonly sequenceId: string;
  readonly prevHash: Buffer;
  readonly hash: Buffer;
  readonly hmac: Buffer;
  readonly auditKeyId: string;
}
```

`AuditEventInput.ts` is a `Date`; the writer converts it to a millisecond ISO string exactly once. `sequenceId` is a string because JavaScript cannot represent a PostgreSQL `bigint` safely.

The transaction/query surface used by audit persistence is deliberately narrow, so audit modules do not import an unrelated repository layer:

```ts
/** Minimal database or transaction surface used by audit persistence. */
export interface AuditQueryExecutor {
  executeQuery<T>(query: string, params?: Record<string, unknown>): Promise<{
    readonly records: readonly T[];
  }>;
}
```

`PostgreSQLDatabase` satisfies this interface directly; `withTransaction` callbacks satisfy it through their transaction handle.

File: `apps/server/src/audit/errors.ts`

```ts
/** Base class for audit domain failures. */
export class AuditError extends Error {}

/** Invalid caller input that must not be written. */
export class AuditInputError extends AuditError {}

/** Canonical JSON rejected a value. */
export class CanonicalJsonError extends AuditError {}

/** Audit persistence or an audit key is unavailable. */
export class AuditUnavailableError extends AuditError {}

/** A required audit key cannot be unwrapped. */
export class AuditKeyUnavailableError extends AuditUnavailableError {}

/** A query filter, limit, or cursor is invalid. */
export class AuditQueryError extends AuditError {}

/** The caller may not read the requested audit scope. */
export class AuditAccessDeniedError extends AuditError {}

/** The prune command is misconfigured. */
export class AuditPruneConfigError extends AuditError {}
```

### Action Catalog

Files: `packages/api-contract/src/audit.ts` (the frozen list) and `apps/server/src/audit/actions.ts` (details allowlists and helpers).

The catalog is a closed list of every action the API accepts as a filter and every action the writer accepts for a write. The public contract owns the strings; the server module owns the per-action details rules. Every other module imports from these two places. The catalog derives the policy actions from `RBAC_ACTIONS` so a future policy action cannot silently become unfilterable.

```ts
// packages/api-contract/src/audit.ts
import { RBAC_ACTIONS } from "./rbac.js";

/** Actions that are not part of the fixed RBAC action catalog. */
export const BUSINESS_AUDIT_ACTIONS = [
  "auth.login",
  "auth.lockout",
  "assignment.grant",
  "assignment.revoke",
  "agent.join",
  "agent.renew",
  "consumer.register",
  "consumer.update",
  "audit.verify",
  "audit.export",
  "audit.prune",
  "backup.create",
] as const;

/** Every RBAC action plus the business audit actions. */
export const AUDIT_ACTIONS = [...RBAC_ACTIONS, ...BUSINESS_AUDIT_ACTIONS] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
```

```ts
// apps/server/src/audit/actions.ts
import { AUDIT_ACTIONS, type AuditAction } from "@openvault/api-contract";

/** Every RBAC action is a valid audit action. */
export const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/** Returns the details keys permitted for one action. */
export function allowedDetailKeys(action: AuditAction): ReadonlySet<string>;
```

The `AUDIT_ACTIONS` list includes all 25 `RBAC_ACTIONS` values (`packages/api-contract/src/rbac.ts:15-41`) plus the business actions. A compile-time test asserts the RBAC catalog is a subset, so a future action cannot silently become unfilterable.

Details allowlists (AR-16):

| Family | Permitted keys |
|---|---|
| `auth.login` | `method`, `client`, `reason` |
| `auth.lockout` | `method`, `client`, `lockSeconds` |
| `agent.join`, `agent.renew` | `reason`, `consumerId`, `certificateSerial` |
| `consumer.register`, `consumer.update` | `consumerId`, `composeProject`, `composeService`, `hostname`, `manifestHash`, `state`, `changed` |
| `audit.verify` | `ok`, `checkedFromEventId`, `checkedToEventId`, `firstBrokenEventId`, `reason` |
| `audit.export` | `format`, `filters` |
| `audit.prune` | `cutoff`, `exportedCount`, `deletedCount`, `checkpointId`, `dryRun` |
| Policy decisions | `reason`, `policyVersion`, `denialCount`, `version` |
| Assignment mutations | `assignmentId`, `targetPrincipalId`, `role`, `policyVersion` |
| Future `project.*`, `secret.*`, `certificate.*`, `kek.rotate` | `reason`, `policyVersion`, `version`, `kekId` |
| Future `backup.create` | `format`, `objectCount` |

`filters` is the only nested object. It accepts only the query filter keys from AR-13 with primitive values. No allowlist contains `value`, `plaintext`, `password`, `token`, `tokenHash`, `cookie`, `csrf`, `privateKey`, `csr`, or `certificatePem`.

`validateDetails(action, details)` rejects an unknown key, a nested object outside `filters`, a non-finite number, a string over 1,024 characters, or a total encoded size over 16 KiB. `changed` is an array of strings; `filters` is the only nested object. Rejection is an `AuditInputError`; the write does not happen.

### Canonical JSON

File: `apps/server/src/audit/canonical-json.ts`

```ts
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Serializes a value with sorted object keys and no insignificant whitespace.
 *
 * @throws {CanonicalJsonError} For unsupported values, cycles, lone surrogates,
 *   depth above eight, or output above the configured bound.
 */
export function canonicalJson(value: CanonicalValue): string;
```

Algorithm:

1. Reject `undefined`, bigint, function, symbol, non-finite numbers, non-plain objects, and cycles.
2. Reject strings containing a lone surrogate (a code unit in `0xD800–0xDFFF` without its pair).
3. Sort object keys with the default JavaScript string comparison.
4. Append `JSON.stringify` for primitives and escaped strings; recurse for arrays and objects.
5. Track depth (maximum 8). Track output length (maximum 64 KiB for a full event, 16 KiB for details).
6. Return the joined string with no spaces.

`JSON.stringify` handles quote, backslash, and control-character escaping and leaves non-ASCII characters as UTF-8. The encoder is deterministic across processes and machines.

### Hash and HMAC

File: `apps/server/src/audit/hashing.ts`

```ts
/** The exact object covered by the chain hash. */
export interface CanonicalAuditEvent {
  readonly eventId: string;
  readonly ts: string;
  readonly projectId: string | null;
  readonly requestId: string;
  readonly actorId: string | null;
  readonly actorKind: AuditActorKind;
  readonly action: AuditAction;
  readonly scopeType: AuditScopeType;
  readonly scopeId: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly result: AuditResult;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly details: Readonly<Record<string, AuditDetailValue>>;
  readonly prevHash: string;
  readonly auditKeyId: string;
}

export function canonicalEventForHash(event: AuditEventInput, prevHash: Buffer, auditKeyId: string): CanonicalAuditEvent;
/** Hashes raw previous-hash bytes followed by the already-serialized canonical UTF-8 string. */
export function computeEventHash(canonicalJson: string, prevHash: Buffer): Buffer;
export function computeEventHmac(key: Readonly<Buffer>, hash: Buffer): Buffer;
```

- `prevHash` in the canonical object is lowercase hex.
- `auditKeyId` is included so moving a row to another key changes the hash.
- `projectId` is included so re-scoping a row breaks the chain.
- `ts` is `event.ts.toISOString()` with millisecond precision. The writer inserts this exact `Date`, so `pg` returns the same millisecond value on read.
- `canonicalJson` in `computeEventHash` is the string returned by `canonicalJson(canonicalEventForHash(...))`; the function does not serialize a second time.
- `hash = SHA-256(Buffer.concat([prevHash, Buffer.from(canonicalJson, "utf8")]))`.
- `hmac = HMAC-SHA256(key, hash)`.
- The first event uses 32 zero bytes for `prevHash`.

### Audit Key Store

File: `apps/server/src/audit/audit-key-store.ts`

```ts
/** One row from `audit_keys`. */
export interface AuditKeyRow {
  readonly id: string;
  readonly wrappedKey: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
  readonly kekId: string;
}

/**
 * Returns the existing audit key, creating it under the caller's chain lock.
 *
 * @param tx - Transaction that already holds the chain advisory lock.
 * @param keyring - Loaded KEK provider.
 * @param now - Timestamp for the created row.
 */
export async function selectOrCreateAuditKey(
  tx: AuditQueryExecutor,
  keyring: KeyringProvider,
  now: Date,
): Promise<AuditKeyRow>;

/** Loads one audit key row by id, or undefined. */
export async function loadAuditKey(
  tx: AuditQueryExecutor,
  id: string,
): Promise<AuditKeyRow | undefined>;

/**
 * Unwraps one audit key. The caller must zero the returned buffer.
 *
 * @throws {AuditKeyUnavailableError} When the KEK is missing or the tag fails.
 */
export function unwrapAuditKey(keyring: KeyringProvider, row: AuditKeyRow): Buffer;

/**
 * Runs an action with an unwrapped key and zeroes the buffer afterwards.
 */
export function withAuditKey<T>(
  keyring: KeyringProvider,
  row: AuditKeyRow,
  action: (key: Readonly<Buffer>) => T,
): T;
```

Key creation:

1. `SELECT id, wrapped_key, wrap_nonce, wrap_tag, kek_id FROM audit_keys ORDER BY created_at ASC, id ASC LIMIT 1`.
2. If a row exists, return it.
3. Generate `randomBytes(32)` and a ULID.
4. `kekId = keyring.currentId`; fail with `AuditKeyUnavailableError` when absent.
5. `withCurrentKey`: `createCipheriv("aes-256-gcm", kek, nonce)`; `setAAD(Buffer.from("ov:audit-key:v1:" + id + ":" + kekId, "utf8"))`; `ciphertext` (32 bytes), `tag` (16 bytes).
6. Insert the row and return it. The generator buffer is zeroed in `finally`.

Unwrap uses the row's `kek_id` with `keyring.withKey`, the same AAD, `setAuthTag`, and a 32-byte length check. A failed tag, missing KEK, or wrong length is `AuditKeyUnavailableError`; the message never contains key bytes.

No key cache is kept. One unwrap per event is cheap next to the database insert, and it avoids stale-key lifecycle bugs.

### Writer

File: `apps/server/src/audit/audit-writer.ts`

```ts
/** Fixed transaction-scoped advisory lock reserved for the audit chain. */
export const AUDIT_CHAIN_LOCK_ID = 780_217_001;

/** Writer tuning; production leaves the defaults. */
export interface AuditWriterOptions {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly now?: () => number;
  readonly checkpointEvery?: number;   // default 1_000
  readonly checkpointAgeMs?: number;   // default 86_400_000
}

export class AuditWriter {
  /** Appends one event, optionally inside a caller transaction. */
  public async record(
    input: AuditEventInput,
    tx?: AuditQueryExecutor,
    options?: {
      /** Used only when no retained event exists; links the first event to a retained anchor. */
      readonly previousHash?: Buffer;
    },
  ): Promise<AuditEventRecord>;

  /** Writes a checkpoint when the cadence requires one. */
  public async ensureCheckpoint(tx?: AuditQueryExecutor): Promise<AuditCheckpointRecord | undefined>;

  /** Writes or returns the checkpoint anchored at one event. */
  public async checkpointAt(
    event: AuditEventRecord,
    tx?: AuditQueryExecutor,
  ): Promise<AuditCheckpointRecord>;
}
```

`record` steps:

1. Validate the action, details, and public field bounds. `userAgent` is truncated to 512 characters (matching the request helper and the database check); `requestId` must be 1–100 characters; `scopeId`, `objectType`, and `objectId` must be 1–64 characters when non-null; `eventId`, `projectId`, and `actorId` must be ULIDs when non-null. A non-null actor is allowed only for user and service kinds. Reject any other out-of-range value as `AuditInputError` (AR-16).
2. If `tx` is provided, run inside it; otherwise open one transaction.
3. Normalize a non-null `sourceIp` with `SELECT CAST(:ip AS inet)` and use the driver's canonical text (no mask) for both the canonical object and the insert. This keeps IPv4-mapped and compressed IPv6 values stable across write and read.
4. `SELECT pg_advisory_xact_lock(:lockId)` with `AUDIT_CHAIN_LOCK_ID`.
5. `selectOrCreateAuditKey`.
6. `SELECT id, hash FROM audit_events ORDER BY id DESC LIMIT 1` under the lock. If a row exists, use its hash. If no row exists, use `options.previousHash` when provided; otherwise use the latest checkpoint's `last_hash` when a checkpoint exists; otherwise use 32 zero bytes. This keeps any first event after a fully pruned table linked to the retained anchor.
7. Build the canonical object with the selected key id, compute the hash and HMAC, and insert:
   ```sql
   INSERT INTO audit_events
     (event_id, ts, project_id, request_id, actor_id, actor_kind, action, scope_type,
      scope_id, object_type, object_id, result, source_ip, user_agent, details,
      prev_hash, hash, hmac, audit_key_id)
   VALUES
     (:eventId, :ts, :projectId, :requestId, :actorId, :actorKind, :action, :scopeType,
      :scopeId, :objectType, :objectId, :result, :sourceIp, :userAgent, :details,
      :prevHash, :hash, :hmac, :auditKeyId)
   RETURNING id;
   ```
8. `#maybeCheckpoint(tx, inserted, keyRow, now)`.
9. Return the record with the sequence id.
10. Zero the unwrapped key buffer in `finally`.

The advisory lock is transaction-scoped, so it is released at commit. A decision event always uses its own transaction (AR-10, AR-17), which means the lock is held only for one insert and commit. A mutation or agent event uses the caller transaction and holds the lock until that transaction commits; those operations are rate-limited and infrequent. The writer relies on PostgreSQL's default READ COMMITTED isolation so the previous-hash read sees the last committed link; a caller must not wrap an audited mutation in a snapshot-isolation transaction.

`previousHash` is used only when the table has no retained events; it lets the prune completion event link to the last deleted event's checkpoint. If a retained tail exists, the writer ignores the override and uses the tail to avoid a fork. When the table is empty and no override is supplied, the writer automatically uses the latest checkpoint's `last_hash`, so a normal event after a fully pruned table (or after a failed prune-event write) does not start a zero-hash fork.

`ensureCheckpoint` takes the same lock, reads the latest event and latest checkpoint, and inserts a checkpoint only when the cadence is due. It is called after every event insert and by verify/export/prune. It never creates a checkpoint when the table is empty.

### Checkpoints

File: same writer module.

```ts
/** One checkpoint row. */
export interface AuditCheckpointRecord {
  readonly id: string;
  readonly lastEventId: string;
  readonly lastHash: Buffer;
  readonly hmac: Buffer;
  readonly auditKeyId: string;
  readonly createdAt: Date;
}
```

Cadence (AR-11):

| Trigger | Condition |
|---|---|
| First event | No checkpoint exists |
| Count | `count(*)` of events with `id > latest.last_event_id` is at least 1,000 |
| Age | `now - latest.created_at` is at least 24 hours |
| Maintenance | `ensureCheckpoint` after verify/export/prune |

The count query uses the primary key index. Sequence gaps from rolled-back inserts do not affect it. Because the first event writes a checkpoint immediately, the next count checkpoint is event 1,001: there are 1,000 further events after the first checkpoint.

Checkpoint HMAC:

```text
hmac = HMAC-SHA256(auditKey, utf8(decimal(lastEventSequenceId)) || lastHash)
```

`last_event_id` stores the sequence id, not the event ULID; the schema column is `bigint`. The HMAC input is unambiguous: ASCII digits followed by exactly 32 hash bytes.

Insert form:

```sql
INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id, created_at)
VALUES (CAST(:lastEventId AS bigint), :lastHash, :hmac, :auditKeyId, :createdAt)
ON CONFLICT (last_event_id) DO NOTHING;
```

The insert is idempotent for a boundary checkpoint that already exists.

The checkpoint row stores the audit key id used for the event. A verification run unwraps that key. If the boundary checkpoint's KEK is unavailable, verification reports `key_unavailable`; writes fail closed.

### Persistent Policy Adapter

File: `apps/server/src/audit/policy-audit.ts`

```ts
/** Persistent implementation of the RD-06 policy audit boundary. */
export class PersistentPolicyAudit implements PolicyAuditPort {
  public constructor(options: { readonly writer: AuditWriter; readonly now?: () => number });

  public async recordDecision(event: PolicyDecisionEvent): Promise<void>;
  public async recordMutation(event: PolicyMutationEvent, tx?: AuditQueryExecutor): Promise<void>;
}
```

`PolicyAuditPort.recordMutation` gains an optional transaction parameter. `LoggingPolicyAudit` accepts and ignores it. `AssignmentService.create` and `delete` pass their `tx` so the mutation row commits or rolls back with the assignment (AR-17).

Decision mapping:

| Audit field | Source |
|---|---|
| `eventId` | `newUlid()` |
| `ts` | adapter clock |
| `projectId` | `event.projectId` (the owning project for project/object resources, null for org/system) |
| `requestId` | `context.requestId ?? "internal"` |
| `actorId` | `event.actorId` |
| `actorKind` | `event.actorKind` |
| `action` | `event.action` |
| `scopeType` | `event.scopeType` |
| `scopeId` | `event.scopeId` |
| `objectType` | `event.objectType` |
| `objectId` | `event.objectId` |
| `result` | `event.result` |
| `sourceIp` | `context.sourceIp ?? null`, used as-is when present |
| `userAgent` | `context.userAgent?.slice(0, 512) ?? null` |
| `details` | `{ reason, policyVersion, denialCount? }` |

Mutation mapping adds `projectId` from the new `PolicyMutationEvent.projectId`, `action: "assignment.grant" | "assignment.revoke"`, `result: "allow"`, `objectType: "assignment"`, `objectId: assignmentId`, and details `{ assignmentId, targetPrincipalId, role, policyVersion }`.

`PolicyDecisionEvent` gains `projectId: string | null` so an object-scoped decision (a secret or certificate resource) can satisfy the database check that project and object scopes carry a project id. The policy service sets it from the evaluated resource; current secret and certificate decisions already use project scope, so the field is defensive but keeps the contract correct.

The bounded denial counter moves into a shared `DenialCounter` class in `apps/server/src/rbac/audit.ts` so both the logger adapter and the persistent adapter keep the RD-06 Should Have behavior. It is process-local, bounded at 1,024 principals, and included only on denial events.

### Composition

File: `apps/server/src/audit/runtime.ts`

```ts
/** Writer and adapter that can be built before the policy engine. */
export interface AuditCore {
  readonly writer: AuditWriter;
  readonly policyAudit: PersistentPolicyAudit;
}

export function createAuditCore(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly now?: () => number;
}): AuditCore;

/** Full audit collaborators, including the policy-dependent service. */
export interface AuditRuntime extends AuditCore {
  readonly service: AuditService;
  readonly rateLimits: AuditRateLimitService;
}

export function createAuditRuntime(options: {
  readonly core: AuditCore;
  readonly policy: PolicyService;
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly now?: () => number;
  readonly rateLimitOptions?: AuditRateLimitOptions;
}): AuditRuntime;
```

The database and keyring build the query, verifier, and exporter; `core` supplies the writer and adapter; `policy` supplies `audit.read` evaluation.

The split avoids a cycle: the policy engine needs the persistent adapter, and the audit service needs the policy engine for `audit.read`. Composition order:

1. `const core = createAuditCore({ database, keyring, now })`.
2. `const policyRuntime = createPolicyRuntime({ database, audit: core.policyAudit, ... })`.
3. `const auditRuntime = createAuditRuntime({ core, policy: policyRuntime.service })`.

`createPolicyRuntime` accepts an optional `audit: PolicyAuditPort`. When absent it keeps the logging adapter, so isolated unit tests do not need a database. Production passes `core.policyAudit`.

`createAgentRuntime` builds the same three steps before constructing join and renew, and returns the `auditRuntime` on its value. `createApplication` reuses the agent runtime's audit runtime, or builds the three steps itself when no runtime is supplied. `createAuthPlugin` receives `auditRuntime.service`. The audit controller resolves `auditService` from the container.

### Integration Points

| Caller | Method | Transaction |
|---|---|---|
| `PolicyService.recordDecision` | `PersistentPolicyAudit.recordDecision` | Independent |
| `AssignmentService.create/delete` | `recordMutation(event, tx)` | Caller |
| `IdentityService` | through `PolicyService` | Independent decision |
| `AgentJoinService` | `AuditService.record(..., tx)` | Join |
| `AgentRenewService` | `AuditService.record(..., tx)` | Renew |
| Auth controllers | `AuditService.record(...)` | Independent, before session/token |
| Audit controller | `AuditService.record(...)` | Independent |

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Unknown action or details key | `AuditInputError`; no insert | AR-16 |
| Unsupported canonical value, cycle, lone surrogate, size bound | `CanonicalJsonError`; no insert | AR-7 |
| Keyring unavailable or wrong KEK | `AuditKeyUnavailableError` → 503 | AR-9 |
| Database or transaction failure | Wrap in `AuditUnavailableError`; caller maps to 503 or rolls back | AR-17 |
| Checkpoint insert fails | Same transaction rolls back; no event without its checkpoint when due | AR-11 |
| Advisory lock wait | Normal PostgreSQL wait; statement timeout applies | AR-10 |
| Bigint sequence id | Parse and emit as a decimal string | AR-6 |

## Testing Requirements

- Unit tests for canonical JSON determinism, key order, escaping, lone surrogates, depth, size, and rejected values.
- A fixed hash/HMAC vector for an already-serialized canonical string, so the `computeEventHash` contract cannot be double-encoded.
- Integration tests for chain linkage, first-event zero hash, HMAC verification, key creation and reuse, checkpoint triggers, concurrency ordering, and rollback behavior.
- A verification test that edits the first retained event's details while its checkpoint exists; the walk must recompute the anchor event's hash and HMAC and fail at that event.
- A verification test with an empty event table and a surviving checkpoint; the result must be `tail_truncated`, not `empty_chain`.
- A verification test that deletes a tail event and then adds a newer checkpoint; every checkpoint at or after the retained window must still be checked, so the older deletion is not masked.
- A writer test that records an event after every event has been deleted but a boundary checkpoint remains; the new event must link to the checkpoint hash and verification must pass.
- A policy-adapter test that an object-scoped decision carries the owning project id.
- A compile-time or runtime test that every `RBAC_ACTIONS` value exists in `AUDIT_ACTIONS`.
- A test that a denied policy decision survives a rolled-back assignment transaction.
- A test that a mutation event rolls back with its assignment.

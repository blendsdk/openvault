# Audit API: RD-07 Audit

> **Document**: 03-02-audit-api.md
> **Parent**: [Index](00-index.md)

## Overview

This component exposes the persisted chain: a filtered event list with cursor pagination, a verifier that anchors at the boundary checkpoint or includes the first retained event and checks every checkpoint, and a streamed NDJSON export. It also owns the public contracts, request authorization, rate limits, and error mapping.

**Governing decisions:** AR-2, AR-6, AR-12, AR-13, AR-14, AR-15, AR-25.

## Architecture

### Current Architecture

No audit controller exists. `apps/server/src/app.ts:221-231` registers ready, auth, identity, assignment, agent, and meta controllers. The API reference already names the intended routes at `docs/reference/api.md:339-345`.

### Proposed Changes

```text
GET /v1/audit/events  ──► AuditService.query  ──► AuditEventQuery  ──► audit_events
GET /v1/audit/verify  ──► AuditService.verify ──► AuditVerifier ──► audit_events + checkpoints
GET /v1/audit/export  ──► AuditService.export ──► AuditExporter ──► audit_events (NDJSON stream)
                         │
                         └──► AuditWriter (verify/export events)
```

Every route first evaluates `audit.read` through `PolicyService`, so the route itself produces one decision event. Verify and export then produce a second business event describing the result (AR-1).

## Implementation Details

### Public Contracts

File: `packages/api-contract/src/audit.ts`

```ts
/** One stored event as returned by the API. */
export const auditEventSchema = z.strictObject({
  eventId: ulidSchema,
  ts: z.iso.datetime(),
  projectId: ulidSchema.nullable(),
  requestId: z.string().min(1).max(100),
  actorId: ulidSchema.nullable(),
  actorKind: z.enum(["user", "service", "system"]),
  action: z.enum(AUDIT_ACTIONS),
  scopeType: z.enum(["org", "project", "object", "system"]),
  scopeId: z.string().min(1).max(64).nullable(),
  objectType: z.string().min(1).max(64).nullable(),
  objectId: z.string().min(1).max(64).nullable(),
  result: z.enum(["allow", "deny", "error"]),
  sourceIp: z.string().min(1).max(64).nullable(),
  userAgent: z.string().max(512).nullable(),
  details: z.record(z.string(), z.unknown()),
  prevHash: hexHashSchema,
  hash: hexHashSchema,
  hmac: hexHashSchema,
  auditKeyId: ulidSchema,
});

/** Filter fields shared by the list and export contracts. */
const auditFilterShape = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorId: ulidSchema.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  objectType: z.string().min(1).max(64).optional(),
  objectId: z.string().min(1).max(64).optional(),
  result: z.enum(["allow", "deny", "error"]).optional(),
  requestId: z.string().min(1).max(100).optional(),
  projectId: ulidSchema.optional(),
};

/** Shared filter checks; `objectId` needs `objectType` for the composite index. */
function validateAuditFilters(
  value: {
    readonly from?: string;
    readonly to?: string;
    readonly objectType?: string;
    readonly objectId?: string;
  },
  context: z.RefinementCtx,
): void {
  if (value.from !== undefined && value.to !== undefined && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
  }
  if (value.objectId !== undefined && value.objectType === undefined) {
    context.addIssue({
      code: "custom",
      path: ["objectType"],
      message: "objectType is required when objectId is supplied",
    });
  }
}

/** Query filters for the event list. */
export const auditQuerySchema = z
  .strictObject({
    ...auditFilterShape,
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .superRefine(validateAuditFilters);

/** Export filters; export streams the full matching range and has no limit or cursor. */
export const auditExportQuerySchema = z
  .strictObject(auditFilterShape)
  .superRefine(validateAuditFilters);

/**
 * Returns only the filter keys with defined values.
 *
 * The result binds a cursor and supplies the `audit.export` details; it never
 * contains `limit`, `cursor`, or an undefined key.
 */
export function normalizeAuditFilters(input: {
  readonly from?: string;
  readonly to?: string;
  readonly actorId?: string;
  readonly action?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly result?: string;
  readonly requestId?: string;
  readonly projectId?: string;
}): Readonly<Record<string, string>>;

/** One page of events. */
export const auditEventListSchema = z.strictObject({
  events: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});

/** Chain verification result. */
export const auditVerifyResponseSchema = z.strictObject({
  ok: z.boolean(),
  checkedRange: z
    .strictObject({
      fromEventId: ulidSchema.nullable(),
      toEventId: ulidSchema.nullable(),
    })
    .nullable(),
  firstBrokenEventId: ulidSchema.nullable(),
  reason: z.enum([
    "ok",
    "empty_chain",
    "missing_checkpoint",
    "checkpoint_mismatch",
    "prev_hash_mismatch",
    "hash_mismatch",
    "hmac_mismatch",
    "key_unavailable",
    "tail_truncated",
  ]),
});
```

Types: `AuditEvent`, `AuditQuery`, `AuditExportQuery`, `AuditEventList`, `AuditVerifyResponse`, `AuditAction`.

`normalizeAuditFilters` is the single source of truth for the filter object used by the cursor hash and the `audit.export` details. `objectId` without `objectType` is rejected with 422 because the existing composite index is `(object_type, object_id)`; this keeps object filtering index-backed without a migration.

`hexHashSchema` is a local constant: `z.string().regex(/^[0-9a-f]{64}$/)`. `projectId` is nullable because org and system events have no project. `actorId` is nullable only for system events; the writer enforces the database check `actor_kind <> 'system' OR actor_id IS NULL`.

`packages/api-contract/src/index.ts` exports the new module.

### Query Service

File: `apps/server/src/audit/audit-query.ts`

```ts
/** Authorization visibility returned by the policy engine. */
export type AuditVisibility =
  | { readonly kind: "all" }
  | { readonly kind: "projects"; readonly projectIds: readonly string[] };

/** One query page. */
export interface AuditPage {
  readonly events: readonly AuditEventRecord[];
  readonly nextCursor: string | null;
}

export class AuditEventQuery {
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly keyring: KeyringProvider;
  });

  public async page(
    filters: AuditQuery,
    visibility: AuditVisibility,
  ): Promise<AuditPage>;

  /** Streams matching events in ascending order for export. */
  public async *stream(
    filters: AuditQuery,
    visibility: AuditVisibility,
    batchSize?: number,
  ): AsyncGenerator<readonly AuditEventRecord[]>;

  /** Streams the chain prefix through one sequence id, used by prune. */
  public async *streamThrough(
    lastEventId: string,
    batchSize?: number,
  ): AsyncGenerator<readonly AuditEventRecord[]>;
}
```

SQL is assembled from fixed clauses; no user value is interpolated. The only dynamic parts are the presence of a clause and its named parameter.

```sql
SELECT id, event_id, ts, project_id, request_id, actor_id, actor_kind, action,
       scope_type, scope_id, object_type, object_id, result, source_ip, user_agent,
       details, prev_hash, hash, hmac, audit_key_id
  FROM audit_events
 WHERE <fixed clauses joined by AND>
 ORDER BY id DESC
 LIMIT :limit
```

Fixed clauses:

| Filter | Clause |
|---|---|
| `from` | `ts >= :from` |
| `to` | `ts <= :to` |
| `actorId` | `actor_id = :actorId` |
| `action` | `action = :action` |
| `objectType` | `object_type = :objectType` |
| `objectId` | `object_id = :objectId` (requires `objectType`) |
| `result` | `result = :result` |
| `requestId` | `request_id = :requestId` |
| `projectId` | `project_id = :projectId` |
| project visibility | `project_id = ANY(:projectIds)` |
| cursor | `id < CAST(:cursorId AS bigint)` |

If visibility is `projects` and the caller supplied a `projectId` outside the set, the service throws `AuditAccessDeniedError` before querying (403). If visibility is `projects` and no project filter is supplied, the `ANY` clause restricts the page. Org/system rows have a null `project_id` and are therefore invisible to project auditors.

Mapping:

- `sequenceId` is `String(row.id)`.
- `ts` is `row.ts.toISOString()`.
- Hash columns are lowercase hex.
- `details` is the `jsonb` object as returned by `pg`.
- `projectId` is `row.project_id`.

Ordering is descending `id`; the cursor uses the last row's sequence id.

### Cursor

File: `apps/server/src/audit/cursor.ts`

```ts
export interface CursorPayload {
  readonly v: 1;
  readonly kid: string;
  readonly id: string;
  readonly f: string;
}

export function encodeCursor(payload: CursorPayload, key: Readonly<Buffer>): string;
export function decodeCursor(raw: string): CursorPayload;
export function filterHash(filters: AuditQuery, visibility: AuditVisibility): string;
export function signCursor(payload: CursorPayload, key: Readonly<Buffer>): string;
export function verifyCursor(raw: string, key: Readonly<Buffer>, expectedFilterHash: string): CursorPayload;
```

Format: `base64url(canonicalJson(payload)) + "." + base64url(HMAC-SHA256(key, "ov:audit-cursor:v1:" || canonicalJson(payload)))`. The domain prefix keeps cursor signatures separate from event HMACs, which sign raw 32-byte hashes.

`filterHash` is `SHA-256` of the normalized filter object (no `cursor`, no `limit`, no undefined keys) plus the sorted effective project ids. It binds a cursor to the exact filters and visibility, so changing a filter cannot skip or replay rows; changing the page size does not invalidate a cursor. `verifyCursor` uses `timingSafeEqual` and throws `AuditQueryError` on any mismatch.

The cursor names its audit key id (`kid`). The query signs a new cursor with the last row's `audit_key_id`; `verifyCursor` loads that key by id and unwraps it. A key that is unavailable makes the cursor unverifiable and returns 503; a forged or mismatched cursor returns 422. If a full page's last row uses an unavailable key, the request returns 503 rather than an unsigned cursor.

`limit` is applied to the SQL page. If the page is full, `nextCursor` is encoded from the last row; the next page may be empty. A short page returns `nextCursor: null`.

### Verify Service

File: `apps/server/src/audit/audit-verify.ts`

```ts
export type AuditVerifyReason =
  | "ok"
  | "empty_chain"
  | "missing_checkpoint"
  | "checkpoint_mismatch"
  | "prev_hash_mismatch"
  | "hash_mismatch"
  | "hmac_mismatch"
  | "key_unavailable"
  | "tail_truncated";

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly checkedRange: {
    readonly fromEventId: string | null;
    readonly toEventId: string | null;
  } | null;
  readonly firstBrokenEventId: string | null;
  readonly reason: AuditVerifyReason;
}

export class AuditVerifier {
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly keyring: KeyringProvider;
  });

  public async verify(): Promise<AuditVerifyResult>;
}
```

Algorithm (AR-12):

1. Read the first retained event (`firstId`, `firstPrevHash`). If the table is empty, go to step 3.
2. Choose the anchor for the retained window:
   - Find the greatest checkpoint with `last_event_id < firstId`. This is the prune-boundary candidate. Verify its key and HMAC. If the key is unavailable, return `key_unavailable` at `firstId`. If the HMAC fails, return `checkpoint_mismatch` at `firstId`. If its `last_hash` does not equal `firstPrevHash`, return `prev_hash_mismatch` at `firstId`.
   - If no checkpoint is `< firstId`, look for a checkpoint with `last_event_id == firstId`. Verify its key and HMAC, then anchor **at** that event: the walk includes `firstId` and recomputes its canonical hash and HMAC from its fields, requiring the recomputed hash to equal the checkpoint `last_hash`. The verifier never trusts only the stored row hash. A mismatch is `hash_mismatch` or `hmac_mismatch` at `firstId`.
   - If neither exists, start at genesis only when `firstPrevHash` is 32 zero bytes; otherwise return `missing_checkpoint` at `firstId`.
   - A checkpoint that references a deleted event is a valid anchor when its hash matches the next retained event's `prev_hash`; this is the normal post-prune case.
3. If the table is empty:
   - If at least one checkpoint exists, a checkpoint proves events existed; return `{ ok: false, checkedRange: null, firstBrokenEventId: null, reason: "tail_truncated" }`.
   - If no checkpoint exists, return `{ ok: true, checkedRange: null, firstBrokenEventId: null, reason: "empty_chain" }`.
4. Walk the retained events in ascending batches of 1,000. Start at `firstId` when the anchor is the first event's checkpoint or genesis; start after the anchor when the anchor is a boundary checkpoint below `firstId`. For each event:
   - Rebuild the canonical object from the row (including `projectId`, hashes as hex, and the row's `ts.toISOString()`).
   - Compare `row.prev_hash` with the expected previous hash (the boundary checkpoint's `last_hash` for the first walked event, then the previous row's hash) → `prev_hash_mismatch` at this event.
   - Recompute the hash with `prev_hash` as the prefix → compare `row.hash` → `hash_mismatch`.
   - Recompute the HMAC with the row's key → compare `row.hmac` → `hmac_mismatch`.
   - If the row's key cannot be unwrapped, return `key_unavailable` at this event.
   - Advance the expected hash and the checked range.
5. Check **every** checkpoint with `last_event_id >= firstId`, not only the greatest:
   - Unwrap its key. If the key is unavailable, return `key_unavailable`; do not skip to an older checkpoint.
   - Verify its HMAC. A mismatch returns `checkpoint_mismatch`.
   - Require the referenced event to exist and its stored `hash` to equal `last_hash`; otherwise return `tail_truncated`.
   - Checking every checkpoint prevents a newer checkpoint from masking an older checkpoint that references a deleted event.
   - A boundary checkpoint below `firstId` is skipped because its event was intentionally pruned; the walk covers every retained event after it.
6. Return `{ ok: true, checkedRange, firstBrokenEventId: null, reason: "ok" }`.

The verifier caches unwrapped keys only for the duration of one run and zeroes them in `finally`. It never returns `checkedRange` for a chain it did not check.

Tail detection covers every checkpoint at or after the retained window. An event appended after the last checkpoint and deleted before any later checkpoint leaves no checkpoint reference, so the chain alone cannot prove it existed; exporting checkpoints off-box is the compensating control. This is the same trust boundary described in `docs/security/limitations.md`.

`checkedRange` reports the first and last retained event ULIDs actually walked. When the anchor is the first event's checkpoint, the anchor event is part of the walk and is included. When the anchor is a boundary checkpoint below `firstId`, the range starts at `firstId`. When the chain is empty, it is `null`.

`firstBrokenEventId` is the event whose hash, HMAC, or link failed. For a checkpoint-level failure where the referenced event is missing or the checkpoint HMAC/key fails, it is `null`, except when the failed anchor is the first retained event, where it is `firstId`.

### Export Service

File: `apps/server/src/audit/audit-export.ts`

```ts
export interface AuditExportOptions {
  readonly filters: AuditExportQuery;
  readonly visibility: AuditVisibility;
  /** Receives one NDJSON line per event. */
  readonly write: (line: string) => Promise<void>;
}

export class AuditExporter {
  public async export(options: AuditExportOptions): Promise<void>;
}
```

The service writes the `audit.export` **attempt** event after authorization and before `start`; the event carries the normalized filters and `result: "allow"`. It then calls `start` to send the headers and passes a `write` callback that awaits `res.write` and resolves on `drain`. The exporter streams batches of 500 in ascending `id` order.

A failure before the audit event is written or before `start` returns 503 with no body. A failure after `start` destroys the response; the partial NDJSON is not a valid export and the client must discard it. The attempt event remains as evidence, and no second event is written for the same export. This is documented in the guide.

### Authorization

File: `apps/server/src/audit/audit-service.ts`

```ts
export class AuditService {
  public constructor(options: {
    readonly writer: AuditWriter;
    readonly query: AuditEventQuery;
    readonly verifier: AuditVerifier;
    readonly exporter: AuditExporter;
    readonly policy: PolicyService;
    readonly now?: () => number;
  });

  public async query(
    actorId: string,
    filters: AuditQuery,
    context: AuditRequestContext,
  ): Promise<AuditEventList>;

  public async verify(
    actorId: string,
    context: AuditRequestContext,
  ): Promise<AuditVerifyResponse>;

  public async export(
    actorId: string,
    filters: AuditExportQuery,
    context: AuditRequestContext,
    start: () => void,
    write: (line: string) => Promise<void>,
  ): Promise<void>;

  /**
   * Records a business event. The service assigns the event id and timestamp.
   * Used by auth, agent, consumer, and audit routes.
   */
  public async record(
    draft: AuditEventDraft,
    tx?: AuditQueryExecutor,
  ): Promise<AuditEventRecord>;
}
```

Authorization rules (AR-14):

| Route | Policy call | Result |
|---|---|---|
| `events` with `projectId` | `authorize(actorId, "audit.read", { type: "project", id })` | One decision; deny → 403 |
| `events` without `projectId` | `authorizeList(actorId, "audit.read", { type: "org", id: "org" })` | One decision; visibility all/projects |
| `verify` | `authorize(actorId, "audit.read", { type: "org", id: "org" })` | One decision; org scope only |
| `export` with `projectId` | `authorize(actorId, "audit.read", { type: "project", id })` | One decision; deny → 403 |
| `export` without `projectId` | `authorizeList(actorId, "audit.read", { type: "org", id: "org" })` | One decision; visibility all/projects |

`authorizeList` returns `allowed: false` for a caller with no `audit.read` assignment; the service maps it to 403. For a project-only caller, the list decision is recorded against the first readable project and the visibility carries the full project set. That is one decision event, not one per project.

When a project filter is present and the single-project `authorize` call allows it, the query uses `{ kind: "all" }` because the filter already restricts the rows to that project. The visibility list is only needed for an unfiltered query or export.

`verify` additionally rejects a project-only caller because the org-scoped `authorize` call has no org assignment. The 403 message is the generic `access_denied`; it does not reveal chain health.

After every verify, pass or fail, the service records `audit.verify` with `result: ok ? "allow" : "error"` and details `{ ok, checkedFromEventId, checkedToEventId, firstBrokenEventId, reason }`. After export authorization and before sending headers, it records the `audit.export` attempt event with `result: "allow"` and `{ format: "ndjson", filters: normalizeAuditFilters(filters) }`. Both are written before the response body and fail closed with 503. A failed verification still returns 200 with `ok:false` after its evidence is written. A mid-stream export failure destroys the response; the attempt event remains and no second export event is written.

The business event scope follows the operation:

| Operation | Visibility | Scope |
|---|---|---|
| Verify | org only | `org` / `"org"` |
| Export with `projectId` | the requested project | `project` / that id |
| Export without `projectId` | all | `org` / `"org"` |
| Export without `projectId` | one project | `project` / that project id |
| Export without `projectId` | multiple projects | `system` / null |

A multi-project export is recorded at system scope because no single project owns it; an org auditor sees it, and the project auditors' data access is still covered by their own future read events. A single-project export is recorded at that project's scope so the project auditor can see their own export evidence.

The query service returns `AuditEventRecord` values with `Buffer` hashes; `AuditService` maps them to the public contract by converting `sequenceId` to a decimal string, `ts` to ISO, and each hash to lowercase hex. The controller parses the result through `auditEventListSchema` before rendering it.

### Controller

File: `apps/server/src/controllers/audit.ts`

```ts
export class AuditController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route().get("/events").middleware(auditEventLimit()).handle(query),
      this.route().get("/verify").middleware(auditVerifyLimit()).handle(verify),
      this.route().get("/export").middleware(auditExportLimit()).handle(export),
    ];
  }
}
```

- All handlers call `requirePrincipal(req)`.
- `events` parses `auditQuerySchema` from `req.query`; invalid input is 422.
- `verify` takes no query parameters; an unknown parameter is ignored by Express but not read.
- `export` parses `auditExportQuerySchema` (no `limit` or `cursor`), then calls `service.export` with a `start` callback. The service authorizes, ensures a due checkpoint, and writes the `audit.export` attempt event **before** invoking `start`; `start` sets the status and headers. If the event write fails, no header is sent and the controller returns 503. After `start`, the service streams the NDJSON lines.
- The `start` callback sets:
  1. `res.status(200)`;
  2. `res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")`;
  3. `res.setHeader("Content-Disposition", 'attachment; filename="audit-<colon-free ISO timestamp>.ndjson"')`;
  4. `res.setHeader("Cache-Control", "no-store")` (already global for `/v1`).
- The handler does not use `this.ok`, because the body is a stream.
- On an error before `start`, the handler throws the mapped `ApiError`; WebAFX renders the envelope. On an error after `start`, the response is destroyed.

Registration in `app.ts`: `app.registerController("/v1/audit", AuditController)`.

### Rate Limits

File: `apps/server/src/audit/audit-rate-limits.ts`

```ts
export interface AuditRateLimitService {
  readonly events: RequestHandler;   // 60/min
  readonly verify: RequestHandler;   // 10/min
  readonly export: RequestHandler;   // 5/min
}

export interface AuditRateLimitOptions {
  readonly eventLimit?: number;
  readonly verifyLimit?: number;
  readonly exportLimit?: number;
}

export function createAuditRateLimitService(
  options?: AuditRateLimitOptions,
): AuditRateLimitService;
```

The key is `principal:${req.auth?.user.id ?? "anonymous"}`. The middleware resolves the application-scoped service from the container, matching `apps/server/src/rbac/rate-limits.ts:52-79`. A separate set per application avoids shared buckets across tests.

### Error Mapping

| Error | HTTP | Code |
|---|---|---|
| `AuditUnavailableError`, `AuditKeyUnavailableError`, `PolicyUnavailableError` | 503 | `service_unavailable` |
| `AuditQueryError` (bad filter, bad cursor, bad limit) | 422 | `validation_error` |
| `AuditAccessDeniedError` / policy denial | 403 | `access_denied` |
| `AuditInputError` (programmer error) | 500 | `INTERNAL_SERVER_ERROR` |
| `CanonicalJsonError` (programmer error) | 500 | `INTERNAL_SERVER_ERROR` |
| Broken chain | 200 | body `ok:false` |

A `PolicyUnavailableError` from the authorization call is already mapped by the existing controllers; the audit controller adds the same branch.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Cursor from another filter set | 422; no query | AR-13 |
| Cursor signed by an unavailable key | 503 | AR-13 |
| Project filter outside visibility | 403; no rows | AR-14 |
| Verify with project-only scope | 403 | AR-14 |
| Empty chain with no checkpoints | 200 `ok:true`, `reason: "empty_chain"` | AR-12 |
| Empty table with a surviving checkpoint | 200 `ok:false`, `reason: "tail_truncated"` | AR-12 |
| Missing anchor after prune | 200 `ok:false`, `reason: "missing_checkpoint"` | AR-12 |
| Tail deleted | 200 `ok:false`, `reason: "tail_truncated"` | AR-12 |
| Any checkpoint at or after the retained window is unreadable | 200 `ok:false`, `reason: "key_unavailable"` | AR-12 |
| Export audit write fails | 503 before headers | AR-15 |
| Export stream fails mid-body | Destroy response; no valid file | AR-15 |
| Rate limit exceeded | 429 from the shared limiter | AR-2 |

## Testing Requirements

- Contract tests for valid and invalid query objects, response shapes, and hash regexes, including `objectId` without `objectType`.
- Integration tests for each filter, combined filters, descending order, page limits, and cursor continuation.
- Cursor tests for tamper, filter binding, visibility change, and key unavailability.
- Verification tests for a clean chain, edited result/details/hash (including the first retained event), deleted middle row, deleted tail, missing checkpoint, an unavailable early key, and an empty table with a surviving checkpoint.
- A verification test where a tail event is deleted and a newer checkpoint is later created; every checkpoint at or after the retained window must still be checked, so the older deletion is not masked.
- Export tests for NDJSON validity, filter parity with the list, the export attempt event, a pre-stream audit failure, and a mid-stream failure.
- Authorization tests for org, project, and no `audit.read` callers, including the verify restriction.
- Rate-limit tests with injected thresholds.
- An error-wrapping test that a database failure in query, verify, or export returns 503 `service_unavailable`.

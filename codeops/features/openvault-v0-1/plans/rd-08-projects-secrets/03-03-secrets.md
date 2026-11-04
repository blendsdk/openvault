# Secrets: RD-08 Projects and Secrets

> **Document**: 03-03-secrets.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns secret creation, immutable versions, value reads, metadata lists, version
history, capabilities, and `Idempotency-Key` replay. It uses the existing schema and the
object-type-bound envelope from [Contracts and Crypto](03-01-contracts-crypto.md).

**Governing decisions:** AR-5, AR-6, AR-7, AR-8, AR-10, AR-11, AR-12, AR-15, AR-16, AR-17,
AR-18, AR-19, AR-20, AR-21, AR-25, AR-26, AR-29, AR-30.

## Architecture

### Current Architecture

`secrets` and `secret_versions` exist with the required columns. The current version pointer is
deferrable, so a create can insert the secret, insert the version, and update the pointer in one
transaction. The version update trigger makes versions immutable. `idempotency_keys` stores one
row per `(principal_id,key)`. `consumers` has one row per service principal.

### Proposed Changes

```text
GET    /v1/data/:project/secrets                     secret.list
POST   /v1/data/:project/secrets                     secret.write
GET    /v1/data/:project/secrets/:name               secret.read
GET    /v1/data/:project/secrets/:name/versions      secret.read
PUT    /v1/data/:project/secrets/:name               secret.write
GET    /v1/data/:project/secrets/:name/consumers     secret.list
```

The data selector is the active project name (AR-1). Only the value read is served on the
agent listener (AR-21). `secret.list` is a project/org-scope action; an object-scope-only reader
can read its object value but receives 403 on the project list.

### Modules

| Module | Responsibility |
|---|---|
| `apps/server/src/secrets/repository.ts` | SQL for secrets, versions, consumers, and idempotency |
| `apps/server/src/secrets/envelope.ts` | Decode/encode values and map envelope columns |
| `apps/server/src/secrets/idempotency.ts` | Header validation, KEK-HMAC hash, claim and replay |
| `apps/server/src/secrets/service.ts` | Authorization, transactions, responses, and lifecycle |
| `apps/server/src/secrets/purge.ts` | Dedicated purge connection and guards |
| `apps/server/src/secrets/rate-limits.ts` | Data-plane limiter |
| `apps/server/src/secrets/errors.ts` | Stable domain errors |
| `apps/server/src/controllers/secrets.ts` | Route parsing, listener selection, envelopes |

## Implementation Details

### Value Encoding and Size

```ts
export interface DecodedValue {
  readonly bytes: Buffer;
  readonly encoding: "utf8" | "base64";
}

export function decodeRequestValue(
  value: string,
  encoding: SecretEncoding,
  maximumBytes: number,
): DecodedValue;

export function encodeResponseValue(bytes: Buffer): {
  readonly value: string;
  readonly encoding: "utf8" | "base64";
};
```

Rules:

- `utf8`: `Buffer.from(value, "utf8")`.
- `base64`: the string must match the canonical base64 grammar and re-encoding the decoded
  bytes must reproduce the exact string.
- Both: reject when the decoded byte length is 0 or every byte is whitespace
  (`0x09`, `0x0a`, `0x0b`, `0x0c`, `0x0d`, `0x20`).
- Both: reject when the decoded length exceeds `config.secretMaxBytes` (65,536) with
  `secret_too_large`.
- Response: decode as UTF-8 and re-encode; return text only when the round-trip is identical
  and the text contains no C0 control characters except tab, newline, and carriage return.
  Otherwise return canonical base64 (AR-6).
- Encrypt with `encryptValue(bytes, keyring, { objectType: "secret", projectId, objectId:
  secretId, version: versionId })`, where `keyring` is the `EnvelopeKeyring` implemented by
  `KeyringProvider`.
- Decrypt with the same AAD and `{ maxCiphertextBytes: 65_536 }`.
- Zero the plaintext buffer after serializing the response.

### Repository

```ts
findActiveProjectByName(tx, name): Promise<ProjectRecord | undefined>;
lockActiveProject(tx, id): Promise<ProjectRecord | undefined>;       // SELECT ... FOR SHARE
findActiveSecret(tx, projectId, name): Promise<SecretRecord | undefined>;
findSecretByName(tx, projectId, name): Promise<SecretRecord | undefined>; // includes deleted
findSecretById(tx, id): Promise<SecretRecord | undefined>;          // includes deleted
lockSecret(tx, id): Promise<SecretRecord | undefined>;               // FOR UPDATE
lockSecretName(tx, projectId, name): Promise<void>;                  // advisory lock
insertSecret(tx, input): Promise<SecretRecord>;
insertVersion(tx, input): Promise<SecretVersionRow>;
updateCurrentVersion(tx, secretId, versionId, updatedAt): Promise<void>;
updateMetadata(tx, secretId, input): Promise<SecretRecord | undefined>;
softDelete(tx, secretId, retentionDays): Promise<SecretRecord | undefined>;
recover(tx, secretId, updatedAt): Promise<SecretRecord | undefined>;
markPurgeProtected(tx, secretId): Promise<SecretRecord | undefined>;
countActiveVersions(tx, secretId): Promise<number>;
findVersion(tx, secretId, versionId): Promise<SecretVersionRow | undefined>;
findVersionById(tx, versionId): Promise<{ version: SecretVersionRow; secret: SecretRecord } | undefined>;
touchConsumer(tx, principalId): Promise<void>;
findLatestActiveVersion(tx, secretId): Promise<SecretVersionRow | undefined>;
findCurrentVersion(tx, secret): Promise<SecretVersionRow | undefined>;
listVersions(tx, secretId): Promise<readonly SecretVersionRow[]>;
listActiveSecrets(tx, projectId, filters): Promise<readonly SecretRow[]>;
listConsumers(tx, projectId, secretIds): Promise<ReadonlyMap<string, readonly ConsumerSummary[]>>;
```

`lockSecretName` calls `SELECT pg_advisory_xact_lock(hashtext(:key)::bigint)` with
`key = projectId + ":" + name`. It serializes create, recover, and purge for the same name
(AR-29). `lockActiveProject` takes `FOR SHARE` and requires `deleted_at IS NULL`; project
deletion takes the row lock and waits for in-flight data transactions.

The list query uses the active project, `deleted_at IS NULL`, the optional escaped `ILIKE`
name search, the optional `tagKey`/`tagValue` predicate (`tags ? :key` or
`tags ->> :key = :value`), the keyset cursor `(name, id) > (:name, :id)`, `ORDER BY name ASC,
id ASC`, and `LIMIT :limit + 1`. A malformed cursor is a 422.

The consumer query returns same-project consumers whose principal is active and whose live
assignment grants `secret.read`. The role set comes from the role matrix: `org.admin`,
`project.admin`, `secrets.manager`, `secrets.officer`, and `secrets.reader`; object scope only
uses `secrets.reader`. Consumer state `ok`/`degraded`/`failed` is included. Only
`compose_project`, `compose_service`, and `last_seen` are returned (AR-15).

### Idempotency

The header must be 1–200 visible ASCII characters. The request hash is
`HMAC-SHA256(currentKek, canonicalJson({ method, path, body }))` (AR-30). The transaction
claims:

```sql
INSERT INTO idempotency_keys
  (principal_id, key, method, path, request_hash, status, resource_id, expires_at, created_at)
VALUES
  (:principalId, :key, :method, :path, :requestHash, :status, :versionId,
   :expiresAt, :createdAt)
ON CONFLICT (principal_id, key) DO NOTHING
RETURNING principal_id
```

- If a row is returned, the claim is ours.
- If not, select the existing row `FOR UPDATE`.
- If expired, update **all** claim columns to the new values and continue.
- If the method, path, and request hash match and the row is unexpired, load the stored
  version by `resource_id`, load the current metadata, and return that metadata plus the
  stored `version`. A replay reflects current metadata (tags, status, capabilities) but the
  original written version. If the version no longer exists (purged), return 404
  `secret_not_found`.
- Otherwise throw `idempotency_conflict`.

The claim, version insert, current-version update, and one outcome event share one transaction.
A rollback releases the claim. `status` stores 201 for create and 200 for update; `resource_id`
stores the written version ULID. A response to create/update is
`secretWriteResponseSchema` (`metadata` plus `version`). The request hash uses an
HKDF-SHA256 subkey derived from the current KEK with info `openvault:idempotency:v1`, so the
KEK is not reused directly for HMAC (AR-30). Expired-row cleanup is an RD-13 operational task;
the plan documents the growth and does not add a scheduler.

### Service Flows

Every state change follows the lock order: audit chain lock, then project `FOR SHARE`, then
the per-name advisory lock, then the secret row lock, then the joined decision last (AR-17,
AR-26, AR-29).

**Create**

1. Validate the decoded value and metadata; resolve the active project by name.
2. Generate `secretId` and `versionId`; use the service clock for the audit timestamp.
3. Authorize `secret.write` on `{ type: "secret", id: secretId, projectId }` with audit
   disabled. A denial writes one independent deny decision and throws 403/404. Authorization
   happens before any name check, so an unauthorized caller cannot probe names.
4. In one transaction: chain lock, project `FOR SHARE`, name advisory lock, claim idempotency
   (when present). A matching unexpired claim replays immediately. Only a new claim checks
   `(project,name)` for any active or deleted row and rejects `secret_name_conflict`; then it
   inserts the secret, encrypts and inserts the version, sets `current_version_id`, and writes
   one joined allow decision with the version id.
5. Commit and load the full metadata with capabilities and consumers. Return metadata plus the
   written `version`.

**Value write (PUT)**

1. Resolve the active project and the secret by name including deleted; a missing secret is
   404. Validate the value.
2. Authorize `secret.write` on the secret with audit disabled. A denial writes one deny.
3. In one transaction: chain lock, project `FOR SHARE`, name advisory lock, claim idempotency.
   A matching unexpired claim replays even when the secret is now soft-deleted. Only a new
   claim requires the secret to be active and locks the row; enforce the version limit, insert
   the new version, move `current_version_id`, set `updated_at`, and write one joined allow
   with the version id.
4. Return metadata plus the written `version`.

**Read (GET)**

1. Resolve the active project by name and the secret by name (including deleted). A deleted
   secret is 404; a missing secret is 404 without an object decision because no target exists.
2. Authorize `secret.read` on the secret with audit disabled. A denial writes one deny and maps
   `scope_mismatch`/`expired_assignment` to 404 or `no_assignment` to 403. Authorization happens
   before any version-state disclosure.
3. Resolve the requested `?version=` row (404) or the newest active version
   (`expires_at IS NULL OR expires_at > now()`). If no version is active, write one error event
   with reason `secret_expired` and return 410.
4. Write one allow event with the resolved version id. A failed evidence write returns 503 and
   no value.
5. Decrypt and return the value with capabilities. On integrity failure, the allow event
   already exists, the response is 500 `secret_integrity_failed`, and no value is returned.
   This is one event per attempt (AR-32).

**List**

1. Resolve the active project; call `authorizeList` for `secret.list` on the project.
   `scope_mismatch`/`expired_assignment` maps to 404 `project_not_found`; `no_assignment` maps
   to 403.
2. Query the active secrets with search, tag, and cursor filters.
3. Load one actor snapshot and compute capabilities for every returned resource (AR-16).
4. Load the consumer summaries for the returned ids.
5. Return `{ secrets, nextCursor }`.

**Versions**

1. Resolve project/secret; authorize `secret.read` with audit disabled. A denial writes one
   deny and maps `scope_mismatch`/`expired_assignment` to 404 or `no_assignment` to 403.
2. Write one allow event (without a version id because the route lists many) and return every
   version newest first with `status` (`active`/`expired`) and `isCurrent`. Never return a
   value.

**Consumers**

1. Resolve project/secret; authorize `secret.list` on the secret with the same denial mapping.
2. Write one allow event and return the same-project consumer summaries.

### Capabilities

`PolicyService.capabilitiesForMany(actorId, resources)` loads one actor snapshot and computes
the five flags for each secret resource. It does not audit. The controller returns the flags
on every metadata and value response, not on version/consumer subresources (AR-16).

### Version Detail on Audit Events

Secret read and write outcome events include `details.version` with the resolved or written
version id. The policy details allowlist already accepts `version`. The event also carries
`reason` and `policyVersion`. No value, ciphertext, or key id is ever present.

### Agent Consumer Touch

After a successful agent value read, the service calls
`repository.touchConsumer(agent.principalId)` to set `consumers.last_seen = now()`. The update
is best-effort; a failure is logged and the value response still succeeds. This update does not
create an audit event because RD-07 defines `last_seen` heartbeats as non-audited. RD-10 owns
consumer `state` changes.

### Agent Value Read

The controller checks `listenerOf(req)`. On the agent listener it uses `requireAgent(req)` and
the agent's `principalId`/`projectId`; on the admin listener it uses `requirePrincipal(req)`.
The service path is identical. Only the value read accepts the agent listener; other data
routes return 401 for an agent request.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Empty, all-whitespace, or non-canonical value | 422 `validation_error` | RD-08 limits |
| Value above 65,536 decoded bytes | 413 `secret_too_large` | AR-25 |
| Duplicate active or deleted name | 409 `secret_name_conflict` | AR-19 |
| Missing/deleted secret | 404 `secret_not_found` | AR-2 |
| Missing version | 404 `secret_version_not_found` | AR-8 |
| No active version / expired named version | 410 `secret_expired` | AR-8 |
| Active-version limit | 409 `secret_version_limit` | AR-12 |
| Same key, different request, or rotated KEK | 409 `idempotency_conflict` | AR-11, AR-30 |
| Decrypt failure | 500 `secret_integrity_failed` | AR-22 |
| Policy or audit failure | 503 `service_unavailable` | AR-17 |
| Rate limit | 429 `RATE_LIMIT_EXCEEDED` | AR-18 |

## Integration Points

- The policy service authorizes every route; the audit service writes the joined/independent
  decision and error outcomes.
- The keyring provider satisfies the core `EnvelopeKeyring` interface.
- RD-10 calls the agent value read and updates `last_seen`.
- RD-09 mirrors the version and lifecycle pattern for certificates.

## Testing Requirements

- Specification tests for create, value write, read, list, versions, encodings, limits,
  idempotency, capabilities, consumers, and agent access.
- Implementation tests for malformed envelopes, version-limit boundaries, cursor continuation,
  wildcard search, concurrent writes, name reservation, and audit rollback.

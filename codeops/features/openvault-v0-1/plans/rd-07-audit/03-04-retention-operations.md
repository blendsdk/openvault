# Retention and Operations: RD-07 Audit

> **Document**: 03-04-retention-operations.md
> **Parent**: [Index](00-index.md)

## Overview

This component turns the 180-day retention setting into an explicit, reversible-by-evidence maintenance operation: verify the retained chain, export the prefix, write a checkpoint at its last event, delete that prefix under the pruner role, and record the prune. It also owns the operator documentation and the release note.

**Governing decisions:** AR-4, AR-23, AR-24, AR-27.

## Architecture

### Current Architecture

`OPENVAULT_AUDIT_RETENTION_DAYS` is validated at 30–3650 with a default of 180 (`apps/server/src/config/loader.ts:295`). Nothing reads the value. The append-only trigger permits DELETE only for `session_user = 'openvault_pruner'` with `openvault.allow_audit_prune = 'on'` (`apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-18`). No role is created by a migration; deployment must provision it.

### Proposed Changes

```text
audit:prune CLI
  ├─ load server config (retention, keyring)
  ├─ connect to OPENVAULT_PRUNE_DB_URL (session user openvault_pruner)
  ├─ verify the retained chain and abort on any failure
  ├─ select the deletable prefix by id
  ├─ stream that prefix to --out (mode 0600, exclusive create)
  ├─ write checkpoint at the prefix's last event (app connection)
  ├─ delete the prefix (prune connection, trigger override)
  └─ record audit.prune (app connection)
```

## Implementation Details

### Prune Service

File: `apps/server/src/audit/audit-prune.ts`

```ts
/** Result of one prune run. */
export interface AuditPruneResult {
  readonly cutoff: Date;
  readonly exportedCount: number;
  readonly deletedCount: number;
  readonly checkpointId: string | null;
  readonly dryRun: boolean;
}

export interface AuditPruneOptions {
  readonly database: PostgreSQLDatabase;
  readonly writer: AuditWriter;
  readonly query: AuditEventQuery;
  /** Verifies the retained chain before any export or delete. */
  readonly verifier: AuditVerifier;
  /** Opens the pruner-session delete transaction. */
  readonly deletePrefix: (lastEventId: string) => Promise<number>;
  readonly now?: () => number;
  readonly retentionDays: number;
}

export class AuditPruner {
  /** Exports and deletes the prefix older than retention. */
  public async prune(options: {
    readonly outputPath: string;
    readonly dryRun?: boolean;
  }): Promise<AuditPruneResult>;
}
```

Algorithm:

1. Compute `cutoff = new Date(now - retentionDays * 86_400_000)`.
2. Verify the retained chain with `verifier.verify()` before writing anything. Require `ok: true`; if not, abort with the verifier's reason and leave the table and filesystem untouched. This checks every retained event, including the eventual boundary event, against the chain and all checkpoints.
3. Find the boundary:
   ```sql
   SELECT max(id) AS id
     FROM audit_events
    WHERE ts < :cutoff
   ```
   This is the last event of the deletable prefix. If null, there is nothing to prune.
4. Stream the prefix through `query.streamThrough(lastEventId)` in ascending id order. The prefix is defined by id, not by `ts`, so a backwards clock adjustment cannot leave a hole in the chain. The prefix may include an event whose timestamp is slightly newer than the cutoff; that is the conservative chain-preserving choice.
5. Write NDJSON to `outputPath` opened with `wx` and mode `0600`. Require an absolute path. Abort if the file exists. On an export write failure, close and delete the partial file. If the checkpoint step fails after a complete export, delete the completed file before exiting so a retry with the same path is possible. The export is byte-identical to the API export: one JSON object per line with lowercase hex hashes.
6. Re-read the boundary event's full row and construct an `AuditEventRecord`.
7. Write a checkpoint at the boundary with `writer.checkpointAt(boundary)` on the application connection. If a checkpoint already exists for that `last_event_id`, verify its HMAC with the boundary event's key and require its `last_hash` to equal the boundary event's hash; abort on any mismatch. The checkpoint is written or verified before any delete.
8. When not in dry-run mode, call `deletePrefix(lastEventId)`. The implementation opens the pruner connection and runs:
   ```sql
   BEGIN;
   SET LOCAL openvault.allow_audit_prune = 'on';
   DELETE FROM audit_events WHERE id <= CAST(:lastEventId AS bigint);
   COMMIT;
   ```
   It verifies `SELECT session_user` is `openvault_pruner` before the delete and throws a clear error otherwise. The returned row count is `deletedCount`.
9. Record `audit.prune` through the application connection with `actorKind: "system"`, `actorId: null`, `scopeType: "system"`, `requestId: "audit-prune"`, `result: "allow"`, and details `{ cutoff: cutoff.toISOString(), exportedCount, deletedCount, checkpointId, dryRun }`. In dry-run mode `deletedCount` is 0. When the delete removed every event, the writer automatically uses the latest checkpoint's `lastHash`, so the prune event links to the retained anchor. The event is written after the delete; it is outside the deleted prefix.
10. Return the result.

If step 2 fails, nothing is exported or deleted. If step 7 fails, the delete does not run. If step 8 fails, no prune event is written; the checkpoint remains. If step 9 fails after a successful delete, the command exits non-zero; the table is empty but the next normal audit event links to the boundary checkpoint hash automatically, so the chain remains continuable. The operator must investigate the audit writer.

`AuditWriter` gains:

```ts
/** Writes (or returns) the checkpoint anchored at one event. */
public async checkpointAt(
  event: AuditEventRecord,
  tx?: AuditQueryExecutor,
): Promise<AuditCheckpointRecord>;
```

`checkpointAt` takes the chain lock, inserts with `ON CONFLICT (last_event_id) DO NOTHING`, then reads the row. It does not disturb the normal cadence.

### Prune Connection

File: `apps/server/src/audit/prune-connection.ts`

```ts
/** Opens a short-lived connection that satisfies the append-only trigger. */
export async function createPruneConnection(
  rawUrl: string | undefined,
): Promise<{ deletePrefix(lastEventId: string): Promise<number>; close(): Promise<void> }>;
```

- A missing URL throws `AuditPruneConfigError("OPENVAULT_PRUNE_DB_URL is required")`.
- `parseDatabaseUrl` validates the URL (`apps/server/src/db/url.ts:26-80`).
- The connection checks `SELECT session_user` and requires `openvault_pruner`.
- `deletePrefix` runs the transaction above.
- `close` disconnects in `finally`.

This module is only imported by the CLI and the prune integration test. The server process never reads the prune URL.

### CLI

File: `apps/server/src/audit/cli.ts`

```text
Usage: audit:prune --out <absolute-path> [--dry-run]
```

Behavior:

1. Parse arguments. Reject unknown arguments with exit code 2 and a usage line.
2. Load `loadConfig(process.env)`. A config error prints its message and exits 1.
3. Load `KeyringProvider.load(config.keyringPath)`.
4. Create the application `PostgreSQLDatabase` from `config.database`.
5. Create the pruner connection from `OPENVAULT_PRUNE_DB_URL`.
6. Build the audit runtime and run `AuditPruner.prune`.
7. Print one summary line: `pruned=<n> exported=<n> checkpoint=<id|none> dryRun=<true|false>`.
8. Zero the keyring and disconnect both databases in `finally`.
9. Exit 0 on success, 1 on failure, 2 on usage.

The command does not run migrations. It assumes the schema exists, like `db:migrate` assumes the database exists. The compiled path is `node dist/audit/cli.js`; the package script follows the existing `db:migrate` pattern:

```json
"audit:prune": "node dist/audit/cli.js"
```

The command uses the shared validated server configuration, so run it on the vault host or supply the same database URL, keyring path, TLS/CA files, and base URL as the server. This keeps one configuration contract and fails before any delete when a required setting is missing.

### Checkpoint Export Command

File: `apps/server/src/audit/checkpoint-cli.ts`

```text
Usage: audit:checkpoint --out <absolute-path>
```

The command reads the newest row from `audit_checkpoints` and writes one JSON object:

```json
{
  "id": "01J...",
  "lastEventId": "1234",
  "lastHash": "9f2c...",
  "hmac": "41ab...",
  "auditKeyId": "01J...",
  "createdAt": "2026-11-04T00:00:00.000Z"
}
```

- The output path must be absolute, is opened with `wx` and mode `0600`, and must not already exist.
- The command requires at least one checkpoint; otherwise it exits 1 with a clear message.
- It does not write an audit event: reading a checkpoint is a maintenance integrity action, not a data export.
- It loads the same configuration and database as the prune command but does not need the pruner role.
- Package script: `"audit:checkpoint": "node dist/audit/checkpoint-cli.js"`.

Operators store this file off-box. Verification can use it as a trusted anchor when the database checkpoint table is lost.

### Test Role Provisioning

File: `apps/server/tests/integration/helpers/pruner.ts`

```ts
/** Returns a prune URL for the disposable database, or undefined when the role cannot be created. */
export async function ensurePrunerRole(
  maintenanceUrl: string,
  testDatabase: string,
): Promise<string | undefined>;
```

- Connect with the maintenance URL.
- Read `current_user` and `rolsuper`. If the user is not a superuser, return `undefined` with a skip reason.
- Create `openvault_pruner` if absent:
  ```sql
  CREATE ROLE openvault_pruner LOGIN PASSWORD 'test-password';
  ```
- `GRANT SELECT, DELETE ON audit_events TO openvault_pruner;` in the test database. PostgreSQL evaluates the `WHERE id <= ...` clause with SELECT privilege, so DELETE alone is insufficient; the live probe in the preflight report confirms the failure. The prune connection needs no other table privilege because reads and checkpoints use the application connection.
- Return the test database URL with the user and password replaced.
- Do not drop the role: the test cluster is shared across disposable databases and the role is harmless.

The prune integration test skips with a clear message when the role cannot be provisioned. CI uses `POSTGRES_USER: openvault`, which is a superuser, so the test runs there.

### Documentation

| File | Change |
|---|---|
| `docs/reference/api.md` | Add request examples for filters, cursor, verify, and export; document NDJSON and the status codes |
| `docs/guide/audit.md` | Replace the placeholder with the implemented event fields, verify behavior, export, retention, and prune command |
| `docs/reference/configuration.md` | Document `OPENVAULT_PRUNE_DB_URL` and the `openvault_pruner` prerequisite in a maintenance section |
| `docs/reference/cli.md` | Add the server-side prune and checkpoint export commands and the future `ov audit` boundary |
| `docs/security/limitations.md` | Distinguish tail truncation (detected by checkpoints) from prefix truncation at a prune boundary (requires an off-box anchor) |
| `docs/changelog.md` | Add the audit release entry |
| `.changeset/audit.md` | Minor bump for `@openvault/api-contract` and `@openvault/server` |

Documentation must not mention plan, requirement, ambiguity, or task identifiers in the shipped docs. State the behavior, the command, and the operator prerequisite in plain language.

### Deployment Prerequisite

The deployment must create a login role named `openvault_pruner` and grant it `SELECT, DELETE` on `audit_events`; the delete predicate reads the `id` column, so DELETE alone fails with a permission error. The application role keeps its append-only permissions. The role must not have `UPDATE`, `TRUNCATE`, or ownership. RD-13 owns the automated provisioner; this plan documents the manual prerequisite.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Retained-chain verification fails | Abort before export or delete; report the verifier reason | AR-23 |
| Missing `OPENVAULT_PRUNE_DB_URL` | Usage-style error before any read; exit 1 | AR-4 |
| Session user is not `openvault_pruner` | Abort before export; clear message | AR-4 |
| Pruner role lacks `SELECT` or `DELETE` | Delete fails with a permission error; no prune event | AR-4 |
| Output path is relative or exists | Reject with exit 2; no file touched | AR-23 |
| Export write fails | Delete the partial file; no checkpoint or delete | AR-23 |
| Checkpoint write fails | Delete the completed export file; no delete | AR-23 |
| Existing boundary checkpoint fails its HMAC or key | Abort before delete; investigate tampering or key loss | AR-23 |
| Delete fails | Keep the checkpoint and exported file; no prune event | AR-23 |
| Nothing older than retention | Write `audit.prune` with zero counts; exit 0 | AR-23 |
| Keyring unavailable | Fail before any database write | AR-9 |
| Prune event write fails after delete | Exit non-zero; the table may be empty, but the next event links to the boundary checkpoint hash automatically; operator investigates the writer | AR-17 |

## Testing Requirements

- Prune service tests with a deterministic clock: old prefix exported, checkpoint written, prefix deleted, retained suffix still verifies.
- A tampered prefix event (triggers disabled) aborts before export or delete; the prefix remains.
- Dry-run test: export and checkpoint only; no delete; event records `dryRun: true`.
- No-op test with no rows older than retention.
- Missing URL, wrong session user, existing output file, and relative path tests.
- Trigger test: a direct delete as the app role fails; the pruner connection with `SELECT, DELETE` succeeds only with the setting on.
- A pruner-role privilege test: DELETE alone is denied; SELECT plus DELETE succeeds.
- Verification-after-prune test: the retained suffix verifies from the checkpoint at the deleted boundary.
- A full-prune recovery test: if the prune event write fails after deleting every event, the next normal event links to the boundary checkpoint hash and verification passes.
- Documentation checked against the route names, query parameters, and command output.

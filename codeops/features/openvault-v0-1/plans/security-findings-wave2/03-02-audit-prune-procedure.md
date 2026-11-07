# Audit Prune Procedure: Security Findings Wave 2

> **Document**: 03-02-audit-prune-procedure.md
> **Parent**: [Index](00-index.md)

## Overview

Remove the pruner's primitive table authority. A prune deletes a prefix only through a `SECURITY DEFINER` procedure that consumes a short-lived, single-use authorization created after the application verifies the retained chain, exports the prefix, and writes the boundary checkpoint.

## Data Model

Two new tables, added to `apps/server/src/database/schema.ts`:

### `audit_prune_authorizations`

| Column | Type | Rule |
|---|---|---|
| `id` | text | ULID primary key |
| `database_name` | text | 1–63 characters |
| `last_event_id` | bigint | Boundary sequence id |
| `last_hash` | bytea | 32 bytes |
| `expected_count` | integer | `>= 0` |
| `export_sha256` | bytea | 32 bytes |
| `cutoff` | timestamptz | Retention cutoff |
| `created_at` | timestamptz | default `now()` |
| `expires_at` | timestamptz | `now() + interval '10 minutes'` |
| `consumed_at` | timestamptz | null until consumed; single use |

Index `expires_at` for cleanup.

### `audit_prune_receipts`

| Column | Type | Rule |
|---|---|---|
| `authorization_id` | text | primary key; the consumed authorization |
| `database_name` | text | same value |
| `last_event_id` | bigint | boundary |
| `last_hash` | bytea | 32 bytes |
| `deleted_count` | integer | actual deleted rows |
| `export_sha256` | bytea | 32 bytes |
| `completed_at` | timestamptz | default `now()` |

## Procedure

A manual migration creates the function after the generated table migration:

```sql
CREATE FUNCTION public.openvault_prune_audit_prefix(p_authorization_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_record public.audit_prune_authorizations%ROWTYPE;
  boundary_hash bytea;
  prefix_count integer;
  deleted integer;
BEGIN
  IF session_user <> 'openvault_pruner' THEN
    RAISE EXCEPTION 'prune procedure requires the openvault_pruner session';
  END IF;

  DELETE FROM public.audit_prune_authorizations
   WHERE expires_at < now() - interval '1 day';

  SELECT * INTO auth_record
    FROM public.audit_prune_authorizations
   WHERE id = p_authorization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prune authorization not found';
  END IF;
  IF auth_record.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'prune authorization already consumed';
  END IF;
  IF auth_record.expires_at <= now() THEN
    RAISE EXCEPTION 'prune authorization expired';
  END IF;
  IF auth_record.database_name <> current_database() THEN
    RAISE EXCEPTION 'prune authorization database mismatch';
  END IF;

  SELECT hash INTO boundary_hash
    FROM public.audit_events
   WHERE id = auth_record.last_event_id;
  IF boundary_hash IS NULL OR boundary_hash <> auth_record.last_hash THEN
    RAISE EXCEPTION 'prune boundary mismatch';
  END IF;

  SELECT count(*)::int INTO prefix_count
    FROM public.audit_events
   WHERE id <= auth_record.last_event_id;
  IF prefix_count <> auth_record.expected_count THEN
    RAISE EXCEPTION 'prune prefix count mismatch';
  END IF;

  PERFORM set_config('openvault.allow_audit_prune', 'on', true);
  DELETE FROM public.audit_events WHERE id <= auth_record.last_event_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> auth_record.expected_count THEN
    RAISE EXCEPTION 'prune delete count mismatch';
  END IF;

  UPDATE public.audit_prune_authorizations
     SET consumed_at = now()
   WHERE id = auth_record.id;

  INSERT INTO public.audit_prune_receipts
    (authorization_id, database_name, last_event_id, last_hash,
     deleted_count, export_sha256, completed_at)
  VALUES
    (auth_record.id, auth_record.database_name, auth_record.last_event_id,
     auth_record.last_hash, deleted, auth_record.export_sha256, now());

  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.openvault_prune_audit_prefix(text) FROM PUBLIC;
```

`grants.sql` grants `EXECUTE` to `openvault_pruner` and nothing else. The procedure migration also self-contains the pruner revokes and app grants behind `pg_roles` guards so an existing database migrated without the grants job cannot keep direct table authority. The function deletes expired authorizations older than one day at the start of the call (before the target lookup), bounding table growth.

The export hash is recorded, not re-verified by the database: the database cannot read the export file, and the application is the trusted exporter. The authorization, receipt, and `audit.prune` event all carry the same hash, so an operator can compare them with the file. A “mismatched export hash” is therefore an application-side comparison, not a procedure rejection.

## Application Flow

1. `AuditPruner.prune` verifies the retained chain.
2. It exports the prefix and computes the SHA-256 of the exact NDJSON bytes.
3. It writes the boundary checkpoint.
4. It inserts an authorization through the application connection:
   `createPruneAuthorization({ database, lastEventId, lastHash, expectedCount, exportSha256, cutoff })`.
5. It calls `PruneConnection.deletePrefix(authorizationId)`.
6. It writes the chained `audit.prune` event with `authorizationId` and `exportSha256` in the details.
   `PRUNE_DETAIL_KEYS` in `apps/server/src/audit/actions.ts` must include both keys, and
   `AuditPruneResult` carries them for non-dry-run results.
7. If the chained event write fails after the procedure commits, the receipt remains the durable completion evidence.

The application role gets `INSERT, SELECT` on `audit_prune_authorizations` and `SELECT` on `audit_prune_receipts`. It never gets `DELETE` on `audit_events`.

## Failure Behavior

| Condition | Result |
|---|---|
| No authorization | Procedure raises; no rows deleted |
| Expired authorization | Procedure raises; no rows deleted |
| Boundary hash mismatch | Procedure raises; no rows deleted |
| Prefix count mismatch | Procedure raises; no rows deleted |
| Replay | `consumed_at` check raises; no rows deleted |
| Delete count mismatch | Transaction rolls back; no commit |
| App crashes after procedure | Receipt exists; chained event may be absent |
| Dry run | No authorization, no delete, existing behavior |
| Export hash differs from the file | Not a procedure error; the app-side hash is recorded in the event and receipt for operator comparison |

## Tests

- Role test: `openvault_pruner` cannot `DELETE` from `audit_events`, `INSERT` into `audit_checkpoints`, or bypass the procedure. The test helper grants `EXECUTE` only and explicitly revokes table/sequence rights.
- Procedure tests: absent, expired, mismatched database/boundary/count, replay.
- Success: authorization consumed, receipt row matches the app-computed export hash, chained event contains the same hash.
- Existing `audit-prune.spec.test.ts`, `audit-prune.impl.test.ts`, verification, and checkpoint tests must be updated to the new `deletePrefix(authorizationId)` and authorization callback signatures.
- `resetAuditTables` clears the new authorization and receipt tables.

## Acceptance

See `07-testing-strategy.md` ST-5…ST-12 and `01-requirements.md` R2.

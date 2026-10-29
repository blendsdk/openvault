# Audit

Every allow and every denial is an audit event. The log is append-only, hash-chained, and
HMAC-protected with a key wrapped by the KEK.

## Event fields

| Field | Meaning |
|---|---|
| `eventId` | ULID |
| `ts` | Timestamp |
| `requestId` | Correlates with operational logs |
| `actorId` | Principal |
| `action` | `secret.read`, `assignment.write`, … |
| `scope` | Organization, project, or object |
| `object` | Secret or certificate id |
| `result` | `allow`, `deny`, or `error` |
| `sourceIp` | Caller address |
| `details` | Allowlisted metadata, never values |

## Verify

```bash
ov audit verify
```

The verifier recomputes the chain and reports the first broken event. Editing a row breaks
the chain at that row.

## Query

```bash
ov audit --project payments --action secret.read --from 2026-10-01
ov audit --actor payments-api --result deny
ov audit --request-id 6f1c...
```

## Export

```bash
ov audit export --format ndjson --out audit.ndjson
```

Export itself is audited.

## Retention

The default retention is 180 days. Pruning is an explicit maintenance command:

1. Export the range.
2. Write a checkpoint.
3. Delete events older than the retention window.
4. Keep the checkpoint as a trusted anchor.

## Limits

A database administrator can truncate the audit table. The HMAC chain detects it only if a
checkpoint survives or was exported off-box. Export checkpoints regularly.

## Next

- [Threat model](/security/threat-model)
- [Known limitations](/security/limitations)

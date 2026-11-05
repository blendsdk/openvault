# Audit

Every authorization decision, assignment change, authentication attempt, agent lifecycle
event, and consumer metadata change is written to an append-only log. Each row contains a
SHA-256 hash of the previous row plus its canonical fields, and an HMAC-SHA256 computed with
a key wrapped by the KEK.

## Event fields

| Field | Meaning |
|---|---|
| `eventId` | ULID |
| `ts` | Millisecond timestamp |
| `projectId` | Owning project, or null for organization and system events |
| `requestId` | Correlates with operational logs |
| `actorId` | Principal, or null for a system actor |
| `actorKind` | `user`, `service`, or `system` |
| `action` | Frozen action name such as `secret.read` or `assignment.write` |
| `scopeType` | `org`, `project`, `object`, or `system` |
| `scopeId` | Scope identifier, or null for a system scope |
| `objectType` / `objectId` | Resource the event is about, when applicable |
| `result` | `allow`, `deny`, or `error` |
| `sourceIp` | Canonical caller address |
| `userAgent` | Truncated client user agent |
| `details` | Per-action allowlisted metadata; never a secret value |
| `prevHash`, `hash`, `hmac` | Lowercase hexadecimal chain fields |
| `auditKeyId` | Key that produced the HMAC |

## Query

```http
GET /v1/audit/events?action=secret.read&result=deny&from=2026-10-01T00:00:00.000Z&limit=50
```

Certificate import/generate/renew, public/private reads, delete, recovery, and purge write the
corresponding `certificate.*` decision events. The daily expiry job writes one
`certificate.expiry_warning` system event per delivered warning with `thresholdDays`,
`daysToExpiry`, `version`, and `webhook` details; a failed delivery writes an `error` outcome.
The event carries a stable audit id so a lease-reclaimed retry does not duplicate an existing
allow.

Filters are `from`, `to`, `actorId`, `action`, `objectType`, `objectId`, `result`,
`requestId`, and `projectId`. Results are newest first. A full page returns `nextCursor`;
pass it back as `cursor` with the same filters. `objectId` requires `objectType`.

An organization auditor sees every project. A project auditor sees only projects covered by
an `audit.read` assignment; organization and system events stay hidden. Verification requires
organization scope.

## Verify

```http
GET /v1/audit/verify
```

The verifier walks every retained event from the first retained row, recomputes its canonical
hash and HMAC, and checks every checkpoint at or after that row. Editing a row or deleting a
middle row is reported with `ok: false` and a stable reason. Tail deletion is detected only
while a surviving checkpoint or a newer event still references the deleted row. A checkpoint
immediately below the first retained row is treated as a legitimate prune boundary. An empty
log with no checkpoints is a clean empty chain. Verification is itself audited.

## Export

```http
GET /v1/audit/export?projectId=01J...
```

The response is NDJSON with one event per line in ascending order. The export attempt is
recorded before the first byte. A failure before streaming returns `503`; a failure after
streaming starts destroys the response, and the client must discard the partial file.

## Retention and pruning

The retention window defaults to 180 days (`OPENVAULT_AUDIT_RETENTION_DAYS`). Pruning is an
explicit maintenance command, not a background job:

Build the server package first, then load the pruner URL from a mode-`0600` environment file
so the password never enters shell history or the process argument list:

```bash
pnpm build
set -a
. /etc/openvault/prune.env
set +a
pnpm --filter @openvault/server audit:prune -- --out /secure/audit-2026-11-04.ndjson
```

The command verifies the retained chain first, writes the deletable prefix to an exclusive
mode-`0600` file, writes a checkpoint at its last event, deletes the prefix through the
`openvault_pruner` session, and records the prune. `--dry-run` exports and checkpoints without
deleting. The pruner role needs `SELECT, DELETE` on `audit_events`.

Export the newest checkpoint for off-box anchoring:

```bash
pnpm --filter @openvault/server audit:checkpoint -- --out /secure/audit-checkpoint.json
```

Store that file outside the vault host. It is a trusted hash anchor for the event it names;
export it immediately after a prune to record the boundary before later checkpoints replace
it in the database. It is not a complete replacement for the database chain.

## Limits

A database administrator who can disable triggers can rewrite or delete rows. The chain and
checkpoints detect tail deletion while a surviving anchor references the deleted row, and
the verifier rejects a missing event when a newer checkpoint claims it. Prefix deletion at a
legitimate prune boundary cannot be distinguished without an off-box anchor. The application
role must not own the audit tables or be a superuser; ownership or superuser access bypasses
the append-only trigger.

## Next

- [Threat model](/security/threat-model)
- [Known limitations](/security/limitations)

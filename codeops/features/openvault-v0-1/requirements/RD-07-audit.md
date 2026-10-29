# RD-07: Audit

> **Document**: RD-07-audit.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-02, RD-03, RD-06
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the append-only audit log: every allow and denial, every secret read
and write, every permission change, and every agent join or revocation. Events are
hash-chained, HMAC-protected with a key wrapped by the KEK, checkpointed, queryable, and
verifiable. A secret read must write evidence first and fail closed if evidence cannot be
written.

## Functional Requirements

### Must Have

- [ ] Record authentication success/failure, lockout, authorization allow/deny, secret
  read/write/delete/recover/purge, certificate read/private-key read, assignment changes,
  identity create/revoke, join/renew, KEK rotation, backup/export, and audit verification.
- [ ] Each event stores `eventId`, `ts`, `requestId`, `actorId`, `actorKind`, `action`,
  `scopeType`, `scopeId`, `objectType`, `objectId`, `result`, `sourceIp`, `userAgent`,
  `details`, `prevHash`, `hash`, `hmac`, `auditKeyId`.
- [ ] `hash = SHA-256(prevHash || canonicalJson(event without hash/hmac))`.
- [ ] `hmac = HMAC-SHA256(auditKey, hash)`.
- [ ] Audit inserts take a transaction-scoped advisory lock so one global chain order is
  preserved.
- [ ] Checkpoint every 1,000 events and daily: last event id, last hash, HMAC.
- [ ] `GET /v1/audit/verify` recomputes the chain from the earliest trusted checkpoint and
  returns `{ ok, checkedRange, firstBrokenEventId, reason }`.
- [ ] `GET /v1/audit/events` filters by time, actor, action, object, result, and request id
  with cursor pagination.
- [ ] `GET /v1/audit/export` returns NDJSON; export is audited.
- [ ] Retention is 180 days by default; pruning is an explicit command that exports the range
  and writes a checkpoint first.
- [ ] A secret read writes the audit event before returning plaintext; an audit write failure
  returns 503 and no secret.
- [ ] No secret value, private key, password, token, or cookie value is stored in `details`.
- [ ] Redaction runs before canonicalization and hashing.
- [ ] A project-scoped `audit.read` grant sees only that project's events.

### Should Have

- [ ] A checkpoint export command for off-box anchoring.
- [ ] Audit query performance indexes on `ts`, `actorId`, `action`, `objectId`.

### Won't Have (Out of Scope)

- SIEM forwarding, alerting, or anomaly detection.
- Audit log encryption at the row level.
- Tamper-proof hardware or external transparency logs.

## Technical Requirements

### Event shape

```json
{
  "eventId": "01J...",
  "ts": "2026-10-29T12:00:00.123Z",
  "requestId": "6f1c...",
  "actorId": "01J...",
  "actorKind": "service",
  "action": "secret.read",
  "scopeType": "project",
  "scopeId": "01J...",
  "objectType": "secret",
  "objectId": "01J...",
  "result": "allow",
  "sourceIp": "172.20.0.5",
  "userAgent": "openvault-agent/0.1.0",
  "details": { "version": "01J...", "composeService": "api" }
}
```

### Canonical JSON

- Object keys sorted lexicographically.
- No insignificant whitespace.
- UTF-8, no lone surrogates.
- `details` is an allowlisted object per action.

### Chain and checkpoints

- First `prevHash` is 32 zero bytes.
- Advisory lock constant is reserved for the chain.
- Checkpoint HMAC covers `lastEventId || lastHash`.
- Verification starts at the earliest checkpoint whose key is available; reports the window.

### Retention and pruning

- Default 180 days, configurable 30–3650.
- Pruning exports NDJSON, writes a checkpoint, deletes only older rows, and keeps the
  checkpoint.
- Verification reports the retained window; genesis verification is only possible while the
  full chain exists.

## Integration Points

- RD-02 provides the database and request id.
- RD-03, RD-04, RD-05 provide principals and auth events.
- RD-06 calls the audit writer for every decision.
- RD-08 and RD-09 call the writer before returning sensitive data.
- RD-10 records join, renew, and consumer updates.
- RD-13 exports and restores checkpoints.
- RD-14 verifies tamper tests and external review.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Audit timing | Async / sync / best effort | Synchronous, fail closed | No secret without evidence | AR-27 |
| Integrity | Plain table / hash chain + HMAC | Hash chain + HMAC | Detect tampering | AR-6 |
| Retention | 30 / 180 / 365 days | 180 days | Balance evidence and storage | AR-10 |
| Pruning | Automatic / explicit | Explicit with checkpoint | Preserve a trusted anchor | AR-10 |
| SIEM | v0.1 / later | Later | Scope control | AR-30 |

## Security Considerations

- **Data sensitivity:** audit metadata reveals access patterns; `details` must never contain
  values.
- **Input validation:** query filters are allowlisted; cursor is opaque and signed.
- **Authentication & authorization:** `audit.read` required; project scoping enforced.
- **Injection risks:** parameterized SQL; canonical JSON from a safe serializer.
- **Encryption needs:** audit HMAC key wrapped by KEK; TLS in transit.
- **Rate limiting:** verification and export are admin actions; rate limited.
- **Infrastructure:** append-only permissions; no update/delete grants for the app role on
  audit rows, except the pruning command.

## Acceptance Criteria

1. [ ] Every action in RD-06 produces exactly one event per attempt, including denials.
2. [ ] Editing a row's `details`, `result`, or `hash` makes `verify` fail at that event id.
3. [ ] Deleting a row in the middle makes `verify` fail at the next event.
4. [ ] Deleting the tail is detected by the latest checkpoint.
5. [ ] A secret read with a forced audit insert failure returns 503 and no plaintext.
6. [ ] Audit events contain no sentinel secret value or private key in any field.
7. [ ] A project-scoped auditor sees only that project's events.
8. [ ] Export produces valid NDJSON and creates an export audit event.
9. [ ] Pruning writes a checkpoint before deleting and verification still passes from the
   retained anchor.
10. [ ] Checkpoints are created every 1,000 events and daily.
11. [ ] Security requirements verified: tamper detection, redaction, fail-closed, scoping.

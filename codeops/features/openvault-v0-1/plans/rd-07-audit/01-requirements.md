# Requirements: RD-07 Audit (Plan Delta)

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-07](../../requirements/RD-07-audit.md) — the OWNING requirements document

## Scope of this plan (delta view)

### In this plan

- RD-07 Must Have: append-only recording for authentication success/failure and lockout, authorization allow/deny, assignment changes, identity create/revoke/join-token, agent join/renew, consumer register/update, audit verification, and audit export.
- RD-07 Must Have: the exact hash formula, HMAC formula, transaction advisory lock, checkpoint rules, event field set, action strings for identity/agent/consumer, redaction-before-canonicalization, and project-scoped `audit.read`.
- RD-07 Must Have: `GET /v1/audit/events`, `GET /v1/audit/verify`, `GET /v1/audit/export`, retention default 180 days, and an explicit prune command.
- RD-07 Must Have: a secret read writes evidence before plaintext and fails closed. This plan ships the persistent writer and the fail-closed boundary; RD-08 and RD-09 call it from their data routes.
- RD-07 Should Have: audit indexes (already present) and an explicit checkpoint export command for off-box anchoring.
- RD-07 Acceptance 1–13 for every surface that exists in this release.

### Deferred / out of this plan

| RD-07 item | Why it is not emitted here | Owner |
|---|---|---|
| `project.*`, `secret.*`, `certificate.*` business events | The routes do not exist yet; their policy decisions are persisted by this writer when the routes authorize | RD-08, RD-09 |
| `kek.rotate` business details | The key rotation job does not exist | RD-13 |
| `backup.create` / restore events | Backup and restore do not exist | RD-13 |
| Consumer heartbeat and refresh-only changes | Only join and renew mutate consumer metadata today | RD-10 |
| SIEM forwarding, alerting, anomaly detection | Explicitly out of scope | — |
| Row-level audit encryption, external transparency logs | Explicitly out of scope | — |
| CLI `ov audit` commands | The CLI client is not implemented | RD-11 |
| Web UI audit screen | The web UI is not implemented | RD-12 |

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Event granularity | One decision event per attempt plus one mutation event on success | AR-1 |
| Endpoint limits | 60 events / 10 verify / 5 export per minute per principal | AR-2 |
| Authentication coverage | Browser local, CLI local, and OIDC, including lockout | AR-3 |
| Prune authority | `OPENVAULT_PRUNE_DB_URL` with `openvault_pruner` session | AR-4 |
| Verify scope | Org-scoped `audit.read` only | AR-14 |
| Checkpoint cadence | First event, 1,000 events, lazy daily, maintenance | AR-11 |
| Failure mode | Every audited action fails closed | AR-17 |
| Schema change | None; reuse existing tables and triggers | AR-24 |

## Acceptance Criteria

The RD owns its acceptance criteria. This plan adds only these local completion criteria:

1. [ ] Every current audited attempt produces exactly one decision event (or one agent/consumer/auth event where no policy decision exists).
2. [ ] A successful assignment change produces one decision event and one mutation event.
3. [ ] A forced audit insert failure returns 503 for every audited operation and leaves no session, token, certificate, secret, or assignment state change; the credential failure counter may advance on a wrong-password attempt.
4. [ ] Verification detects an edited row, a deleted middle row, and a deleted tail at the expected event or checkpoint.
5. [ ] A project-scoped auditor cannot read another project's events and cannot run global verification.
6. [ ] Export is valid NDJSON and produces an `audit.export` event.
7. [ ] Prune exports, checkpoints before deleting, records `audit.prune`, and verification still passes from the retained anchor.
8. [ ] No secret value, token, cookie, password, private key, CSR, or certificate body appears in any event field.
9. [ ] `pnpm verify`, the PostgreSQL 16 and 17 integration suites, and `db:types:check` pass.
10. [ ] The checkpoint export command writes the latest checkpoint as mode-`0600` JSON for off-box anchoring.

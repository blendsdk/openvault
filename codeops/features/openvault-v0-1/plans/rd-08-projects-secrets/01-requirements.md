# Requirements: RD-08 Projects and Secrets

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-08](../../requirements/RD-08-projects-secrets.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan
- RD-08 project create, rename, list, read, and soft delete.
- RD-08 secret create, immutable value versions, metadata reads and updates, tags, content
  types, value encodings, and current/version reads.
- RD-08 value limits, name allowlists, empty/whitespace rejection, and version limit.
- RD-08 optional version expiry and the 410 behavior.
- RD-08 soft delete, recovery window, opt-in one-way purge protection, and controlled purge.
- RD-08 `Idempotency-Key` replay within 24 hours.
- RD-08 per-object capability flags on secret responses.
- RD-08 consumer Compose project/service summaries without host paths.
- RD-08 request context, policy scoping, data-plane rate limit, and audit evidence.
- The project soft-delete hiding rule for secrets, certificates, identities, and assignments.
- The agent-listener value read needed by RD-10.

### Deferred / out of this plan
- RD-09 certificate routes and certificate private-key reads.
- RD-10 agent refresh/heartbeat, manifest delivery, and local API.
- RD-11 CLI command implementation.
- RD-12 web pages.
- RD-13 backup, KEK rotation, deployment roles, and operational runbooks beyond the
  `OPENVAULT_PURGE_DB_URL` requirement.
- Project recovery. RD-08 defines no project recovery route and this plan adds none (AR-2).

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Admin vs data project selector | Admin uses the ULID; data uses the active project name | AR-1 |
| Project shape | No display name; `id`, `name`, timestamps, `deletedAt` | AR-4 |
| Secret read encoding | Empty/whitespace rejected; safe UTF-8 as text, otherwise base64 | AR-6 |
| Envelope AAD | `objectType` and `projectId` in both v2 domains; strict validation | AR-7 |
| Latest version | Newest active version; 410 only when none is active | AR-8 |
| Idempotency storage | Transactional KEK-HMAC claim; replay returns the written version | AR-11, AR-30 |
| Purge credential | Dedicated pool with database and role-membership checks | AR-14, AR-28 |
| Consumer summary | Same-project active consumers with any live `secret.read` grant | AR-15 |
| Decision audit timing | Chain lock first; joined state change; error outcomes | AR-17, AR-26, AR-32 |
| Data rate limit | One 600/min per-agent-or-principal bucket | AR-18 |
| Deleted names | Reserved until purge; per-name advisory lock | AR-19, AR-29 |
| Secret rename | Not supported | AR-20 |
| Agent access | Value read only | AR-21 |
| Limits | Config 65,536; data body guard 524,288 | AR-25 |
| Hidden resources | Access-explain and object assignment creation require an active parent | AR-27 |

## Acceptance Criteria

The RD owns its acceptance criteria. This plan adds these executable criteria:

1. Every RD-08 acceptance criterion is covered by at least one specification test in
   [07-testing-strategy.md](07-testing-strategy.md), except criteria owned by RD-13 deployment
   (role provisioning) which are covered by the documented operator contract and the test
   helper.
2. `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, and the integration suite
   pass before the plan is marked done.
3. No secret value appears in a list response, metadata response, audit event, log, or error.
4. A project soft delete makes its secrets, certificates, identities, and assignments
   unreachable within the same request, including access-explain and object assignment creation.
5. A value write cannot commit without its allow decision, and a rolled-back value write leaves
   no allow event. Reads record the authorization decision before decryption and an error
   outcome if delivery fails. Purge is decision-then-outcome because the trigger requires a
   separate session.

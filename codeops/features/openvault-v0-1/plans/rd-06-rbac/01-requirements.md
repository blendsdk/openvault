# Requirements: RD-06 RBAC

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-06](../../requirements/RD-06-rbac.md) — the owning requirements document
> **Reference**: [Roles and actions](../../../../../docs/reference/roles.md) — the published matrix oracle

## Scope of this plan (delta view)

### In this plan

- The 25-action catalog, nine-role matrix, and scope eligibility table, encoded once in typed
  constants and returned by `GET /v1/meta/roles`.
- Deny-by-default evaluation over org, project, and object scopes with no upward inheritance
  (RD-06 Must Have, Technical Requirements §Evaluation).
- Principal-status denial, service-identity control-plane cap, expired-assignment handling, and
  scope-eligible role checks.
- Assignment creation, listing, and deletion with the five grant guards, optional expiry, and the
  last-active-org-admin invariant.
- A monotonic policy version updated in the same transaction as every assignment change.
- One audit event per enforcement decision and per successful assignment mutation, through a
  small port that RD-07 will back with the hash-chained writer.
- `capabilitiesFor` returning `canRead`, `canWrite`, `canDelete`, `canPurge`, and `canManage` from
  the same evaluator.
- `GET /v1/admin/access-explain` returning effective principals, role, assignment, and consumer
  metadata for one action and resource.
- Replacement of the narrow `IdentityAuthorizer` with the full evaluator while preserving the
  RD-05 admin identity API behavior.
- Per-principal rate limits for assignment writes and reads.
- Contract, integration, concurrency, security, documentation, changeset, and PostgreSQL 16/17
  verification.

### Deferred / out of this plan

- The persisted hash chain, HMAC key, checkpoints, verify/export routes, and retention for audit
  events — RD-07 owns them. This plan emits through the port only (AR-1, AR-2).
- Project, secret, and certificate endpoints; rendering capabilities in their responses; object
  existence rules beyond the assignment/explain validation — RD-08 and RD-09 own them (AR-4).
- CLI and web UI assignment screens and access-explain presentation — RD-11 and RD-12 own them.
- A bootstrap command or endpoint for the first org administrator — deployment provisioning owns
  it (AR-7).
- `GET /v1/meta/capabilities`, project/secret/certificate lists, and any UI gate derived from
  them — RD-12 owns the shape; RD-06 ships only the policy helper.
- Rendering capability flags on secret and certificate responses — RD-08 and RD-09 own those
  responses; RD-06 ships and tests `capabilitiesFor`.
- Agent scaffold grant emission and the exact grant command — RD-10/RD-11 own the scaffold; RD-06
  ships the assignment API it calls.
- Assignment expiry display in the CLI and web UI — RD-11/RD-12 own the clients; RD-06 returns
  `expiresAt`.
- Custom roles, wildcard actions, explicit deny rules, attribute-based access control, group
  sync, and two-person approval — RD-06 Won't Have.
- A decision cache, policy language, external authorization service, or new dependency (AR-3).

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Audit integration | Port plus logger adapter; RD-07 replaces the adapter | AR-2 |
| Decision freshness | Version row plus per-request assignment read; no cache | AR-3 |
| Capabilities | Generic `capabilitiesFor`; RD-08/RD-09 render flags | AR-4 |
| Access-explain | Action plus resource query; scoped visibility | AR-5 |
| Assignment API | Tuple create, id delete, duplicate 409 | AR-6 |
| First org admin | Deployment prerequisite | AR-7 |
| Rate limits | 30 writes / 60 reads per minute per principal | AR-8 |
| Audit failure | Fail closed with 503; mutations roll back | AR-9 |
| Capability audit | No decision event for a projection | AR-10 |
| Meta visibility | Public catalog plus policy version | AR-11, AR-17 |
| Capability actions | Object action mapping plus `assignment.write` for manage | AR-12 |
| Explain validation | Real, visible resource; 404 otherwise | AR-13 |
| Assignment expiry | Future ISO-8601 only | AR-14 |
| Assignment list | Filters, newest first, no pagination | AR-15 |
| Hidden mutations | 404 for out-of-scope assignment ids | AR-16 |
| Mutation serialization | `policy_state` row update inside the transaction | AR-18, AR-21 |
| Reason codes | Fixed union shared by audit and tests | AR-19 |
| Mutation audit | `assignment.grant` and `assignment.revoke` | AR-20 |
| Identity bridge | Keep the RD-05 helper API; delegate internally | AR-22 |
| Module names | `src/rbac/` and `controllers/assignments.ts` | AR-23 |
| Response shapes | Catalog, explain, and assignment shapes as specified | AR-24–AR-26 |
| HTTP mapping | 403/404/409/422/503 | AR-27 |

## Acceptance Criteria

The RD-06 acceptance criteria remain the feature oracle. This plan adds only these plan-local
completion criteria:

1. [ ] Every RD-06 acceptance criterion is covered by at least one ST case in
   [07-testing-strategy.md](07-testing-strategy.md), except the acceptance items explicitly owned
   by RD-07, RD-08, RD-09, RD-11, or RD-12.
2. [ ] The existing identity administration suite passes unchanged in behavior after the
   `IdentityAuthorizer` delegation.
3. [ ] `GET /v1/meta/roles`, assignment routes, and access-explain match the published API
   reference after the documentation task.
4. [ ] PostgreSQL 16 and 17 both migrate, run the integration suite, and pass
   `pnpm db:types:check`.
5. [ ] No secret value, certificate private key, password, token, or cookie value enters an audit
   event, log line, or error response.
6. [ ] `pnpm verify` passes under Node 24.21.0.

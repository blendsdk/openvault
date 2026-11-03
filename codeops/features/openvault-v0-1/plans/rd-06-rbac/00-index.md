# RD-06 RBAC Implementation Plan

> **Feature**: Fixed-action, fixed-role authorization with organization, project, and object scopes; assignment administration with escalation guards; per-object capability flags; access explanations; and replacement of the narrow identity helper.
> **Status**: Planning Complete
> **Created**: 2026-11-03 19:45
> **Implements**: openvault-v0-1/RD-06
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault currently authorizes the identity administration API through a narrow helper that
hard-codes four `identity.*` actions and a reduced role set. RD-06 replaces that helper with the
full policy engine: 25 fixed actions, nine fixed roles, three scopes, deny-by-default evaluation,
and grant guards.

The engine is a pure decision function over the actor's live assignments and principal status. It
reads PostgreSQL on every request, so removing an assignment takes effect immediately. A single
`policy_state` row carries a monotonic version and serializes assignment mutations, which keeps
the last-org-admin invariant correct under concurrency. The same engine returns per-object
capability flags and powers `access-explain`, so the API, the future UI, and the audit trail share
one oracle.

RD-06 does not add project, secret, or certificate endpoints, does not persist the hash-chained
audit log, and does not implement the CLI or web UI. It ships a narrow audit port so every
enforcement decision and assignment mutation is recorded now; RD-07 replaces the logger adapter
with the persistent writer. RD-08 and RD-09 consume the capability API and enforce its actions in
their own routes.

## Minimum-Sufficient Baseline

**Original goal:** A denial-by-default authorization model with 25 actions, nine roles, three
scopes, guarded assignment changes, per-object capabilities, and an access explanation.

**Smallest viable design:** Encode the catalog and matrix as typed constants from the published
role reference. Add one `policy_state` row and one audit port. Reuse the existing PostgreSQL
query helper, request authentication context, WebAFX controllers, pino logger, rate limiter, and
integration-test harness. Evaluate from the database on every request; add no cache and no new
dependency.

**Excluded machinery:** Custom roles, wildcard actions, explicit deny rules, ABAC, group sync,
two-person approval, a decision cache, a policy language, an external authorization service, a
new test harness, project/secret/certificate endpoints (RD-08/RD-09), the persisted audit chain
(RD-07), and the CLI or web UI (RD-11/RD-12). See [AR-1](00-ambiguity-register.md#resolution-notes).

**Approved complexity:** None beyond direct feature code. `policy_state` and the audit port are
the smallest mechanisms that satisfy the accepted version-counter and evidence requirements; they
are not generalized frameworks. See AR-2, AR-3, and AR-21.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and resolution notes |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-06 |
| 02 | [Current State](02-current-state.md) | Existing identity authorization, auth context, schema, and tests |
| 03-01 | [Catalog, Schema, and Audit](03-01-catalog-schema-audit.md) | Contracts, action/role catalog, `policy_state`, audit port |
| 03-02 | [Policy Evaluator](03-02-policy-evaluator.md) | Decision algorithm, capabilities, identity bridge, runtime wiring |
| 03-03 | [Assignments and Access](03-03-assignments-access.md) | Assignment service, grant guards, last-admin, access-explain, meta, controllers |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Check one action

```ts
const decision = await policy.authorize(actorId, "secret.read", {
  type: "secret",
  id: secretId,
  projectId,
});
if (!decision.allowed) {
  throw new ApiError(403, "access_denied", "Access denied");
}
```

### Grant an assignment

```http
POST /v1/admin/assignments
{ "principalId": "01J...", "role": "secrets.reader",
  "scopeType": "object", "scopeId": "01J..." }
-> 201 { "id": "01J...", "principalId": "01J...", "role": "secrets.reader",
          "scopeType": "object", "scopeId": "01J...", "grantedBy": "01J...",
          "createdAt": "...", "expiresAt": null }
```

### Explain who can read a secret

```http
GET /v1/admin/access-explain?action=secret.read&scopeType=object&scopeId=01J...
-> 200 { "policyVersion": 12, "action": "secret.read",
          "scope": { "type": "object", "id": "01J..." },
          "principals": [ { "principalId": "01J...", "name": "api",
                            "kind": "service", "role": "secrets.reader",
                            "assignmentId": "01J...", "scopeType": "object",
                            "scopeId": "01J...", "consumer": { ... } } ] }
```

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Audit integration | Audit port plus structured-log adapter; RD-07 replaces the adapter | AR-2 |
| Policy propagation | Read version and assignments per request; no decision cache | AR-3 |
| Capabilities | Generic `authorize`/`capabilitiesFor` API; RD-08/RD-09 render flags | AR-4 |
| Access explain | Action plus resource query, scoped visibility | AR-5 |
| Assignment API | Tuple create, id delete, duplicate conflict | AR-6 |
| First org admin | Deployment prerequisite; tests seed directly | AR-7 |
| Rate limits | 30 writes and 60 reads per minute per principal | AR-8 |
| Mutation serialization | One `policy_state` row provides version and lock | AR-18, AR-21 |
| Identity bridge | Keep the RD-05 helper API and delegate to the evaluator | AR-22 |

## Cross-RD Acceptance Ownership

RD-06 acceptance criteria that depend on later surfaces remain owned as follows. This plan
implements the policy side and proves it directly; it does not claim the later surface.

| RD-06 item | This plan | Remaining owner |
|---|---|---|
| Acceptance 8 persisted audit evidence | Emits one decision/mutation event through the port | RD-07 persists the hash-chained event |
| Acceptance 9 secret response flags | Ships `capabilitiesFor` and tests the mapping | RD-08 renders flags on secret responses; RD-09 on certificate responses |
| Agent scaffold object grants (Must Have) | Ships the assignment API the scaffold calls | RD-10/RD-11 emit the grants or the exact command; project-wide reader is never implicit |
| Assignment expiry in UI/CLI (Should Have) | Returns `expiresAt` in every assignment response | RD-11 and RD-12 display it |
| Denial counter per principal (Should Have) | The logger adapter keeps a bounded per-principal denial count | RD-14 may aggregate it for abuse detection |
| Control-plane ceiling for identities (RD-05 residual) | Evaluator defense plus grant-time rejection | RD-06 owns the final matrix and tests it |

## Specialist Agents

**None** — the capability-gap check ran against this repository's evidence and found no gap a
standing specialist would close.

_Detection evidence: the action catalog and role matrix are fully specified in
`docs/reference/roles.md:8-88`, so no framework or protocol expertise is missing. The work is
ordinary TypeScript over the existing PostgreSQL, Express/WebAFX, and Vitest patterns at
`apps/server/src/identity/identity-authorizer.ts:1-136` and
`apps/server/tests/integration/identity-admin.spec.test.ts`. Generic correctness, security, and
concurrency reviewers already cover the policy and last-admin risks; a standing specialist would
restate the published matrix and the base lenses._

## Related Files

| File | Change |
|---|---|
| `packages/api-contract/src/rbac.ts` | New action, role, assignment, catalog, explain, and capability contracts |
| `packages/api-contract/src/index.ts` | Export the new contracts |
| `apps/server/src/database/schema.ts` | Add `policy_state` |
| `apps/server/migrations/` | Generated `policy_state` migration, snapshot, types, and seed |
| `apps/server/src/rbac/actions.ts` | 25-action catalog |
| `apps/server/src/rbac/roles.ts` | Nine roles, matrices, and scope eligibility |
| `apps/server/src/rbac/reasons.ts` | Stable decision reason codes |
| `apps/server/src/rbac/audit.ts` | Decision/mutation audit port and logger adapter |
| `apps/server/src/rbac/policy-repository.ts` | Actor snapshots, version row, assignments, resources |
| `apps/server/src/rbac/policy-service.ts` | Evaluator, capabilities, grant guards |
| `apps/server/src/rbac/assignment-service.ts` | Assignment lifecycle, last-admin, access explain |
| `apps/server/src/rbac/rate-limits.ts` | Admin write/read limiters |
| `apps/server/src/rbac/runtime.ts` | Composition and service registration values |
| `apps/server/src/identity/identity-authorizer.ts` | Delegate to the policy service |
| `apps/server/src/controllers/assignments.ts` | Assignment and access-explain routes |
| `apps/server/src/controllers/meta.ts` | Public role catalog route |
| `apps/server/src/app.ts` | Policy runtime, services, controllers |
| `docs/reference/api.md` | Assignment, explain, and meta examples |
| `docs/changelog.md`, `.changeset/` | User-visible release note |

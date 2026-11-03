# Assignments and Access: RD-06 RBAC

> **Document**: 03-03-assignments-access.md
> **Parent**: [Index](00-index.md)

## Overview

This component exposes the policy engine to administrators. It owns assignment creation, listing,
and deletion; the five grant guards; the last-active-org-admin invariant; the resource-aware access
explanation; the public role catalog; the admin rate limits; and the HTTP error mapping.

Every mutation runs in one PostgreSQL transaction whose first statement updates `policy_state`.
That update provides both the monotonic policy version and the lock that serializes concurrent
grants and revocations. The last-admin count is taken under the same lock, so two administrators
cannot remove each other and leave the organization without an administrator.

## Architecture

### Current Architecture

There are no assignment routes. The documented API reference lists
`GET/POST /v1/admin/assignments`, `DELETE /v1/admin/assignments/:id`, and
`GET /v1/admin/access-explain`, but all return 404. `GET /v1/meta/roles` is also documented but
missing. There is no admin-specific rate limiter for these routes.

### Proposed Changes

1. Add `apps/server/src/rbac/assignment-service.ts` for create, list, delete, and access-explain.
2. Add `apps/server/src/rbac/rate-limits.ts` for the admin write and read limiters.
3. Add `apps/server/src/controllers/assignments.ts` with the four admin routes.
4. Add `GET /roles` to `apps/server/src/controllers/meta.ts`.
5. Register the controllers and services in `apps/server/src/app.ts`.

## Implementation Details

### Assignment target resolution

```ts
export interface AssignmentTarget {
  readonly principalId: string;
  readonly principalKind: "user" | "service";
  readonly role: RbacRole;
  readonly scopeType: RbacScopeType;
  readonly scopeId: string;
  readonly resource: PolicyResource;
}
```

Resolution rules:

| Scope | Create validation | Resource for authorization |
|---|---|---|
| `org` | `scopeId` must be `org`; no project lookup | `{ type: "org", id: "org" }` |
| `project` | project must exist and not be soft-deleted; otherwise 422 `validation_error` | `{ type: "project", id: scopeId }` |
| `object` | role must be `secrets.reader` or `certificates.reader`; the row must exist in the matching table and not be soft-deleted; otherwise 422 | `{ type: "secret" \| "certificate", id: scopeId, projectId }` |

The object table is selected by role: `secrets.reader` reads `secrets`, `certificates.reader`
reads `certificates`. No other role is object-eligible, so no polymorphic column is needed.

For deletion and explanation, an object row that has been soft-deleted still provides its
`project_id`; a purged object no longer has a row. Deletion of an orphaned object assignment
falls back to the org resource, so only an org-scoped writer can clean it up. Explanation returns
404 for a missing object.

A target principal must exist. Its status does not block assignment creation; an inactive
principal simply receives no effective permission until it is active again. A service principal
targeted with a role whose actions intersect the control plane is rejected with 422
`service_control_plane`, because a service identity can never hold a control-plane action
(RD-06 Must Have).

### Create

```ts
public async create(
  actorId: string,
  input: AssignmentCreate,
  context?: PolicyAuditContext,
): Promise<Assignment>;
```

1. Start a transaction.
2. `UPDATE policy_state SET version = version + 1, updated_at = now() WHERE id = 1 RETURNING version`.
   This is the first statement, so every mutation serializes on the same row (AR-18, AR-21).
3. Load the target principal and resolve the target resource.
4. Reject a service target with a control-plane role (422 `service_control_plane`).
5. Call `policy.authorizeGrant(actorId, role, resource, context)` without audit.
6. Record exactly one decision event. If denied, map the reason:
   - `invalid_scope` or `service_control_plane` → 422.
   - `unknown_principal`, `inactive_principal`, `grant_scope_not_covered`,
     `grant_role_not_subset`, `grant_org_admin_forbidden` → 403 `access_denied`.
7. Insert the assignment with a new ULID. The database unique tuple is the duplicate oracle; a
   `23505` on that tuple returns 409 `assignment_conflict`.
8. Record the `assignment.grant` mutation event inside the transaction.
9. Commit and return the assignment.

If the audit port fails, the transaction rolls back and the controller returns 503. If the insert
conflicts, the version bump rolls back and no assignment row is committed. The logger adapter is
not transactional: a later database failure can leave a decision or mutation line in the log even
though the row rolled back. This is a known limitation until RD-07 writes the event in the same
transaction. The fail-closed direction is preserved: a mutation never commits without a successful
audit call.

### List

```ts
public async list(
  actorId: string,
  query: AssignmentListQuery,
  context?: PolicyAuditContext,
): Promise<readonly Assignment[]>;
```

1. Call `policy.authorizeList(actorId, "assignment.read", requestedScope, context)`. This records
   one list decision.
2. A denial returns 403 `access_denied`.
3. With `kind: "all"`, return every assignment matching the filters.
4. With `kind: "projects"`, return assignments whose project scope is in the visible set, plus
   object-scope assignments whose object belongs to a secret or certificate in a visible project.
   Org-scope assignments are not visible to a project-scoped reader.
5. Apply `principalId`, `role`, `scopeType`, and `scopeId` filters conjunctively.
6. Order by `created_at DESC, id DESC`. There is no pagination (AR-15).

The project visibility query uses `EXISTS` against `secrets` and `certificates`; it does not load
object rows into the application.

### Delete and last-admin guard

```ts
public async delete(
  actorId: string,
  assignmentId: string,
  context?: PolicyAuditContext,
): Promise<void>;
```

1. Start a transaction and bump/lock `policy_state`.
2. Load the assignment by id. Unknown id → 404 `assignment_not_found`.
3. Resolve the assignment's resource. An object assignment whose object row is gone falls back to
   the org resource.
4. Evaluate `assignment.write` on that resource without audit.
5. Record one decision event. If denied, return 404 `assignment_not_found` (AR-16); the audit
   event still records the real reason.
6. If the assignment is an active `org.admin` grant, count other active org administrators:
   principals with `kind='user'`, `status='active'`, and an unexpired `org.admin` assignment at
   `org`, excluding the target assignment. If the count is zero, record a denied decision with
   `last_org_admin` and return 409 `last_org_admin`.
7. Delete the row.
8. Record the `assignment.revoke` mutation event inside the transaction.
9. Commit.

"Active org administrator" means an active user principal holding an unexpired org-scoped
`org.admin` assignment. A disabled principal or an expired assignment does not count, so removing
one cannot trigger the guard. Because both delete transactions update `policy_state` before the
count, the invariant holds under concurrent deletes.

### Access explain

```ts
public async explain(
  actorId: string,
  query: AccessExplainQuery,
  context?: PolicyAuditContext,
): Promise<AccessExplainResponse>;
```

1. Resolve the requested resource:
   - `org`: `{ type: "org", id: "org" }`.
   - `project`: project must exist and not be soft-deleted; otherwise 404 `resource_not_found`.
   - `object`: infer the object type from `objectType` or the action prefix
     (`secret.` → secret, `certificate.` → certificate, `identity.` → identity). A missing or
     unsupported type is 422. The row must exist; a soft-deleted secret or certificate is 404.
     A service identity uses its owner project; a human identity has no project.
2. Evaluate `assignment.read` on that resource with audit. A denial returns 404
   `resource_not_found`, so a project-scoped caller cannot discover another project's resource.
3. Load the policy version and every active principal with its active assignments and optional
   consumer row. This is one query over `principals`, `role_assignments`, and `consumers`.
4. For each principal, evaluate the action against the resource with the same pure function used
   by `authorize`. Include one entry for each assignment that independently grants the action.
   Exclude principals with no granting assignment. Do not emit a decision event per principal;
   the explain request is a projection and its single `assignment.read` check is the audited
   decision (AR-10).
5. Sort by principal name, principal id, then assignment id.
6. Return `{ policyVersion, action, scope, principals }`.

The response never includes secret values, certificate bodies, private keys, tokens, or
assignment grantor emails. The consumer projection is limited to compose project, compose service,
hostname, state, and last-seen time.

### Role catalog

`GET /v1/meta/roles` returns:

```json
{
  "actions": [
    { "name": "project.create", "plane": "control", "description": "Create a project" }
  ],
  "roles": [
    { "name": "org.admin",
      "actions": ["project.create", "..."],
      "scopes": ["org"] }
  ],
  "policyVersion": 7
}
```

The route is public on the admin listener (AR-11). It returns only static catalog data and the
version; it never returns assignments, principals, or project data. A missing `policy_state` row
returns 503 `service_unavailable`.

### Routes and rate limits

| Method | Path | Handler | Limiter |
|---|---|---|---|
| GET | `/v1/admin/assignments` | `AssignmentService.list` | 60/minute per principal |
| POST | `/v1/admin/assignments` | `AssignmentService.create` | 30/minute per principal |
| DELETE | `/v1/admin/assignments/:id` | `AssignmentService.delete` | 30/minute per principal |
| GET | `/v1/admin/access-explain` | `AssignmentService.explain` | 60/minute per principal |
| GET | `/v1/meta/roles` | catalog read | none; public static metadata |

Both loops use the existing WebAFX `rateLimitMiddleware` with `windowMs: 60_000` and a key
extractor of `principal:${req.auth?.user.id ?? "anonymous"}`. The limiter service is created once
per application and resolved through the service container, following the login and agent
limiter patterns. A rejected request returns the standard 429 `RATE_LIMIT_EXCEEDED` envelope.

### HTTP mapping

| Condition | Status | Code |
|---|---|---|
| Policy denial on assignment write | 403 | `access_denied` |
| Policy denial on list | 403 | `access_denied` |
| Hidden assignment or explain resource | 404 | `assignment_not_found` / `resource_not_found` |
| Duplicate assignment tuple | 409 | `assignment_conflict` |
| Removing the last active org admin | 409 | `last_org_admin` |
| Service target with a control-plane role | 422 | `service_control_plane` |
| Contract or scope validation failure | 422 | `validation_error` |
| Database, version, or audit failure | 503 | `service_unavailable` |
| Rate limit exceeded | 429 | `RATE_LIMIT_EXCEEDED` |

An unauthenticated request is rejected by the auth plugin with 401 before any controller runs.

### Contracts

Add to `packages/api-contract/src/rbac.ts`:

```ts
export const assignmentListSchema = z.strictObject({
  assignments: z.array(assignmentSchema),
});
```

The create route returns `assignmentSchema` directly with 201. The delete route returns 204 with
no body. The explain and catalog routes return their strict response schemas.

## Code Examples

### Grant a project-scoped reader

```http
POST /v1/admin/assignments
{ "principalId": "01J8...", "role": "secrets.reader",
  "scopeType": "project", "scopeId": "01J7..." }
-> 201 { "id": "01J9...", "principalId": "01J8...", "role": "secrets.reader",
          "scopeType": "project", "scopeId": "01J7...", "grantedBy": "01J6...",
          "createdAt": "2026-11-03T19:00:00.000Z", "expiresAt": null }
```

### Explain a project resource

```http
GET /v1/admin/access-explain?action=secret.read&scopeType=project&scopeId=01J7...
-> 200 { "policyVersion": 8, "action": "secret.read",
          "scope": { "type": "project", "id": "01J7..." },
          "principals": [
            { "principalId": "01J8...", "name": "payments-api", "kind": "service",
              "role": "secrets.reader", "assignmentId": "01J9...",
              "scopeType": "project", "scopeId": "01J7...",
              "consumer": { "composeProject": "payments", "composeService": "api",
                            "hostname": "api-1", "state": "ok",
                            "lastSeen": "2026-11-03T18:59:00.000Z" } }
          ] }
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Unknown or malformed assignment id | 404 `assignment_not_found` | AR-16 |
| Duplicate tuple | 409 `assignment_conflict` | AR-6 |
| Object role other than a reader | 422 `validation_error` | AR-6 |
| Non-existent project/object on create | 422 `validation_error` | AR-13, AR-27 |
| Non-existent or invisible explain resource | 404 `resource_not_found` | AR-13 |
| Last active org admin delete | 409 `last_org_admin`; transaction rolls back | AR-18 |
| Concurrent last-admin deletes | `policy_state` lock serializes; exactly one succeeds | AR-18 |
| Audit failure during a mutation | Transaction rolls back; 503 | AR-9 |
| Policy version missing | 503 `service_unavailable` | AR-21 |
| Assignment write/read flood | 429 `RATE_LIMIT_EXCEEDED` | AR-8 |

## Testing Requirements

- Contract tests for create, list, delete, explain, and catalog responses.
- Integration tests for every grant guard, the last-admin invariant (including concurrency),
  scoped list visibility, and explain matching the evaluator.
- Rate-limit tests for 30 writes and 60 reads per minute.
- Audit tests for one decision event per create/delete/list/explain and one mutation event per
  successful grant/revoke.
- Latency/visibility tests for project-scoped readers and hidden resources.
- Existing identity admin tests must pass unchanged.

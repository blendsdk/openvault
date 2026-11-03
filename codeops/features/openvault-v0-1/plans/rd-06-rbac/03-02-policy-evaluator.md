# Policy Evaluator: RD-06 RBAC

> **Document**: 03-02-policy-evaluator.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the decision function, the actor snapshot, scope matching, capability flags,
the identity-helper bridge, and runtime composition. Every authorization check in the product
must pass through this evaluator. Controllers and services never inspect role names directly.

The evaluator is deliberately stateless between calls. It reads the policy version and the
actor's assignments from PostgreSQL on every decision, so a removed assignment cannot be served
from a stale cache. The version is returned in the decision for the audit event and for callers
that later add a cache.

## Architecture

### Current Architecture

`IdentityAuthorizer` loads unexpired assignments for an active human principal and checks
hard-coded role sets. It has no action catalog, no data-plane support, no object scope, no
capability helper, and no audit. Runtime composition creates it from a `QueryExecutor` only.

### Proposed Changes

1. Add `apps/server/src/rbac/policy-repository.ts` for actor snapshots, policy version reads and
   bumps, resource resolution, assignment rows, and access-explain candidate rows.
2. Add `apps/server/src/rbac/policy-service.ts` with `authorize`, `authorizeList`,
   `authorizeGrant`, `capabilitiesFor`, `recordDecision`, and the scope-matching helpers.
3. Add `apps/server/src/rbac/runtime.ts` that composes the repository, audit port, policy service,
   assignment service, and rate limits.
4. Replace the internals of `apps/server/src/identity/identity-authorizer.ts` with the policy
   service while preserving its public methods and RD-05 behavior.
5. Wire the policy runtime through `createIdentityRuntime`, `createAgentRuntime`, and
   `createApplication`.

## Implementation Details

### Resource descriptor

```ts
export type PolicyResource =
  | { readonly type: "org"; readonly id: "org" }
  | { readonly type: "project"; readonly id: string }
  | { readonly type: "identity"; readonly id: string; readonly projectId?: string }
  | { readonly type: "secret"; readonly id: string; readonly projectId: string }
  | { readonly type: "certificate"; readonly id: string; readonly projectId: string };
```

A human identity has no `projectId`; only an org-scoped assignment can cover it. A service
identity always has one. Object resources always carry the owning project so project-scope
coverage can be decided without another query.

### Actor snapshot

```ts
export interface ActorAssignment {
  readonly id: string;
  readonly role: RbacRole;
  readonly scopeType: RbacScopeType;
  readonly scopeId: string;
  readonly expiresAt: Date | null;
}

export interface ActorSnapshot {
  readonly principalId: string;
  readonly kind: "user" | "service";
  readonly status: "active" | "disabled";
  readonly policyVersion: number;
  readonly assignments: readonly ActorAssignment[];
}
```

`PolicyRepository.loadActorSnapshot(actorId)` uses one statement so the principal, version, and
assignment rows share a statement snapshot:

```sql
SELECT p.id AS principal_id, p.kind, p.status,
       (SELECT version FROM policy_state WHERE id = 1) AS policy_version,
       r.id AS assignment_id, r.role, r.scope_type, r.scope_id, r.expires_at
  FROM principals p
  LEFT JOIN role_assignments r ON r.principal_id = p.id
 WHERE p.id = :actorId
```

No rows means the principal does not exist. A row with `policy_version IS NULL` means the version
row is missing; the repository raises `PolicyUnavailableError`. The query is indexed by
`role_assignments_principal_idx`.

### Decision algorithm

`authorize(actorId, action, resource, context?, options?)` returns:

```ts
export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: PolicyReason;
  readonly policyVersion: number;
  readonly actorId: string;
  readonly actorKind: "user" | "service";
  readonly action: RbacAction;
  readonly resource: PolicyResource;
  readonly assignment: {
    readonly id: string;
    readonly role: RbacRole;
    readonly scopeType: RbacScopeType;
    readonly scopeId: string;
  } | null;
}
```

The steps are:

1. Load the actor snapshot. Missing principal → deny `unknown_principal`. A missing version row
   or a query failure raises `PolicyUnavailableError`.
2. `status !== "active"` → deny `inactive_principal`.
3. `kind === "service"` and the action is control-plane → deny `service_control_plane`. This is
   defense in depth; the assignment service also rejects such grants.
4. Filter assignments whose role is eligible at the recorded scope type
   (`roleEligibleAt(role, scopeType)`) and whose role contains the action.
5. Split the filtered set by expiry: an assignment is active when `expiresAt` is null or later
   than the current time.
6. Apply scope coverage:
   - `org` covers every resource.
   - `project` covers a project resource with the same id, or an identity/secret/certificate
     resource whose `projectId` equals the assignment's `scopeId`.
   - `object` covers only a secret resource when the role is `secrets.reader`, or a certificate
     resource when the role is `certificates.reader`, and the resource id equals the assignment's
     `scopeId`. Object scope never covers a project or a list operation.
7. If any active assignment covers the resource, allow with `reason: "allowed"` and the most
   specific matching assignment (object, then project, then org; ties broken by assignment id).
8. If no active assignment matches but a filtered assignment is expired, deny
   `expired_assignment`.
9. If the actor has an assignment whose role contains the action but no assignment reaches the
   resource (wrong project, ineligible scope, or object scope on a list), deny `scope_mismatch`.
10. Otherwise deny `no_assignment`.

The evaluator never throws for a denial. A database failure or a missing `policy_state` row
raises `PolicyUnavailableError`.

### List authorization

`authorizeList(actorId, action, requestedScope, context?)` handles routes that return a collection
rather than one resource, such as the identity list and the assignment list. It uses the same
snapshot and returns:

```ts
export interface PolicyListDecision {
  readonly decision: PolicyDecision;
  readonly visibility:
    | { readonly kind: "all" }
    | { readonly kind: "projects"; readonly projectIds: readonly string[] };
}
```

- An org-scoped assignment whose role contains the action grants `kind: "all"`.
- Otherwise project-scoped assignments whose roles contain the action grant
  `kind: "projects"` with the distinct project ids.
- Object-scoped assignments never grant a list.
- If `requestedScope` is a project that is not in the visible set, deny `scope_mismatch`.
- If nothing matches, deny `no_assignment`.
- One decision event is recorded for the list request. The scope in that event is `org` for
  `kind: "all"` and the requested or first visible project for `kind: "projects"`.
- An empty project list is a denial, not an empty success. This is the RD-06 deny-by-default
  requirement and changes the current identity list, which returns an empty array.

### Any-scope decision

`hasAny(actorId, action, context?)` answers the identity helper's "does this actor hold the action
somewhere?" hint. It loads one snapshot and records one decision with `scopeType: "system"` and
`scopeId: null`. A control-plane action held by a service principal denies
`service_control_plane`. This is a real authorization decision, so it is audited; a later
specific-project check is a second decision and produces its own event.

### Grant authorization

`authorizeGrant(actorId, role, resource, context?)` evaluates the five grant guards without
auditing, so the assignment service can record one composite decision:

1. Missing principal → deny `unknown_principal`.
2. Inactive principal → deny `inactive_principal`.
3. Service actor → deny `service_control_plane`.
4. Role not eligible at the resource's scope type → deny `invalid_scope`.
5. Actor lacks `assignment.write` on the resource → deny `grant_scope_not_covered`.
6. Any action of the target role is outside the actor's effective actions on the resource →
   deny `grant_role_not_subset`.
7. The target role is `org.admin` and the actor lacks an active org-scoped `org.admin`
   assignment → deny `grant_org_admin_forbidden`.
8. Otherwise allow with `reason: "allowed"`.

`effectiveActions` evaluates the actor's active assignments against the resource for every action
in the catalog. It is an in-memory loop over one snapshot, not 25 database queries.

The assignment service decides whether the target is a service identity and whether the role
contains a control-plane action; that check returns `service_control_plane` before
`authorizeGrant` is called. The evaluator repeats the service-actor check as defense in depth.

### Capabilities

```ts
export interface PolicyCapabilities {
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canDelete: boolean;
  readonly canPurge: boolean;
  readonly canManage: boolean;
}

public async capabilitiesFor(
  actorId: string,
  resource: Extract<PolicyResource, { type: "secret" | "certificate" }>,
): Promise<PolicyCapabilities> {
  // Load one snapshot; evaluate five actions in memory; no audit event.
}
```

Mapping (AR-12):

| Flag | Secret resource | Certificate resource |
|---|---|---|
| `canRead` | `secret.read` | `certificate.read` |
| `canWrite` | `secret.write` | `certificate.write` |
| `canDelete` | `secret.delete` | `certificate.delete` |
| `canPurge` | `secret.purge` | `certificate.purge` |
| `canManage` | `assignment.write` | `assignment.write` |

A missing or inactive actor yields all false. A database failure raises
`PolicyUnavailableError`. Capability projection emits no audit event (AR-10); the enforcing
controller records the action it actually checks.

### Identity bridge

`IdentityAuthorizer` keeps its four public methods:

| Method | Delegation |
|---|---|
| `can(action, actorId, projectId)` | `authorize(actorId, action, { type: "project", id: projectId })` |
| `hasAny(action, actorId)` | `policy.hasAny(actorId, action)` with one system-scope decision event |
| `canReadAll(actorId)` | Org decision for `identity.read`; no audit |
| `readableProjectIds(actorId)` | Snapshot filter for project-scoped roles containing `identity.read`; no audit |

It adds one method for the identity list:

```ts
public async readScope(
  actorId: string,
  context?: PolicyAuditContext,
): Promise<{ readonly kind: "all" } | { readonly kind: "projects"; readonly projectIds: readonly string[] } | undefined>
```

`readScope` calls `authorizeList(actorId, "identity.read", { type: "org", id: "org" }, context)`,
records the one list decision, and returns `undefined` on denial. `IdentityService.list` uses
`readScope` when no project filter is supplied, and keeps the single-project `can` check when a
filter is supplied. A denied list returns 403 `access_denied` instead of an empty array.

The constructor remains compatible:

```ts
public constructor(database: QueryExecutor, policy?: PolicyService)
```

When `policy` is omitted, the bridge creates a policy service with the logger adapter over a
silent logger. Production composition always passes the shared policy service; the default exists
only for direct unit construction and the RD-05 identity-runtime tests.

### Runtime composition

```ts
export interface PolicyRuntime {
  readonly repository: PolicyRepository;
  readonly audit: PolicyAuditPort;
  readonly service: PolicyService;
  readonly assignments: AssignmentService;
  readonly rateLimits: RbacRateLimitService;
}

export function createPolicyRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly logger?: Logger;
}): PolicyRuntime;
```

- `createIdentityRuntime` accepts an optional `policyService` and exposes the service on
  `IdentityRuntime`.
- `createAgentRuntime` creates one policy runtime with its logger, passes the service into the
  identity runtime, and exposes the policy runtime on `AgentRuntime`.
- `createApplication` uses the agent runtime's policy runtime when present; otherwise it creates
  one with the application logger. It registers `policyRepository`, `policyAudit`,
  `policyService`, `assignmentService`, and `rbacRateLimits` as singletons.
- `createTestApplication` uses the same composition; no new test-only seam is needed because the
  policy runtime has no side effects until a route is called.

## Code Examples

### Evaluate and audit

```ts
const decision = await policy.authorize(actor.user.id, "secret.read", resource, {
  requestId: req.id,
  sourceIp: req.ip,
  userAgent: req.headers["user-agent"],
});
if (!decision.allowed) {
  throw new ApiError(403, "access_denied", "Access denied");
}
```

### Composite grant decision

```ts
const decision = await policy.authorizeGrant(actorId, input.role, targetResource, context);
await policy.recordDecision(decision, context);
if (!decision.allowed) {
  throw new RbacServiceError(403, "access_denied", "Access denied");
}
```

### Capabilities

```ts
const flags = await policy.capabilitiesFor(actorId, {
  type: "secret",
  id: secret.id,
  projectId: secret.projectId,
});
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Missing principal snapshot | Deny `unknown_principal`; no exception | AR-19 |
| Disabled principal | Deny `inactive_principal` | AR-19 |
| Service principal with a control-plane action | Deny `service_control_plane` | RD-06 Must Have |
| Expired assignment only | Deny `expired_assignment` | RD-06 Must Have |
| Assignment exists but wrong scope | Deny `scope_mismatch` | RD-06 Technical Requirements |
| No relevant assignment | Deny `no_assignment` | RD-06 Must Have |
| Missing `policy_state` row | `PolicyUnavailableError`; 503 | AR-21, AR-27 |
| Database failure during a decision | `PolicyUnavailableError`; 503 | AR-27 |
| Audit adapter rejects | `PolicyUnavailableError`; mutation rolls back | AR-9 |
| List with no visible scope | Deny; 403 | RD-06 Acceptance 2 |

## Testing Requirements

- Unit and integration tests for every scope/role/action combination in the matrix.
- Tests for inactive principals, expired assignments, service control-plane denial, ineligible
  scope rows, and object-scope non-inheritance.
- Capability flag tests for both secret and certificate resources.
- Identity bridge tests that keep the RD-05 behavior and add the list denial.
- Audit tests for exactly one event per `authorize` and zero events for `capabilitiesFor`.
- Concurrency tests for version reads and assignment mutation serialization.

# Current State: RD-06 RBAC

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The schema already has `role_assignments` with the nine permitted role names, the three scope
types, a `granted_by` foreign key, an optional `expires_at`, and a unique tuple on
`(principal_id, role, scope_type, scope_id)`. Database checks already restrict object scope to the
two reader roles. `principals` already distinguishes `user` and `service` kinds and carries
`status`, `owner_project_id`, and `disabled_at`.

Authorization is currently a narrow helper. `IdentityAuthorizer` reads unexpired assignments for
an active human principal and answers four identity actions using hard-coded role sets. It ignores
a project-scoped `org.admin`, treats an org-scoped `auditor` as a reader, and exposes
`canReadAll` and `readableProjectIds` for list filtering. `IdentityService` calls it before every
identity mutation and read.

The auth middleware attaches `req.auth` for browser sessions and CLI bearer tokens. Both variants
carry `user.id`, `user.name`, and the session/family metadata. Controllers use
`requirePrincipal(req)` to obtain that context. There is no service-principal request context on
the admin listener; agents are handled separately on the agent listener.

A public `MetaController` currently serves only `GET /v1/meta/auth`. The API reference already
documents `GET /v1/meta/roles`, `GET/POST /v1/admin/assignments`,
`DELETE /v1/admin/assignments/:id`, and `GET /v1/admin/access-explain`, but none of those routes
exist. The role matrix is published in `docs/reference/roles.md` and is the required oracle.

The audit schema exists (`audit_events`, `audit_keys`, `audit_checkpoints` and append-only
triggers), but no writer exists. RD-07 owns the hash chain, HMAC, checkpoints, verify/export, and
retention. RD-06 therefore needs a port, not a second audit implementation.

Rate limiting is an established pattern: `rateLimitMiddleware` from WebAFX with an in-memory
bucket and a key extractor, wrapped in a service resolved at request time. Login and refresh use
it; the agent join/renew routes use their own service with test-only thresholds.

Integration tests use a disposable PostgreSQL database, real migrations, real HTTPS listeners
when a route is involved, and real WebAFX controllers. The identity administration suite already
covers create, list, detail, revoke, join-token issuance, and the narrow authorization matrix.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/identity/identity-authorizer.ts` | Narrow four-action helper | Delegate to the policy service; keep the public methods |
| `apps/server/src/identity/identity-runtime.ts` | Builds the identity service | Accept and pass the policy service |
| `apps/server/src/identity/identity-service.ts` | Identity lifecycle and admin rules | No behavioral change; audit now flows through the evaluator |
| `apps/server/src/controllers/identity.ts` | Identity admin routes | No route change; error mapping already stable |
| `apps/server/src/controllers/meta.ts` | Public auth metadata | Add `GET /roles` |
| `apps/server/src/app.ts` | Application composition | Create/register the policy runtime and new controllers |
| `apps/server/src/agent/agent-runtime.ts` | Owns the identity runtime | Pass the shared policy service into it |
| `apps/server/src/database/schema.ts` | Desired schema | Add `policy_state` |
| `apps/server/src/auth/middleware.ts` | Attaches `req.auth` | No change; reused by the new controllers |
| `apps/server/src/auth/login-rate-limits.ts` | Existing limiter pattern | Reuse the pattern for RBAC limiters |
| `apps/server/src/observability/logger.ts` | Pino provider and redaction | No new secret fields; audit events carry identifiers only |
| `packages/api-contract/src/` | Existing strict Zod contracts | Add `rbac.ts` and export it |
| `apps/server/tests/integration/identity-admin.spec.test.ts` | RD-05 admin behavior oracle | Must keep passing without expectation changes |
| `docs/reference/roles.md` | Published matrix and scope table | Read-only oracle; update only if a documentation error is found |
| `docs/reference/api.md` | Route list and request/response examples | Add the RBAC examples |

### Code Analysis

The narrow helper loads assignments with one query:

```ts
SELECT r.role, r.scope_type, r.scope_id
  FROM principals p
  JOIN role_assignments r ON r.principal_id = p.id
 WHERE p.id = :actorId
   AND p.kind = 'user'
   AND p.status = 'active'
   AND (r.expires_at IS NULL OR r.expires_at > now())
```

The full evaluator needs the same join plus the actor's `kind`, because service principals must be
denied control-plane actions. The helper's role sets are a hand-reduced matrix; RD-06 replaces
them with the catalog constants and one scope-matching function.

The helper's identity-specific semantics are important and must survive the bridge:

| Method | RD-05 behavior | Full-evaluator equivalent |
|---|---|---|
| `can(action, actor, projectId)` | Org-scoped admin/project-admin/auditor read; project-scoped admin writes and reads its project; project-scoped `org.admin` ignored | Evaluate the action against the project resource |
| `hasAny(action, actor)` | True when any scope-eligible role covers the action somewhere | Inspect the actor snapshot with the catalog |
| `canReadAll(actor)` | True for an org-scoped admin, project-admin, or auditor | Evaluate `identity.read` on the org resource |
| `readableProjectIds(actor)` | Project ids from project-scoped read roles | Snapshot filter over roles containing `identity.read` |

## Gaps Identified

### Gap 1: No full evaluator

**Current Behavior:** Only four `identity.*` actions are checked, through role sets that cannot
serve data-plane actions or object scope.
**Required Behavior:** All 25 actions evaluate through one scope-aware function over the live
assignment set.
**Fix Required:** Add the catalog, role matrix, scope eligibility, decision reasons, repository,
and policy service; delegate the identity helper.

### Gap 2: No assignment administration

**Current Behavior:** Assignments exist only as schema rows and test fixtures.
**Required Behavior:** Authorized create/list/delete routes with the five grant guards, expiry,
scoped visibility, duplicate conflict, and last-admin protection.
**Fix Required:** Add the assignment service, controller, contracts, rate limits, and tests.

### Gap 3: No policy version or mutation serialization

**Current Behavior:** Nothing serializes concurrent assignment changes, so two administrators
could remove the last org admin at the same time.
**Required Behavior:** Every assignment mutation updates a single version row inside its
transaction and checks the last-admin invariant under that lock.
**Fix Required:** Add `policy_state`, seed one row, and use its update as the transaction's first
statement.

### Gap 4: No decision audit or capability surface

**Current Behavior:** Identity authorization decisions are silent; no capability helper exists.
**Required Behavior:** One audit event per enforcement decision, one mutation event per successful
change, and `capabilitiesFor` over the same evaluator.
**Fix Required:** Add the audit port and logger adapter, the capability mapping, and call sites in
the identity and assignment services.

### Gap 5: No role catalog or access explanation

**Current Behavior:** `GET /v1/meta/roles` and `GET /v1/admin/access-explain` are documented but
return 404.
**Required Behavior:** A public catalog with the policy version and an authorized, scoped
resource explanation listing effective principals and consumers.
**Fix Required:** Add the meta route and the access-explain service/controller.

## Dependencies

### Internal Dependencies

- RD-03/RD-04 auth context: `req.auth.user.id`, `requirePrincipal`, browser and CLI sessions.
- RD-05 `IdentityService`, `IdentityRepository`, `IdentityRuntime`, identity error family, and the
  identity admin test suite.
- Existing `role_assignments`, `principals`, `projects`, `secrets`, `certificates`, and
  `consumers` tables.
- Existing PostgreSQL transaction helper, WebAFX controllers/envelopes, pino logger, and rate
  limiter.

### External Dependencies

None. The plan adds no package, service, or infrastructure.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Matrix drift from the published reference | Medium | High | Encode the matrix once; a contract test compares every role/action/scope to expected tables; docs stay the oracle |
| Last-admin race under concurrent deletes | Medium | High | Update `policy_state` first in both transactions; count under the same lock; integration test forces overlap |
| Identity admin regression after delegation | Medium | High | Keep the helper API; run the unchanged RD-05 suite; add bridge-specific matrix cases |
| Audit port becomes a second audit implementation | Low | High | Port only; logger adapter has no schema or chain logic; RD-07 replaces it |
| Hidden-resource leakage through assignment ids | Medium | Medium | Out-of-scope ids return 404; explain validates visibility before listing |
| Policy read cost on every request | Low | Medium | One indexed query by actor id; no cache is the accepted trade-off (AR-3) |

## Ambiguity Register: RD-06 RBAC Plan

> **Status**: ✅ GATE PASSED — all 27 items resolved
> **Last Updated**: 2026-11-03 19:38
> **Mode**: make-plan (normal mode)
> **Source**: [RD-06](../../requirements/RD-06-rbac.md), [roles reference](../../../../../docs/reference/roles.md), and [API reference](../../../../../docs/reference/api.md)

The RD-06 scope, action catalog, role matrix, scope rules, and grant guards are already
authorized by the requirements document and the published role reference. They are imported as
resolved context and are not re-litigated. AR-1 is the planning-scope baseline; AR-2 through AR-8
are the user's interview decisions; AR-9 through AR-27 are plan-local technical or behavioral
choices the user confirmed by bulk acceptance on 2026-11-03.

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|---|---|---|---|---|
| AR-1 | Scope | Which parts of the authorization model this plan implements | A: RBAC policy engine, assignment admin API, meta catalog, capabilities helper, access-explain / B: also project, secret, certificate, UI, and CLI surfaces | A — RD-06 only. RD-07 owns persisted audit, RD-08/RD-09 own object endpoints and capability rendering, RD-11/RD-12 own clients. | ✅ Resolved |
| AR-2 | Integration | How RD-06 audits decisions while RD-07 is not implemented | A: audit port plus structured-log adapter / B: write audit_events rows now / C: defer audit to RD-07 | A — audit port plus structured-log adapter; RD-07 replaces the adapter without changing callers. | ✅ Resolved |
| AR-3 | Technical | How assignment changes propagate within five seconds | A: policy_state version plus assignment read per request, no decision cache / B: versioned five-second cache / C: no version table | A — every request reads the current version and assignments; no decision cache; revocation is immediate. | ✅ Resolved |
| AR-4 | Integration | What RD-06 ships for per-object capability flags while RD-08/RD-09 objects do not exist | A: generic authorize() plus capabilitiesFor() over a resource descriptor / B: temporary capabilities endpoint / C: defer flags | A — ship the generic policy API and test it with synthetic resources; RD-08/RD-09 call it for their responses. | ✅ Resolved |
| AR-5 | Integration | Contract for GET /v1/admin/access-explain | A: query by action plus resource identity; return matching principals, role, assignment, and consumers / B: per-principal explanation / C: full policy dump | A — resource-plus-action query with scoped visibility. | ✅ Resolved |
| AR-6 | Integration | Assignment admin API shape | A: tuple create, id delete / B: tuple delete / C: PATCH lifecycle | A — POST {principalId, role, scopeType, scopeId, expiresAt?} returns 201; GET filters; DELETE /:id returns 204; duplicate tuple returns 409. | ✅ Resolved |
| AR-7 | Scope | Who creates the first org.admin assignment | A: deployment prerequisite; tests seed directly / B: bootstrap command / C: first-admin endpoint | A — deployment provisioning seeds the first org.admin; RD-06 adds no bootstrap surface. | ✅ Resolved |
| AR-8 | Non-functional | Rate limits for assignment writes and access-explain reads | A: 30 writes and 60 reads per minute per principal / B: 10 and 30 / C: no new limiter | A — 30 writes and 60 reads per minute per authenticated principal; 429 RATE_LIMIT_EXCEEDED. | ✅ Resolved |
| AR-9 | Behavioral | What happens when the audit port fails while recording a decision or assignment change | A: fail closed with 503; assignment transaction rolls back / B: log the failure and continue | User accepted recommendation: Recommended A. Audit evidence is part of the authorization contract; an unaudited allow or deny must not be returned. | ✅ Resolved |
| AR-10 | Behavioral | Audit granularity for capability projections that evaluate several actions | A: authorize() emits one event per decision; capabilitiesFor() projects flags without separate decision events / B: one event for every flag | User accepted recommendation: Recommended A. A capability projection is not an enforcement decision; the controller's enforcement point produces the event. | ✅ Resolved |
| AR-11 | Integration | Whether GET /v1/meta/roles is public or authenticated | A: public on the admin listener / B: require a signed-in principal | User accepted recommendation: Recommended A. The matrix is already published in the public documentation and contains no tenant data. | ✅ Resolved |
| AR-12 | Behavioral | Which action backs each capability flag | A: read/write/delete/purge map to the matching object action; canManage maps to assignment.write / B: canManage maps to object write / C: caller supplies every mapping | User accepted recommendation: Recommended A. Manage means changing who can access the object, which is assignment.write, not object content write. | ✅ Resolved |
| AR-13 | Behavioral | Whether access-explain accepts arbitrary scope ids or requires an existing resource | A: validate the project or object exists and is visible; infer object table from the action prefix; 404 otherwise / B: evaluate arbitrary ids | User accepted recommendation: Recommended A. The explanation must describe a real resource and must not reveal invisible ones. | ✅ Resolved |
| AR-14 | Behavioral | Assignment expiry validation | A: optional ISO-8601 timestamp; must be in the future; no maximum / B: also cap at one year / C: allow past timestamps | User accepted recommendation: Recommended A. A past expiry is a no-op grant and should return 422. | ✅ Resolved |
| AR-15 | Behavioral | Assignment list filtering and pagination | A: filters principalId, role, scopeType, scopeId; newest first; no pagination / B: cursor pagination / C: no filters | User accepted recommendation: Recommended A. Admin assignment volume is small and the documented routes do not specify a cursor. | ✅ Resolved |
| AR-16 | Behavioral | Response for an assignment outside the caller's visible scope | A: 404 assignment_not_found; duplicate tuple 409 assignment_conflict; invalid input 422 / B: 403 for all three | User accepted recommendation: Recommended A. Hidden existence matches the identity API and avoids leaking assignments across projects. | ✅ Resolved |
| AR-17 | Integration | Where the policy version is exposed | A: GET /v1/meta/roles and GET /v1/admin/access-explain / B: only access-explain / C: never expose it | User accepted recommendation: Recommended A. Meta callers need the catalog and version together; access-explain callers need the version for cache coherence. | ✅ Resolved |
| AR-18 | Concurrency | How last-org-admin and grant checks serialize against concurrent changes | A: every assignment mutation updates the single policy_state row inside the transaction, serializing mutations; count admins after the update / B: advisory lock on a constant / C: no serialization | User accepted recommendation: Recommended A. The version bump and the mutation lock are the same row, so one mechanism provides both. | ✅ Resolved |
| AR-19 | UX & presentation | Stable reason codes for allow and denial audit events | A: fixed enum (allowed, inactive_principal, no_assignment, scope_mismatch, expired_assignment, service_control_plane, grant_scope_not_covered, grant_role_not_subset, grant_org_admin_forbidden, last_org_admin, unknown_principal, invalid_scope, duplicate_assignment) / B: free-form strings per caller | User accepted recommendation: Recommended A. Tests and RD-07 filters need a stable vocabulary. | ✅ Resolved |
| AR-20 | Integration | Audit action strings for successful assignment mutations | A: assignment.grant and assignment.revoke, in addition to the assignment.write decision event / B: only assignment.write | User accepted recommendation: Recommended A. Mutations are evidence separate from the authorization decision that permitted them. | ✅ Resolved |
| AR-21 | Data & state | Exact policy version storage | A: single-row policy_state(id smallint primary key, version bigint, updated_at); seeded row id=1; assignment writes increment it / B: sequence / C: app process counter | User accepted recommendation: Recommended A. A row update serializes writers and survives restarts. | ✅ Resolved |
| AR-22 | Integration | How the RD-05 IdentityAuthorizer is replaced | A: keep its public methods and constructor contract, back them with the evaluator, and preserve RD-05 behavior / B: replace callers with a new service / C: leave both implementations | User accepted recommendation: Recommended A. The identity admin API and its tests must not change behavior. | ✅ Resolved |
| AR-23 | Naming & terminology | Public type and module names | A: rbac/actions.ts, rbac/roles.ts, rbac/policy-state.ts, rbac/policy-repository.ts, rbac/policy-service.ts, rbac/assignment-service.ts, rbac/access-explain.ts, controllers/assignments.ts / B: identity/ naming / C: auth/ naming | User accepted recommendation: Recommended A. RBAC is a distinct domain used by identity, data-plane, and admin surfaces. | ✅ Resolved |
| AR-24 | Integration | GET /v1/meta/roles response shape | A: { actions: [{ name, plane, description }], roles: [{ name, actions, scopes }], policyVersion } / B: matrix table / C: names only | User accepted recommendation: Recommended A. This is the machine-readable catalog the UI and CLI consume. | ✅ Resolved |
| AR-25 | Integration | GET /v1/admin/access-explain response shape | A: { policyVersion, action, scope: { type, id }, principals: [{ principalId, name, kind, role, assignmentId, scopeType, scopeId, consumer? }] } / B: map of principal id to actions / C: flat assignment list | User accepted recommendation: Recommended A. One row per effective principal and assignment answers "who can do this" directly. | ✅ Resolved |
| AR-26 | Data & state | Assignment response shape | A: { id, principalId, role, scopeType, scopeId, grantedBy, createdAt, expiresAt } / B: include principal and project names / C: return the tuple only | User accepted recommendation: Recommended A. The id is needed for DELETE and audit references; names belong to separate reads. | ✅ Resolved |
| AR-27 | Behavioral | HTTP mapping for authorization and validation failures | A: action denial 403 access_denied; hidden resource 404; conflict 409; invalid input 422; audit failure 503 / B: 401 for denial / C: 400 for validation | User accepted recommendation: Recommended A. This matches the existing identity and agent error families. | ✅ Resolved |

## Resolution Notes

### Imported context

- **AR-1:** RD-06 owns the fixed action catalog, fixed roles, three scopes, denial by default,
  evaluator, assignment lifecycle, escalation guards, capabilities, and access-explain. The
  requirements document explicitly leaves project/secret/certificate endpoints to RD-08/RD-09,
  persisted audit to RD-07, and clients to RD-11/RD-12. The role matrix in
  `docs/reference/roles.md` is the oracle and is not re-derived.

### User interview decisions

- **AR-2:** The audit port is a narrow interface with one method for decision events and one for
  mutation events. RD-06 ships a logger-backed adapter. The port never accepts secret values.
- **AR-3:** The evaluator reads `policy_state.version` and the actor's unexpired assignments on
  every call. There is no decision cache, so no cache can serve stale authority. The version is
  recorded in the decision result for callers that later add caching.
- **AR-4:** The resource descriptor is `{ type: "secret" | "certificate" | "identity", id,
  projectId }`. `capabilitiesFor` returns the five flags without auditing; controllers audit the
  action they enforce.
- **AR-5:** Access-explain requires `action`; optional `scopeType`, `scopeId`, and `objectType`.
  The result lists only principals that receive an allow for that action and resource.
- **AR-6:** Create is a tuple; delete is by assignment id. Duplicate tuple is a conflict.
- **AR-7:** Tests and local fixtures insert the first admin assignment directly. Deployment
  provisioning owns the production first admin.
- **AR-8:** Limits are per authenticated principal, in memory, with the existing WebAFX limiter
  and the standard 429 envelope.

### Plan-local decisions confirmed by the user

- **AR-9:** Fail closed on audit-port failure. The assignment transaction rolls back; a decision
  read returns 503 `service_unavailable`.
- **AR-10:** `authorize` audits one event. `capabilitiesFor` does not audit; the enforcing
  controller audits the action it actually checks.
- **AR-11:** `/v1/meta/roles` is public and returns only static catalog data plus the policy
  version.
- **AR-12:** Secret mapping: canRead=secret.read, canWrite=secret.write, canDelete=secret.delete,
  canPurge=secret.purge, canManage=assignment.write. Certificate mapping uses the matching
  certificate actions and the same canManage action.
- **AR-13:** Access-explain infer the table from the action prefix (`secret.`, `certificate.`,
  `identity.`), validates the object and its project, and returns 404 for a missing or invisible
  resource.
- **AR-14:** Expiry must be a future ISO-8601 timestamp; there is no maximum.
- **AR-15:** List filters are optional and conjunctive; results are newest first with no cursor.
- **AR-16:** Out-of-scope ids are 404; duplicate tuples are 409; invalid role/scope/expiry are 422.
- **AR-17:** The policy version appears in both meta/roles and access-explain.
- **AR-18:** Each assignment mutation updates the single policy_state row in its transaction before
  checking the last-admin invariant. Concurrent mutations serialize on that row.
- **AR-19:** Reason codes are a fixed union in `rbac/reasons.ts` and appear in audit events and
  access explanations.
- **AR-20:** Successful grants and revocations emit `assignment.grant` and `assignment.revoke`
  events; the permission check emits `assignment.write`.
- **AR-21:** `policy_state` has one row (`id = 1`) with a bigint version and an updated timestamp.
  The migration seeds it.
- **AR-22:** `IdentityAuthorizer` keeps `can`, `hasAny`, `canReadAll`, and `readableProjectIds`;
  the implementation delegates to the policy service and preserves the RD-05 foreign-resource
  behavior.
- **AR-23:** New modules live under `apps/server/src/rbac/`; the controller is
  `controllers/assignments.ts`. Contracts live in `packages/api-contract/src/rbac.ts`.
- **AR-24:** Meta response is the catalog plus `policyVersion`; actions carry `plane` and a short
  description; roles carry actions and eligible scopes.
- **AR-25:** Access-explain returns the evaluated action, resource scope, policy version, and one
  entry per principal/assignment. Service principals include their consumer row when present.
- **AR-26:** Assignment responses include the id, tuple, grantor, creation time, and expiry.
- **AR-27:** 403 for a policy denial, 404 for hidden resources, 409 for uniqueness/last-admin
  conflicts, 422 for validation, 503 for audit or database unavailability.

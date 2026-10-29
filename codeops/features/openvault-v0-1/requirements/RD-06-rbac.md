# RD-06: RBAC

> **Document**: RD-06-rbac.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-03, RD-05
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the authorization model: 25 fixed actions, 9 fixed roles, three scopes
(organization, project, object), deny-by-default evaluation, assignment lifecycle, escalation
guards, per-object capability flags, and the "who can read this" explanation.

## Functional Requirements

### Must Have

- [ ] 25 actions defined in code and returned by `GET /v1/meta/roles`.
- [ ] 9 roles: `org.admin`, `project.admin`, `secrets.manager`, `secrets.officer`,
  `secrets.reader`, `certificates.officer`, `certificates.reader`, `auditor`, `reader`.
- [ ] Assignments bind a principal, role, scope type, scope id, grantor, and optional expiry.
- [ ] Deny by default; no role or wildcard grants implicit access.
- [ ] Permissions inherit down org → project → object, never up.
- [ ] Object-scope assignments are limited to `secrets.reader` and `certificates.reader`.
- [ ] A service identity cannot hold any control-plane action.
- [ ] Project administrators can manage only identities owned by their project.
- [ ] A principal can grant only roles whose actions are a subset of its own effective
  actions at that scope, and only at a scope it covers.
- [ ] Only an org administrator can grant `org.admin`.
- [ ] Removing the last active org administrator returns 409.
- [ ] Assignment changes take effect within 5 seconds through a policy version counter.
- [ ] Every allow and denial is audited with actor, action, scope, object id, result, and
  reason code.
- [ ] API responses include per-object `canRead`, `canWrite`, `canDelete`, `canPurge`, and
  `canManage`.
- [ ] `GET /v1/admin/access-explain` lists every principal with an effective permission, the
  role, the assignment, and the consuming services.

### Should Have

- [ ] Assignment expiry is visible in the UI and CLI.
- [ ] A denial counter per principal is logged for abuse detection.

### Won't Have (Out of Scope)

- Custom roles, wildcard actions, or explicit deny rules.
- Attribute-based access control or group sync.
- Two-person approval for grants.

## Technical Requirements

### Action catalog

Control plane (12): `project.create`, `project.read`, `project.update`, `project.delete`,
`identity.create`, `identity.read`, `identity.revoke`, `identity.join_token`,
`assignment.read`, `assignment.write`, `audit.read`, `kek.rotate`.

Data plane (13): `secret.list`, `secret.read`, `secret.write`, `secret.delete`,
`secret.recover`, `secret.purge`, `certificate.list`, `certificate.read`,
`certificate.read_private`, `certificate.write`, `certificate.delete`,
`certificate.recover`, `certificate.purge`.

### Role matrix

The full matrix is in the public docs and is generated from the same catalog constants. The
matrix is the oracle for the authorization test suite.

### Evaluation

```text
if principal.status != active: deny
scopes = [org] + [resource.projectId] + [resource.id]
assignments = active assignments for principal at those scopes
allow = any assignment where role.actions contains action
audit(action, resource, allow ? allow : deny, reason)
return allow
```

- Org scope covers every resource.
- Project scope covers every object in that project.
- Object scope covers exactly one object.
- `policy_version` increments on every role/assignment change; caches carry the version.

### Grant guards

1. Grantor holds `assignment.write` at the target scope or an ancestor.
2. Every action of the granted role is in the grantor's effective actions at that scope.
3. The scope is eligible for the role.
4. Only org admins grant `org.admin`.
5. The change does not remove the last active org admin.

### Identity ownership

- Human users are org-level principals; only org-scope `identity.create` creates them.
- Service identities have `owner_project_id`.
- Project-scope identity actions apply only to identities owned by that project.
- A join token must target an identity owned by the same project.

## Integration Points

- RD-03 supplies the browser principal and session.
- RD-04 supplies the CLI principal.
- RD-05 supplies the agent principal and identity ownership.
- RD-07 audits every decision.
- RD-08 and RD-09 expose capabilities and enforce actions.
- RD-12 renders capabilities and the access-explain view.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Role model | Custom roles / fixed roles | Fixed 9 roles | Testable and reviewable | AR-6 |
| Deny model | Allow + deny / allow-only | Allow-only, default deny | Simpler; revocation by removal | AR-30 |
| Scope | Org/project / add object | Three scopes | Least privilege | AR-6 |
| Object scope | All roles / readers only | Reader roles only | Prevent hidden writers | AR-6 |
| Revocation latency | Immediate / 5 s / eventual | 5 seconds | Cacheable and bounded | AR-18 |
| UI authorization | Client math / server flags | Server capability flags | Client is not the authority | AR-24 |

## Security Considerations

- **Data sensitivity:** policy reveals who can read secrets; assignments are sensitive
  metadata.
- **Input validation:** role, scope type, scope id, principal id, expiry are allowlisted.
- **Authentication & authorization:** deny by default; service identities capped; last-admin
  guard.
- **Injection risks:** parameterized SQL; no role names from user input are interpolated.
- **Encryption needs:** policy in PostgreSQL; TLS in transit.
- **Rate limiting:** assignment changes and access-explain are admin actions; rate limited.
- **Infrastructure:** no policy in client-side storage; audit every change.

## Acceptance Criteria

1. [ ] The role matrix test covers all 9 roles × 25 actions × eligible scopes and matches the
   documented matrix.
2. [ ] A principal with no assignment receives 403 on every non-public route.
3. [ ] An org assignment covers a project and its objects; a project assignment covers its
   objects; an object assignment covers only that object; no upward inheritance.
4. [ ] A service identity granted a control-plane action is rejected with 422.
5. [ ] A project administrator cannot grant `auditor` (lacks `audit.read`), `org.admin`, or a
   role at another project.
6. [ ] Removing the last org admin returns 409; adding a second then removing succeeds.
7. [ ] Revoking an assignment causes the next request to deny within 5 seconds.
8. [ ] Every allow and denial produces exactly one audit event with a reason code.
9. [ ] A secret response includes correct `canRead`, `canWrite`, `canDelete`, `canPurge`, and
   `canManage` for the current principal.
10. [ ] `access-explain` matches the evaluator for every role/scope combination.
11. [ ] Security requirements verified: default deny, escalation guards, identity ownership,
    last-admin guard.

# Projects: RD-08 Projects and Secrets

> **Document**: 03-02-projects.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the control-plane project lifecycle: create, list, read, update, and soft
delete. It also owns the cross-cutting visibility rule that a soft-deleted project hides its
assignments, secrets, certificates, identities, and object-scope resources from policy
evaluation, administration, and access explanations.

**Governing decisions:** AR-1, AR-2, AR-3, AR-4, AR-17, AR-20, AR-26, AR-27.

## Architecture

### Current Architecture

`projects` has the name check, timestamps, soft-delete timestamp, and an active-name unique
index. No route or service exists. `PolicyService.authorize` evaluates `project.create`,
`project.read`, `project.update`, and `project.delete`; only `org.admin` holds create and
delete, while `project.admin`, `reader`, and `auditor` can read and `project.admin` can
update. `PolicyRepository.loadActorSnapshot` loads every assignment without checking project
deletion, and `findObject`/`listExplainCandidates` can still expose an object in a deleted
project.

### Proposed Changes

```text
POST   /v1/admin/projects          project.create (project resource)
GET    /v1/admin/projects          project.read via authorizeList (org)
GET    /v1/admin/projects/:project project.read (project)
PATCH  /v1/admin/projects/:project project.update (project)
DELETE /v1/admin/projects/:project project.delete (project)
```

The admin selector is the project ULID (AR-1). The service returns `project_not_found` for an
unknown/deleted project or an invisible project, `access_denied` when the caller has the
action nowhere, and `project_name_conflict` for a duplicate active name.

## Implementation Details

### Repository

```ts
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export class ProjectRepository {
  findById(tx: QueryExecutor, id: string): Promise<ProjectRecord | undefined>;
  findActiveById(tx: QueryExecutor, id: string): Promise<ProjectRecord | undefined>;
  findActiveByName(tx: QueryExecutor, name: string): Promise<ProjectRecord | undefined>;
  insert(tx: QueryExecutor, input: { id: string; name: string; createdAt: Date }): Promise<ProjectRecord>;
  rename(tx: QueryExecutor, id: string, name: string, updatedAt: Date): Promise<ProjectRecord | undefined>;
  softDelete(tx: QueryExecutor, id: string, deletedAt: Date): Promise<ProjectRecord | undefined>;
  listVisible(tx: QueryExecutor, visibility: "all" | readonly string[]): Promise<readonly ProjectRecord[]>;
}
```

`rename` and `softDelete` use `UPDATE ... WHERE id = :id AND deleted_at IS NULL RETURNING ...`
so a concurrent delete yields `undefined` and the service maps it to 404. `listVisible` filters
`deleted_at IS NULL` and, for a project set, `id = ANY(:projectIds)`; it orders by
`name ASC, id ASC`.

### Service

Every state change uses this order (AR-17, AR-26):

1. Generate/resolve the project id.
2. Authorize with `{ audit: false }` on the **project resource** so the decision event carries
   `objectType: "project"` and the project id.
3. In one transaction: acquire the audit chain lock first, then insert/rename/soft-delete, then
   write the joined allow decision.
4. On a unique violation or no-row update, the transaction rolls back and the service writes
   one independent error outcome; no allow event survives. A create failure uses system scope
   with `projectId: null`, `objectType: "project"`, and the generated project id, because the
   project row does not exist for the audit foreign key.

- **Create:** authorize `project.create` on `{ type: "project", id: generatedId }`. A denial is
  written independently and throws `access_denied`. The transaction inserts the row and the
  joined decision. A unique violation maps to `project_name_conflict`.
- **List:** call `authorizeList(actor, "project.read", { type: "org", id: "org" }, context)`.
  A denial throws `access_denied`. Visibility `all` lists every active project; otherwise the
  list is restricted to the returned ids.
- **Get:** load the active project or throw `project_not_found`; authorize `project.read` on
  the project with the default independent decision. `scope_mismatch`/`expired_assignment`
  maps to 404 `project_not_found`; `no_assignment` maps to 403 `access_denied`.
- **Update:** same visibility mapping for `project.update`; transaction renames the row and
  writes the joined decision. A unique violation maps to `project_name_conflict`.
- **Delete:** same visibility mapping for `project.delete`; transaction soft-deletes and writes
  the joined decision. A repeated delete returns `project_not_found`.

### Visibility Changes

`PolicyRepository` changes four queries:

1. `loadActorSnapshot`: the `LEFT JOIN role_assignments` condition keeps only:
   - org scope, or
   - project scope with an active project, or
   - object scope whose secret exists with an active parent project, or whose certificate
     exists with an active parent project.
   A dangling object assignment is inert.
2. `listAssignments`: the same predicate in `WHERE`; the visibility-`all` path no longer shows
   assignments for deleted projects or missing objects.
3. `findAssignment`: the same predicate, so delete returns 404 for a hidden assignment.
4. `findObject`: require `object.deleted_at IS NULL` and `parent_project.deleted_at IS NULL`.
   `#resolveExplainResource` uses it. `listExplainCandidates` filters live assignment projects
   and, for service principals, a live owner project. This closes assignment create, explain,
   and delete for hidden resources (AR-27). An object-scope assignment create on a hidden or
   deleted object returns 404 `resource_not_found` rather than 422.

### Controller

`apps/server/src/controllers/projects.ts` mirrors `IdentityController`:

- Parse `projectCreateRequestSchema` / `projectUpdateRequestSchema`.
- Validate `:project` with `ulidSchema`; an invalid id maps to `project_not_found`.
- Map domain errors to `ApiError`.
- Return 201 for create, 200 for list/get/update, and 204 for delete.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Unknown or deleted project | 404 `project_not_found` | AR-2 |
| Invalid ULID selector | 404 `project_not_found` | AR-1 |
| Duplicate active name | 409 `project_name_conflict` | AR-4 |
| Caller has the action elsewhere but not here | 404 `project_not_found` | AR-3 |
| Caller has no grant anywhere | 403 `access_denied` | AR-3 |
| Empty or invalid update body | 422 `validation_error` | AR-4 |
| Policy or audit unavailable | 503 `service_unavailable` | AR-17 |

## Integration Points

- The data-plane secret route resolves the project by name and requires an active row.
- Identity routes already treat a deleted project as hidden.
- Assignment list/get/create/explain and access-explain use the filtered repository results.
- Audit events use `objectType: "project"` and the project id as `objectId`.
- The audit chain lock is taken before the project row lock to avoid deadlock (AR-26).

## Testing Requirements

- Specification tests for create/list/get/update/delete, duplicate names, hidden project
  access, assignment hiding, access-explain hiding, and object-scope assignment creation
  rejection.
- Implementation tests for concurrent rename/delete, delete idempotence, and the policy
  snapshot filter.

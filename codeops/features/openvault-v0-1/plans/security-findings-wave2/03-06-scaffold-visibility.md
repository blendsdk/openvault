# Scaffold Visibility: Security Findings Wave 2

> **Document**: 03-06-scaffold-visibility.md
> **Parent**: [Index](00-index.md)

## Overview

Apply the collection-visibility rule to the scaffold endpoint so a caller cannot distinguish an existing hidden project from a missing one, while preserving the empty-entries project-create path.

## Architecture

### Current Behavior

`scaffold/service.ts:123` calls `#resolveProject` before authorization. `#resolveProject` (`:225-259`) returns the existing project, or throws `422 project_not_found` when entries are non-empty. `#authorizeAssignmentWrite` (`:262-278`) then returns 403 for an existing project the caller cannot manage. The empty-entries path creates a missing project and returns 200.

### Rule

| Caller relationship to the name | Existing project | Missing project |
|---|---|---|
| Can `assignment.write` on it | proceed | n/a |
| Can `project.read` on it but not write | 403 `access_denied` | 404 if no `project.create` |
| Cannot read or write it | 404 `project_not_found` / `Resource not found` | Same 404 |
| Can `project.create` at org scope | n/a | entries non-empty: 422; entries empty: create and proceed |

### Proposed Changes

Replace `#resolveProject` with a flow that resolves first but decides the public error only after policy evaluation. Every policy probe uses `{ audit: false }`; record exactly one operation decision on denial.

1. Validate the project name and entries in the controller (unchanged).
2. Look up the active project by name.
3. If it exists:
   - Authorize `assignment.write` on `{ type: "project", id }` with `{ audit: false }`.
   - If allowed, return the project and the decision for reuse. Do not run a second `#authorizeAssignmentWrite`.
   - If denied, authorize `project.read` on the same resource with `{ audit: false }`.
     - Allowed → record the `assignment.write` denial and throw 403 `access_denied`.
     - Denied → record the `assignment.write` denial and throw 404 `project_not_found` / `Resource not found`.
4. If it does not exist:
   - Authorize `project.create` at the org scope with `{ audit: false }`.
   - Denied → record that decision and throw 404 `project_not_found` / `Resource not found`.
   - Allowed and entries are non-empty → record the allow (audited once) and throw the existing 422 actionable validation error.
   - Allowed and entries are empty → call `projects.create`, which performs its own authorization and audit. On `project_name_conflict`, re-read the name and continue as an existing project.
5. Use `ProjectServiceError` for the uniform 404 (`404`, `project_not_found`, `Resource not found`) or extend `ScaffoldErrorCode` with `project_not_found`. The controller must preserve the status, code, and message.

### Error Type

`apps/server/src/scaffold/errors.ts` currently has no `project_not_found`. Extend the union or throw `ProjectServiceError`; the implementation must typecheck and the test must assert the exact body.

## Failure Behavior

- Unassigned caller, existing name: 404, one deny event.
- Unassigned caller, missing name: 404, no create attempt, one deny event.
- Foreign project admin, existing name: 404 (no read or write on it).
- Reader/auditor with org `project.read`: existing 403, missing 404 (unless they also have `project.create`).
- Org admin, missing name with entries: 422.
- Org admin, missing name with no entries: creates and returns 200.
- Org admin, existing name: proceeds.
- Race: create conflict re-reads and proceeds.

## Timing

The existing-hidden path performs a lookup, an `assignment.write` probe, and a `project.read` probe. The missing path performs a lookup and a `project.create` probe. These are not equal, so the test asserts that the lookup happens before any existence-dependent response and allows a documented timing tolerance; it does not assert equal probe counts. A material timing oracle is a documented residual.

## Tests

- Unassigned and foreign-project callers: identical status, code, and message for existing and missing names.
- Reader/auditor: 403 for existing, 404 for missing.
- Org admin: 422 for missing with entries; creates a missing project with no entries; succeeds when the project exists.
- Audit count: exactly one deny event per hidden denial; exactly one allow for the create path.
- The lookup occurs before the existence-dependent response.

## Acceptance

See `07-testing-strategy.md` ST-32…ST-37 and `01-requirements.md` R6.

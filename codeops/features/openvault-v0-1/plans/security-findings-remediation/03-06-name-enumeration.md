# Name Enumeration: Security Findings Remediation

> **Document**: 03-06-name-enumeration.md
> **Parent**: [Index](00-index.md)

## Overview

Adopt the collection-visibility rule for name-addressed data-plane routes. A caller may learn that a named resource exists only if the caller can list the collection or already has object-level access to that resource. Responses for hidden and missing resources must be indistinguishable in status, code, and message.

## Rule

| Caller visibility | Existing object | Missing object |
|---|---|---|
| Can list the collection or read the object | 403 `access_denied` | 404 route-family not found |
| Neither | 404 route-family not found | 404 route-family not found |

“List the collection” means `secret.list` or `certificate.list` on the owning project. An object-scope reader cannot list the project, so other names return 404; its assigned object remains readable because object authorization allows it. For `certificate.read_private`, an object-scope reader that can read the certificate publicly keeps 403, because it already knows the certificate exists.

## Uniform Not-Found Responses

Use one message for hidden and missing: `Resource not found`.

- Secret name routes: 404 `secret_not_found` / `Resource not found` for a missing project **and** a missing secret. This hides project existence on secret name routes.
- Secret list route: 404 `project_not_found` / `Project not found` for a missing project or denied list.
- Certificate name routes: 404 `certificate_not_found` / `Resource not found` for a missing project and a missing certificate.
- Certificate list route: 404 `project_not_found` / `Project not found` for a missing project or denied list.

The full error body must match, not just the status code. Tests assert `{ statusCode, code, message }`.

## Helper

Add `apps/server/src/rbac/collection-visibility.ts`:

```ts
export async function canListCollection(options: {
  readonly policy: PolicyService;
  readonly actorId: string;
  readonly listAction: "secret.list" | "certificate.list";
  readonly projectId: string;
  readonly context?: PolicyAuditContext;
}): Promise<boolean>;
```

It calls `policy.authorize(actorId, listAction, { type: "project", id: projectId }, context, { audit: false })` and returns `decision.allowed`. Object-scope assignments do not cover a project resource (`assignmentCovers` in `policy-service.ts:162-182`), so they correctly return false.

## Denial Mapping

Extend the service-local mapper:

```ts
function denialError(decision, notFoundCode, hideExistence: boolean, message = "Resource not found") {
  if (hideExistence) {
    return new SecretServiceError(404, notFoundCode, message);
  }
  return new SecretServiceError(403, "access_denied", "Access denied");
}
```

`hideExistence` is mandatory. Do not keep unconditional `scope_mismatch`/`expired_assignment` 404 branches; those reasons are already covered by `canList` when the caller cannot see the collection. A caller that can list and has a stale object grant gets 403.

## Audit Ownership

Each denial writes exactly one decision. The existing call sites record the decision, then call a private `#denyName` that computes visibility and returns the error. Do not record inside `#denyName`. Add a test asserting exactly one deny event for a hidden 404.

## Routes

### Secrets

- `read`, `versions`, `consumers`, `updateMetadata`, `write`, `delete`, `recover`, `purge`: resolve project, resolve name, authorize, on denial compute `canListCollection`, record once, throw 403 or 404.
- `list`: resolve project; if `secret.list` denied, throw 404 `project_not_found` / `Project not found`.
- `#activeProject` for name routes maps a missing/soft-deleted project to `secret_not_found` / `Resource not found`; the list route keeps `project_not_found`.
- `consumers` uses `secret.list` on the object; an unassigned caller gets 404; a project reader gets 200; an object-scope reader assigned the object gets 200.

### Certificates

- `read`, `readPrivate`: remove `#requireAnyRead`; resolve project and name, authorize, on denial compute `canListCollection`; for `readPrivate`, also allow 403 when `certificate.read` on the same object is allowed.
- `list`: if `certificate.list` denied, 404 `project_not_found`.
- `import`/`generate`: pre-authorize the project; on denial compute `canListCollection`; 403 or 404. The name is in the body and is not resolved before authorization.
- `CertificateLifecycle.updateMetadata`, `delete`, `recover`, `purge`: `#preAuthorizeProject` computes `canListCollection` on denial and throws 403 or 404 before resolving the name. This means a list-capable caller gets 403 even for a missing name; that is acceptable because the caller can list names. An unassigned/object-scope caller gets 404 for both.
- `#readProject` and lifecycle `#activeProject` map a missing project to `certificate_not_found` / `Resource not found`.

### Control Plane

Keep the existing 403/404 behavior on ID-addressed control-plane routes: `projects.get`, assignments, identities, audit. ULIDs are not practically enumerable and administrators need the distinction.

## Existing Test Impact

Update deliberately:

- `apps/server/tests/integration/secrets.spec.test.ts:243-256`: unassigned existing secret 403 → 404; other-project reader stays 404.
- `apps/server/tests/integration/certificates-read.spec.test.ts:230-233`: no-access certificate 403 → 404.
- `apps/server/tests/integration/certificates-http.spec.test.ts:246-249`: no-assignment private key 403 → 404.
- `apps/server/tests/integration/secrets-consumer-state.spec.test.ts:227-236`: no-access consumer state 403 → 404.
- `apps/server/tests/integration/secrets-lifecycle.spec.test.ts:223-226`: purge event count changes in Phase 5, not here.
- Web fake `apps/web/tests/helpers/fake-vault.ts:268-270`: simulate 404 for hidden denies and add an assertion.
- CLI error mapping: 403 remains exit 4 for list-capable denials; hidden denials become 404 exit 5. Document the compatibility change.

## Tests

Use the route-by-actor matrix in `07-testing-strategy.md`:

- secret read, versions, consumers, list;
- certificate read, readPrivate, list, lifecycle pre-auth;
- unassigned, list-only (`reader`/`auditor`), object-scope, project-scope, other-project;
- existing and missing project/name;
- exact body equality for hidden vs missing.

## Acceptance

See `07-testing-strategy.md` ST-23…ST-34 and `01-requirements.md` R6.

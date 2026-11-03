# RBAC

OpenVault denies by default. Access comes from role assignments at three scopes:

```text
organization
 └── project
      ├── secret
      └── certificate
```

Permissions flow down, never up.

## Roles

| Role | Intended for |
|---|---|
| `org.admin` | Platform owner |
| `project.admin` | Team lead for one project |
| `secrets.manager` | Secret owner who may purge |
| `secrets.officer` | Day-to-day secret writer |
| `secrets.reader` | Application or developer who reads values |
| `certificates.officer` | Certificate owner |
| `certificates.reader` | Consumer of public certificate chains |
| `auditor` | Security reviewer |
| `reader` | Metadata-only visibility |

The full matrix is in [Roles and actions](/reference/roles).

## Scope rules

- Organization assignments cover every project.
- Project assignments cover every secret and certificate in that project.
- Object assignments cover one object and are limited to `secrets.reader` and
  `certificates.reader`.
- `project.create`, `project.delete`, and `kek.rotate` are org-only.
- Service identities cannot hold control-plane actions.

## Common grants

```bash
# A service reads one project's secrets
ov role grant payments-api secrets.reader --project payments

# A developer writes secrets but cannot purge
ov role grant alice secrets.officer --project payments

# An auditor can read audit events and metadata, not values
ov role grant dave auditor --org blendsdk
```

## Admin API

The admin API manages assignments directly. A grant names the principal, role, scope, and
optional future expiry.

```bash
curl -X POST https://vault.example.com/v1/admin/assignments \
  -H "cookie: __Host-ov_session=$SESSION" \
  -H "x-csrf-token: $CSRF" \
  -H "content-type: application/json" \
  -d '{"principalId":"01J...","role":"secrets.reader",
       "scopeType":"project","scopeId":"01J..."}'
```

`GET /v1/admin/assignments` accepts optional `principalId`, `role`, `scopeType`, and `scopeId`
filters. `DELETE /v1/admin/assignments/:id` removes one assignment.

The API enforces the grant guards. A project-scoped project administrator can manage only
its own project. Only an organization administrator can grant `org.admin`. Removing the last
active user organization administrator returns `409 last_org_admin`.

## No privilege escalation

A principal can grant only roles whose actions are a subset of its own effective actions at
that scope. Only an organization administrator can grant `org.admin`. Removing the last
organization administrator is rejected.

## UI capabilities

The API returns per-object flags for the current principal:

```json
{
  "capabilities": {
    "canRead": true,
    "canWrite": false,
    "canDelete": false,
    "canPurge": false,
    "canManage": false
  }
}
```

The UI uses these flags. It never derives permissions from client-side role math.

## Access explain

```bash
curl "https://vault.example.com/v1/admin/access-explain?action=secret.read&scopeType=object&scopeId=01J..." \
  -H "cookie: __Host-ov_session=$SESSION"
```

Lists every principal with an effective permission on the resource, the role, the assignment,
the scope, and the consuming service metadata. A project or object outside the caller's scope
returns `404 resource_not_found`. The response includes the current `policyVersion`; clients
can use it to detect policy changes.

## Next

- [Roles and actions](/reference/roles)
- [Audit](/guide/audit)

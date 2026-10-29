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
ov access explain db-password --project payments
```

Lists every effective principal, the role, the scope, the assignment, and the consuming
services.

## Next

- [Roles and actions](/reference/roles)
- [Audit](/guide/audit)

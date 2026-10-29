# Roles and actions

OpenVault ships fixed roles and actions. Custom roles are not supported in v0.1.

## Actions

### Control plane

| Action | Meaning |
|---|---|
| `project.create` | Create a project |
| `project.read` | Read project metadata |
| `project.update` | Rename or change project settings |
| `project.delete` | Soft-delete a project |
| `identity.create` | Create a service identity |
| `identity.read` | Read identity metadata |
| `identity.revoke` | Disable an identity and revoke its credentials |
| `identity.join_token` | Issue a join token |
| `assignment.read` | Read assignments and access explanations |
| `assignment.write` | Grant or revoke roles |
| `audit.read` | Read or export audit events |
| `kek.rotate` | Start KEK rotation |

### Data plane

| Action | Meaning |
|---|---|
| `secret.list` | List secret metadata and consumer summaries |
| `secret.read` | Read a secret value or version |
| `secret.write` | Create, update, or add a version |
| `secret.delete` | Soft-delete a secret |
| `secret.recover` | Recover a soft-deleted secret |
| `secret.purge` | Permanently delete a secret |
| `certificate.list` | List certificate metadata |
| `certificate.read` | Read a certificate chain |
| `certificate.read_private` | Read a certificate private key |
| `certificate.write` | Import, generate, or update a certificate |
| `certificate.delete` | Soft-delete a certificate |
| `certificate.recover` | Recover a soft-deleted certificate |
| `certificate.purge` | Permanently delete a certificate |

## Role matrix

| Action | org.admin | project.admin | secrets.manager | secrets.officer | secrets.reader | certificates.officer | certificates.reader | auditor | reader |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `project.create` | ✓ | | | | | | | | |
| `project.read` | ✓ | ✓ | | | | | | ✓ | ✓ |
| `project.update` | ✓ | ✓ | | | | | | | |
| `project.delete` | ✓ | | | | | | | | |
| `identity.create` | ✓ | ✓ | | | | | | | |
| `identity.read` | ✓ | ✓ | | | | | | ✓ | |
| `identity.revoke` | ✓ | ✓ | | | | | | | |
| `identity.join_token` | ✓ | ✓ | | | | | | | |
| `assignment.read` | ✓ | ✓ | | | | | | ✓ | |
| `assignment.write` | ✓ | ✓ | | | | | | | |
| `audit.read` | ✓ | | | | | | | ✓ | |
| `kek.rotate` | ✓ | | | | | | | | |
| `secret.list` | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ✓ |
| `secret.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | |
| `secret.write` | ✓ | ✓ | ✓ | ✓ | | | | | |
| `secret.delete` | ✓ | ✓ | ✓ | ✓ | | | | | |
| `secret.recover` | ✓ | ✓ | ✓ | ✓ | | | | | |
| `secret.purge` | ✓ | ✓ | ✓ | | | | | | |
| `certificate.list` | ✓ | ✓ | | | | ✓ | ✓ | ✓ | ✓ |
| `certificate.read` | ✓ | ✓ | | | | ✓ | ✓ | | |
| `certificate.read_private` | ✓ | ✓ | | | | ✓ | | | |
| `certificate.write` | ✓ | ✓ | | | | ✓ | | | |
| `certificate.delete` | ✓ | ✓ | | | | ✓ | | | |
| `certificate.recover` | ✓ | ✓ | | | | ✓ | | | |
| `certificate.purge` | ✓ | ✓ | | | | | | | |

## Scope eligibility

| Role | org | project | object |
|---|:--:|:--:|:--:|
| `org.admin` | ✓ | | |
| `project.admin` | ✓ | ✓ | |
| `secrets.manager` | ✓ | ✓ | |
| `secrets.officer` | ✓ | ✓ | |
| `secrets.reader` | ✓ | ✓ | ✓ |
| `certificates.officer` | ✓ | ✓ | |
| `certificates.reader` | ✓ | ✓ | ✓ |
| `auditor` | ✓ | ✓ | |
| `reader` | ✓ | ✓ | |

Object-scope assignments are limited to the two reader roles.

## Evaluation

1. Reject disabled principals.
2. Collect active assignments at org, project, and object scope.
3. Allow if an assignment's role contains the action and its scope covers the resource.
4. Deny otherwise.
5. Audit the decision with a reason code.

The server re-evaluates from the database on every request. Roles in a token or session
are UI hints only.

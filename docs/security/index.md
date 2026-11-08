# Security

OpenVault is designed for one team running Docker Compose on one host. It protects secrets
with encryption at rest, narrow access, short-lived workload credentials, and a tamper-evident
audit trail.

## Protection at a glance

| Area | What OpenVault does |
|---|---|
| Secret storage | Values are encrypted at rest with envelope encryption. The key-encryption key lives outside the database. |
| Key custody | The keyring is a local file with mode `0600`. Back it up separately from the database. |
| Access | Deny-by-default RBAC at organization, project, and object scope. |
| Workload identity | Each service gets its own agent and a short-lived certificate. The agent joins with a one-time token. |
| Isolation | The agent writes only its service's files to a private temporary filesystem. The application never talks to the vault. |
| Transport | TLS for operators and browsers; mutual TLS for agents. |
| Audit | Every read, denial, and permission change is recorded in a hash-chained, HMAC-protected log. |
| Recovery | Encrypted backup and verified restore, with a separate keyring backup. |

## Operate it safely

- Follow the [hardening checklist](/security/hardening).
- Read the [known limitations](/security/known-limitations).
- Prepare an [incident response](/security/incident-response) plan.
- [Report a vulnerability](/security/reporting) privately.

## Trust boundary

OpenVault limits the blast radius of a compromised workload. It cannot make a compromised
application safe, and it cannot protect secrets from root on the vault host. Keep the host
dedicated, patch it, disable or encrypt swap, and store backups off the host.

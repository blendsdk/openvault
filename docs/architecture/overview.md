# How OpenVault works

OpenVault is a single-node, self-hosted service for Docker Compose projects. It stores
secrets and certificates, decides who may read them, delivers them to the right service, and
records every access.

## Components

| Component | Responsibility |
|---|---|
| Reverse proxy | Public TLS, routing, and security headers |
| Vault server | API, authentication, access control, audit, and agent listener |
| Web UI | Browser interface for projects, secrets, identities, permissions, and audit |
| CLI | Automation and incident-response commands |
| Agent | One sidecar per Compose service; fetches only that service's secrets |
| Database | Metadata, encrypted values, access policy, and the audit chain |
| Keyring | Key-encryption key, kept outside the database |

## Request path

```text
browser / CLI ── HTTPS ──▶ reverse proxy ── HTTPS ──▶ vault server ──▶ database
                                                          │
                                                          └── keyring
```

1. The proxy terminates TLS.
2. The vault server identifies the caller: browser session, CLI session, or agent certificate.
3. Access control decides whether the action is allowed.
4. The audit writer records the decision.
5. The handler reads or writes the encrypted value.
6. The response returns to the caller.

## Delivery path

```text
agent ── mutual TLS ──▶ vault server ──▶ encrypted value
  │
  └── writes files to a private directory shared with the application
```

1. An operator scaffolds a service. OpenVault creates the service identity, grants read access
   to the named secrets, and issues a one-time join token.
2. The agent joins, receives a short-lived certificate, and fetches its manifest.
3. The agent writes each secret atomically to its private directory and refreshes it on an
   interval.
4. The application reads the files. It has no route to the vault.

## Storage

The database holds metadata, encrypted values, access policy, and the audit chain. The
key-encryption key lives in a keyring file outside the database, so a database copy alone
cannot reveal secrets. Back up the keyring separately from the database.

## Network zones

| Network | Members |
|---|---|
| `edge_net` | Proxy only; may reach the internet |
| `admin_net` | Proxy and vault server admin listener |
| `web_net` | Proxy and web UI |
| `vault_net` | Vault server agent listener and agents |
| `db_net` | Vault server and database |

Only the proxy publishes a host port. Application containers must not join `admin_net`,
`vault_net`, or `db_net`.

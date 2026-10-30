# Reference Compose stack

> **Work in progress.** The release image and `ov init` are part of v0.1. This stack is the
> target topology; it is not usable until the release image is available.

The reference stack runs one host:

| Service | Networks | Purpose |
|---|---|---|
| `proxy` | `edge_net`, `admin_net` | Public TLS termination, HSTS, and proxy timeouts |
| `openvaultd` | `admin_net`, `vault_net`, `db_net` | API, UI, auth, policy, audit |
| `postgres` | `db_net` | Metadata, ciphertext, audit chain |

Application Compose projects add one agent per service. The agent joins `vault_net` and the
project's default network; the application joins only its own network.

## Start

```bash
cp .env.example .env
# change POSTGRES_PASSWORD and OPENVAULT_BASE_URL
docker compose -f deploy/compose/compose.yaml up -d
```

`ov init` creates the keyring, the internal CA, the server certificate, the JWT key, and
the bootstrap administrator. It writes the bootstrap password to a one-time file with mode
`0600` in the persistent data volume. The password is never printed to stdout, stderr, or
container logs. Read the file once with a short-lived command, sign in, change the password,
and delete the file. The exact file path and the read/delete command are owned by the CLI and
operations releases.

## Networks

- `edge_net`: proxy only.
- `admin_net`: proxy and server. Dedicated subnet `172.30.0.0/24` with pinned addresses
  (`172.30.0.2` proxy, `172.30.0.3` server). Internal; no direct internet.
- `vault_net`: server and agents. Internal; no direct internet.
- `db_net`: server and PostgreSQL. Internal.

The proxy is not on `vault_net`. The admin listener binds all container interfaces, but the
source guard accepts only `OPENVAULT_PROXY_CIDRS` peers (and loopback for health/readiness);
`admin_net` placement is defense in depth. Agents cannot reach the admin listener, and
PostgreSQL is never an admin peer.

## Ports

| Port | Listener | Exposure |
|---|---|---|
| 80 | Caddy HTTP redirect / ACME | Host |
| 443 | Caddy public TLS | Host |
| 8443 | Admin HTTPS | Never published; `OPENVAULT_PROXY_CIDRS` guard is authoritative |
| 8444 | Agent mTLS | `vault_net`; never published |

Caddy reaches the admin listener at `openvaultd:8443` over `admin_net`. Agents use
`https://openvaultd:8444` with a client certificate from the internal CA.

## Required environment

The server requires `OPENVAULT_BASE_URL`, `OPENVAULT_DB_URL`, `OPENVAULT_KEYRING`,
`OPENVAULT_TLS_CERT`, `OPENVAULT_TLS_KEY`, and `OPENVAULT_INTERNAL_CA`. The reference stack
also sets:

| Variable | Value |
|---|---|
| `OPENVAULT_ADMIN_PORT` | `8443` |
| `OPENVAULT_AGENT_PORT` | `8444` |
| `OPENVAULT_TRUST_PROXY` | `true` |
| `OPENVAULT_PROXY_CIDRS` | `172.30.0.2/32` |
| `OPENVAULT_LOG_LEVEL` | `info` |

The keyring file must be a regular file with mode `0600`. The reference stack is not
bootable until the `ov init` provisioner from the CLI and backup/rotation releases creates the
keyring and TLS material.
Age-encrypted keyrings are not supported in the current release; setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` fails closed.

## Notes

- Replace the Caddy `tls internal` certificate with a trusted certificate for production.
- Caddy owns HSTS and the public client/upstream timeouts; the exact values are in
  `Caddyfile`.
- Do not expose ports 8443 or 8444 on the host.
- Disable swap or use encrypted swap.

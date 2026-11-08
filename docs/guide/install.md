# Install

## Requirements

| Component | Requirement |
|---|---|
| Docker | Current stable |
| Docker Compose | v2.24 or newer |
| Database | PostgreSQL 16 or 17 when running without the reference stack |

## Reference Compose installation

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://vault.example.com
export OPENVAULT_SITE_ADDRESS=vault.example.com
docker compose -f deploy/compose/compose.yaml up -d
```

`prepare.sh` creates the persistent host directories and Docker secrets with the
non-root owners the containers require. It needs root or equivalent permission once.
It never overwrites an existing secret.

The stack runs:

| Service | Purpose |
|---|---|
| `proxy` | Public TLS, routing, and security headers |
| `openvaultd` | API, authentication, access control, audit, and agent listener |
| `web` | Web UI |
| `postgres` | Database |
| `openvault-init` | One-shot keyring, certificate authority, TLS, organization, and bootstrap administrator |
| `openvault-roles` | One-shot least-privilege database grants |

Only the proxy publishes port 443. The admin listener (`8443`) and agent listener
(`8444`) stay on internal networks. Replace the local `tls internal` certificate
with a trusted certificate for anything beyond local use.

## First initialization

The Compose stack runs `ov init --prepare` automatically. For a manual install, set
`OPENVAULT_MIGRATION_DB_URL` to the migration role and run:

```bash
ov init
```

This creates the organization, bootstrap administrator, keyring, internal certificate
authority, server certificate, and signing material. Re-running `ov init` does not rotate an
existing certificate authority.

The bootstrap password is written once to a file with mode `0600`; it is never printed to
stdout, stderr, or container logs. Read it through the init container, sign in through the web
UI, change the password, then remove the temporary copy:

```bash
install -m 0600 /dev/null /tmp/openvault-bootstrap
docker compose -f deploy/compose/compose.yaml cp \
  openvault-init:/bootstrap/bootstrap-password /tmp/openvault-bootstrap
cat /tmp/openvault-bootstrap
rm -f /tmp/openvault-bootstrap
```

If the password is lost before the first login, start again with an empty database.

File-backed Compose secrets are bind mounts. `prepare.sh` makes them `0444` so non-root
container users can read them; the `0700` secrets directory keeps other host users out.

::: danger Protect the keyring
The keyring is outside the database and is the only way to decrypt stored values. Back it up
separately from the database, with mode `0600` and a parent directory that is not group- or
world-writable. Losing it means losing every secret.
:::

## Ports and networks

| Port | Listener | Exposure |
|---|---|---|
| 443 | Public TLS | Host |
| 8443 | Admin HTTPS | `admin_net` only; not published |
| 8444 | Agent TLS | `vault_net` only; not published |
| 8080 | Web UI | `web_net` only; not published |
| 5432 | Database | `db_net` only; not published |

The proxy reaches the admin listener on `admin_net`. Agents use the separate listener on
`vault_net`; the first join is token-authenticated, and every later agent request uses mutual
TLS. Application containers must not join `admin_net`, `vault_net`, or `db_net`.

## Next

- [Docker Compose](/guide/docker-compose)
- [Operations](/guide/operations)
- [Authentication](/guide/authentication)

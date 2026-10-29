# Reference Compose stack

> **Work in progress.** The release image and `ov init` are part of v0.1. This stack is the
> target topology; it is not usable until the release image is available.

The reference stack runs one host:

| Service | Networks | Purpose |
|---|---|---|
| `proxy` | `edge_net`, `vault_net` | TLS termination |
| `openvaultd` | `vault_net`, `db_net` | API, UI, auth, policy, audit |
| `postgres` | `db_net` | Metadata, ciphertext, audit chain |

Application Compose projects add one agent per service. The agent joins `vault_net` and the
project's default network; the application joins only its own network.

## Start

```bash
cp .env.example .env
# change POSTGRES_PASSWORD and OPENVAULT_BASE_URL
docker compose -f deploy/compose/compose.yaml up -d
# The openvault-init service prints the bootstrap password once.
docker compose -f deploy/compose/compose.yaml logs openvault-init
```

`ov init` creates the keyring, the internal CA, the server certificate, the JWT key, and
the bootstrap administrator. The bootstrap password is printed once.

## Networks

- `edge_net`: proxy only.
- `vault_net`: proxy, server, agents. Internal; no direct internet.
- `db_net`: server and PostgreSQL. Internal.

## Notes

- Replace the Caddy `tls internal` certificate with a trusted certificate for production.
- The proxy trusts the internal CA at `/etc/openvault/tls/ca.pem` for the upstream.
- Do not expose port 8443 on the host.
- Disable swap or use encrypted swap.

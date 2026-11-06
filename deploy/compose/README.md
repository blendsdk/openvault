# Reference Compose stack

This directory contains the single-host v0.1 deployment. The full operator guide is
[Docker Compose](/guide/docker-compose); the day-two runbook is
[Operations](/guide/operations).

## Files

| File | Purpose |
|---|---|
| `compose.yaml` | Four hardened services plus one-shot init and role-grant jobs |
| `Caddyfile` | Public TLS, API/UI routing, and security headers |
| `prepare.sh` | Creates host directories and Docker secrets with the right owners |
| `compose.test.yaml` | PostgreSQL 16/17 integration test services |
| `agent.example.yaml` | One generated agent snippet |
| `compose.review.yaml` | Loopback-only port overlay for the local review stack |
| `review.sh` | Builds, starts, seeds, and resets the disposable review environment |
| `review-seed.sh` | Creates the synthetic projects, secrets, certificates, and identities |

## Local review

For a disposable full-stack review with fake data, use the review script instead of the
production preparation steps:

```bash
./deploy/compose/review.sh up
./deploy/compose/review.sh password
```

The UI is at `https://localhost:8443` and the administrator is `admin@openvault.local`.
The script builds local images, applies the ownership Docker needs, starts the stack, and seeds
three projects. The full walkthrough is [Review the app](/guide/review).

## Start

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://vault.example.com
export OPENVAULT_SITE_ADDRESS=vault.example.com
docker compose -f deploy/compose/compose.yaml up -d
```

The first start creates the keyring, internal CA, server TLS pair, organization, bootstrap
administrator, and least-privilege database roles. The bootstrap password is a one-time
`0600` file under `data/bootstrap/`; read it through the init container as described in
[Docker Compose](/guide/docker-compose#bootstrap-password). It is never printed to container
logs.

File-backed Compose secrets are bind mounts. `prepare.sh` makes the secret files `0444` so the
non-root service users can read them; the `0700` secrets directory keeps other host users out.

## Topology

| Service | Networks | Purpose |
|---|---|---|
| `proxy` | `edge_net`, `admin_net`, `web_net` | Public 443, HSTS, routing |
| `openvaultd` | `admin_net`, `vault_net`, `db_net` | API and agent listener |
| `web` | `web_net` | Static SPA |
| `postgres` | `db_net` | Database |

Only the proxy publishes a port. The admin and agent listeners are never published.
`admin_net`, `web_net`, `vault_net`, and `db_net` are internal. Every service runs
non-root with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, log
rotation, and resource limits.

## Validation

```bash
pnpm check:compose
docker compose -f deploy/compose/compose.yaml config
```

`pnpm verify` runs the contract check. It fails if a service loses its hardening fields,
publishes an internal port, mounts the Docker socket, or puts a database password in the
Compose model.

## Notes

- Replace the Caddy `tls internal` certificate with a trusted certificate for production.
- Pin the first-party images by digest from the signed release.
- Keep the keyring, backup archive, passphrase, and off-box checkpoint in separate custody.
- Re-run `deploy/postgres/grants.sql` after a migration that adds a table the purge or
  prune path must access.

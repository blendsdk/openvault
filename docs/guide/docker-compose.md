# Docker Compose

The reference stack runs one host with four OpenVault services plus PostgreSQL:

| Service | Networks | Purpose |
|---|---|---|
| `proxy` | `edge_net`, `admin_net`, `web_net` | Public TLS, HSTS, API/UI routing |
| `openvaultd` | `admin_net`, `vault_net`, `db_net` | API, auth, policy, audit, agent listener |
| `web` | `web_net` | Static SPA with its own CSP and cache policy |
| `postgres` | `db_net` | Metadata, ciphertext, audit chain |
| `openvault-init` | `db_net` | One-shot keyring, CA, TLS, org, bootstrap admin |
| `openvault-roles` | `db_net` | One-shot least-privilege grants |

Application Compose projects add one agent per service. The agent joins `vault_net` and the
project's default network; the application joins only its own network.

## Prepare the host

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://vault.example.com
export OPENVAULT_SITE_ADDRESS=vault.example.com
docker compose -f deploy/compose/compose.yaml up -d
```

`OPENVAULT_SITE_ADDRESS` must name the same host as `OPENVAULT_BASE_URL`; Caddy uses it
as the site address. `prepare.sh` creates:

- `data/postgres` owned by UID 70 with mode `0700`.
- `data/openvault`, `data/tls`, and `data/ca` owned by UID 10001.
- `data/caddy` owned by UID 65534.
- Docker secrets for the PostgreSQL bootstrap password and five role URLs
  (`migrator`, `app`, `auth`, `backup`, and `purger`).

File-backed Compose secrets are bind mounts rather than Swarm secrets. `prepare.sh` makes the
secret files `0444` so the non-root service users can read them; the `0700` secrets directory
keeps other host users out.

Set `OPENVAULT_DATA_DIR` and `OPENVAULT_SECRETS_DIR` to move them. The script never
overwrites an existing secret. It needs root or equivalent permission once to set
the non-root ownership. A rootless Docker host must map the same UIDs.

## Database roles

| Role | Owner | Runtime use |
|---|---|---|
| `openvault_migrator` | Database, schema, tables | Migrations, restore, and bootstrap |
| `openvault_app` | None | The server process |
| `openvault_auth` | None | Authentication, RBAC, and agent identity |
| `openvault_backup` | None | Read-only logical backup dump |
| `openvault_purger` | None | Secret and certificate purge |
| `openvault_pruner` | None | Audit prune; `EXECUTE` only |

PostgreSQL runs the role bootstrap from `deploy/postgres/init-roles.sh` on a fresh data
directory. `openvault-init` runs migrations as the migrator and creates the keyring,
CA, TLS pair, organization, and bootstrap administrator. `openvault-roles` then runs
`ensure-auth-role.sql`, `ensure-backup-role.sql`, and `grants.sql`, and asserts that the
migrator owns every application table.

The server reads full role URLs from Docker secrets through
`OPENVAULT_DB_URL_FILE`, `OPENVAULT_MIGRATION_DB_URL_FILE`, `OPENVAULT_AUTH_DB_URL_FILE`, and
`OPENVAULT_PURGE_DB_URL_FILE`. The host backup job reads
`OPENVAULT_BACKUP_DB_URL_FILE` for the dump and `OPENVAULT_DB_URL_FILE` for the audit event.
No password is placed in the Compose model or the process environment inherited by child
processes.

If the PostgreSQL volume already exists, the init scripts do not re-run, but the
`openvault-roles` job still runs the ensure scripts and `grants.sql` on every deployment.
Re-run `grants.sql` after a migration that adds a table the runtime, purge, prune, or backup
path must access.

## Bootstrap password

The init container writes a one-time password file with mode `0600`. It is never printed to
logs. The data directory is owned by the container user, so read the password through the init
container rather than the host path:

```bash
install -m 0600 /dev/null /tmp/openvault-bootstrap
docker compose -f deploy/compose/compose.yaml cp \
  openvault-init:/bootstrap/bootstrap-password /tmp/openvault-bootstrap
cat /tmp/openvault-bootstrap
rm -f /tmp/openvault-bootstrap
```

If the file is lost before the first login, start again with an empty database. There is
no recovery path for a never-used bootstrap password.

## Networks and ports

| Port | Listener | Exposure |
|---|---|---|
| 443 | Caddy public TLS | Host |
| 8443 | Admin HTTPS | `admin_net` only; never published |
| 8444 | Agent mTLS | `vault_net` only; never published |
| 8080 | Static web | `web_net` only; never published |

`edge_net` is the proxy's only non-internal network, so it can reach ACME endpoints.
`admin_net`, `web_net`, `vault_net`, and `db_net` are internal. The proxy routes `/v1`,
`/health`, and `/ready` to the API and everything else to the static SPA.

The admin listener binds all container interfaces, but the source guard accepts only
`OPENVAULT_PROXY_CIDRS` peers (and loopback for health and readiness). `admin_net`
placement is defense in depth. Agents cannot reach the admin listener. PostgreSQL is
never an admin peer.

## Hardening

Every service has:

- A non-root user: postgres 70, Caddy nobody 65534, nginx 101, OpenVault 10001.
- `read_only: true` and a writable tmpfs only where the process needs one.
- `cap_drop: [ALL]`; the proxy adds only `NET_BIND_SERVICE`.
- `no-new-privileges:true`.
- JSON log rotation at 10 MiB with three files.
- CPU and memory limits.

No service mounts the Docker socket. The API and agent listeners are never published.
`pnpm check:compose` enforces these properties in `pnpm verify`.

## Agent scaffold

```bash
ov docker scaffold payments api
```

The command calls `POST /v1/admin/scaffold`. The backend creates or reuses the project and
service identity, grants object-scope `secrets.reader` only for the manifest entries, revokes
older unused join tokens, issues a new one-time token, and returns a per-service Compose
snippet plus a manifest skeleton. It is idempotent and never writes the token into the
Compose file.

### Prepare the host directories

Docker creates missing bind sources as root. Create the agent-owned directories before the
first start:

```bash
install -d -m 0700 -o 10001 -g 10001 \
  "/dev/shm/openvault/payments/${COMPOSE_PROJECT_NAME}/api" \
  "./openvault-state/payments/${COMPOSE_PROJECT_NAME}/api"
install -m 0444 -o 10001 -g 10001 ./openvault-ca.pem \
  "./openvault.${COMPOSE_PROJECT_NAME}.payments.api.manifest.yaml"
```

### Generated snippet

```yaml
services:
  openvault-agent-api:
    image: "blendsdk/openvault-agent:1.0.1"
    command: ["run"]
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      OPENVAULT_URL: "https://openvaultd:8444"
      OPENVAULT_CA_FILE: "/etc/openvault/ca.pem"
      OPENVAULT_JOIN_TOKEN: "${OPENVAULT_JOIN_TOKEN}"
      OPENVAULT_PROJECT: "payments"
      OPENVAULT_SERVICE: "api"
      COMPOSE_PROJECT_NAME: "${COMPOSE_PROJECT_NAME}"
      OPENVAULT_MANIFEST: "/etc/openvault/manifest.yaml"
      OPENVAULT_OUTPUT_DIR: "/run/secrets"
      OPENVAULT_STATE_DIR: "/var/lib/openvault"
    tmpfs:
      - /run/openvault:uid=10001,gid=10001,mode=0700,size=16m
    volumes:
      - type: bind
        source: /dev/shm/openvault/payments/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-state/payments/${COMPOSE_PROJECT_NAME}/api
        target: /var/lib/openvault
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-ca.pem
        target: /etc/openvault/ca.pem
        read_only: true
      - type: bind
        source: ./openvault.${COMPOSE_PROJECT_NAME}.payments.api.manifest.yaml
        target: /etc/openvault/manifest.yaml
        read_only: true
    networks: [default, vault_net]
    healthcheck:
      test: ["CMD", "ov-agent", "health", "--ready"]
      interval: 10s
      timeout: 10s
      retries: 3
      start_period: 10s

  api:
    user: "10001:10001"
    volumes:
      - type: bind
        source: /dev/shm/openvault/payments/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        read_only: true
        bind:
          create_host_path: false
    depends_on:
      openvault-agent-api:
        condition: service_healthy

networks:
  vault_net:
    external: true
```

Set `OPENVAULT_JOIN_TOKEN` in the shell or an environment file outside the Compose file. Never
commit it. For production, replace the image tag with the signed digest from the release.

## UID, modes, and swap

A non-root agent cannot change file ownership. Run the agent and the application with the same
UID, for example `10001:10001`. The default file mode is `0400`.

`/dev/shm` is tmpfs, but the host can swap it. For production, disable swap or use encrypted
swap on the vault host.

## Next

- [Agent](/guide/agent)
- [Operations](/guide/operations)
- [Backup and restore](/guide/backup-restore)

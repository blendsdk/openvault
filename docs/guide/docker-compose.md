# Docker Compose

The scaffold backend is implemented. The `ov docker scaffold` command that calls it arrives
with the CLI release.

## The delivery model

Each Compose service gets its own agent container and its own host tmpfs directory:

```text
/dev/shm/openvault/<compose-project>/<service>/
```

The agent and the application mount the same directory. The application mount is read-only.
A second Compose project cannot read the first project's directory. The agent and application
run with the same UID, for example `10001:10001`, so the application can read the `0400` files.

## Scaffold

```bash
ov docker scaffold payments api
```

The command calls `POST /v1/admin/scaffold`. The backend creates or reuses the project and
service identity, grants object-scope `secrets.reader` only for the manifest entries, revokes
older unused join tokens, issues a new one-time token, and returns a per-service Compose
snippet plus a manifest skeleton. It is idempotent and never writes the token into the Compose
file.

```http
POST /v1/admin/scaffold
{ "project": "payments", "service": "api",
  "entries": ["db-password", "stripe-api-key"] }
```

A project with entries must already exist and contain those secrets. A new project can be
scaffolded with an empty entry list; add entries to the returned manifest before starting the
agent.

### Prepare the host directories

Docker creates missing bind sources as root. Create the agent-owned directories before the
first start:

```bash
install -d -m 0700 -o 10001 -g 10001 \
  "/dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api" \
  "./openvault-state/${COMPOSE_PROJECT_NAME}/api"
install -m 0444 -o 10001 -g 10001 ./openvault-ca.pem \
  "./openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml"
```

### Generated snippet

```yaml
services:
  openvault-agent-api:
    image: "ghcr.io/blendsdk/openvault-agent:0.1.0"
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
        source: /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-state/${COMPOSE_PROJECT_NAME}/api
        target: /var/lib/openvault
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-ca.pem
        target: /etc/openvault/ca.pem
        read_only: true
      - type: bind
        source: ./openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml
        target: /etc/openvault/manifest.yaml
        read_only: true
    networks: [default, vault_net]
    healthcheck:
      test: ["CMD", "ov-agent", "health", "--ready"]
      interval: 10s
      timeout: 3s
      retries: 3

  api:
    user: "10001:10001"
    volumes:
      - type: bind
        source: /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api
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
commit it.

## Networks

- `vault_net` is created by the OpenVault stack and shared with the agent. It carries only the
  agent mTLS listener on `8444`.
- The admin listener on `8443` is on `admin_net`, which the proxy owns. Agents and applications
  must not join it.
- The application stays on its Compose project's default network.
- The application has no route to the vault.

## UID, modes, and swap

A non-root agent cannot change file ownership. Run the agent and the application with the same
UID, for example `10001:10001`. The default file mode is `0400`.

`/dev/shm` is tmpfs, but the host can swap it. For production, disable swap or use encrypted
swap on the vault host.

## Next

- [Agent](/guide/agent)
- [CLI](/guide/cli)

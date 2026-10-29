# Docker Compose

::: warning Target documentation
The scaffold command and reference stack are part of v0.1.
:::

## The delivery model

Each Compose service gets its own agent container and its own host tmpfs directory:

```text
/dev/shm/openvault/<compose-project>/<service>/
```

The agent and the application mount the same directory. The application mount is
read-only. A second Compose project cannot read the first project's directory.

```yaml
services:
  openvault-agent:
    image: openvault/agent:0.1
    environment:
      OPENVAULT_URL: https://openvaultd:8443
      OPENVAULT_CA_FILE: /etc/openvault/ca.pem
      OPENVAULT_JOIN_TOKEN: ${OPENVAULT_JOIN_TOKEN}
      OPENVAULT_PROJECT: payments
      OPENVAULT_SERVICE: api
      COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME}
    user: "10001:10001"
    volumes:
      - /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api:/run/secrets
      - openvault_agent_state:/var/lib/openvault
      - ./openvault-ca.pem:/etc/openvault/ca.pem:ro
    networks: [default, vault_net]
    healthcheck:
      test: ["CMD", "ov-agent", "health"]
      interval: 10s
      timeout: 3s
      retries: 3

  api:
    build: .
    user: "10001:10001"
    volumes:
      - /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api:/run/secrets:ro
    networks: [default]
    depends_on:
      openvault-agent:
        condition: service_healthy
```

## Networks

- `vault_net` is created by the OpenVault stack and shared with the agent.
- The application stays on its Compose project's default network.
- The application has no route to the vault.

## Scaffold

```bash
ov docker scaffold payments api
```

The command creates the project and service identity if needed, issues a single-use join
token, and prints the agent snippet. It is idempotent: running it again does not create a
second identity or service.

## UID and file modes

A non-root agent cannot change file ownership. Run the agent and the application with the
same UID, for example `10001:10001`. The default file mode is `0400`.

## Swap

`/dev/shm` is tmpfs, but the host can swap it. For production, disable swap or use
encrypted swap on the vault host.

## Next

- [Agent](/guide/agent)
- [CLI](/guide/cli)

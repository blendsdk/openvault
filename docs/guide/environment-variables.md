# Environment variables

OpenVault's per-service agent runs in its own container. Environment variables
set there do not reach the application container. The recommended pattern is a
sidecar agent that writes the secret to a shared tmpfs and a small loader in the
application container that exports it before the application starts.

The [environment-variable example](https://github.com/blendsdk/openvault/tree/main/examples/compose-env)
is a complete Compose setup. This page explains the pattern and its limits.

## How it works

1. The agent fetches the secret over mTLS and writes it atomically to the
   per-service tmpfs directory.
2. The application container mounts that directory read-only.
3. A loader reads an environment map, exports each file as an environment
   variable, and `exec`s the application.
4. The application starts with the variables in its own process environment.

```text
agent container                    application container
┌──────────────────┐               ┌──────────────────────────────┐
│ OpenVault agent  │  shared tmpfs │ loader.sh                    │
│ writes 0400 file ├──────────────▶│ reads file, exports variable │
└──────────────────┘               │ exec application             │
                                   └──────────────────────────────┘
```

## Example

The example maps the manifest entry `api-token` to `APP_API_TOKEN`:

```yaml
# env.map
APP_API_TOKEN=api-token
```

```sh
# loader.sh (simplified)
while IFS='=' read -r name file; do
  value=$(cat "/run/secrets/$file")
  export "$name=$value"
done < /opt/openvault/env.map

exec "$@"
```

The application service uses the loader as its entrypoint:

```yaml
services:
  api:
    entrypoint: ["/bin/sh", "/opt/openvault/load-env.sh"]
    volumes:
      - type: bind
        source: /dev/shm/openvault/quickstart/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        read_only: true
      - type: bind
        source: ./loader.sh
        target: /opt/openvault/load-env.sh
        read_only: true
      - type: bind
        source: ./env.map
        target: /opt/openvault/env.map
        read_only: true
    depends_on:
      openvault-agent-api:
        condition: service_healthy
```

The agent and the application must run with the same UID so the application can
read the `0400` files. The [example](https://github.com/blendsdk/openvault/tree/main/examples/compose-env)
uses UID/GID `10001`.

## Limits

| Limit | Detail |
|---|---|
| Single-line values | The shell removes a trailing newline. A NUL byte cannot be represented in an environment variable. Use file delivery for binary or multi-line secrets. |
| Startup only | The loader runs when the application container starts. After a rotation, restart the application to pick up the new value. |
| Same UID | The agent writes `0400` files. The application user must match the agent user. |
| No secret in the image | The variables are injected at runtime. Do not bake secret values into an image, Compose file, or command line. |
| No logging | The loader never prints values. Keep the application from logging its environment. |

## Wrapper mode

A distroless application that cannot run a shell loader can run the agent inside
the application container in wrapper mode:

```bash
ov-agent run -- /app/server
```

The agent starts the child with the manifest's `env:` entries in its
environment. Wrapper mode is for a fully trusted application: the child runs as
the same UID and can read the agent state directory. See [Agent](/guide/agent).

## Next

- [Environment-variable example](https://github.com/blendsdk/openvault/tree/main/examples/compose-env)
- [Agent](/guide/agent)
- [Docker Compose](/guide/docker-compose)
- [Secrets](/guide/secrets)

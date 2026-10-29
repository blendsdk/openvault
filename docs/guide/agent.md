# Agent

::: warning Target documentation
The agent is part of v0.1 and is not implemented in the current scaffold.
:::

The agent runs next to an application service. It authenticates with mTLS, fetches the
manifest's secrets, and writes them atomically to a tmpfs directory.

## Modes

| Mode | Use | Environment export |
|---|---|---|
| Sidecar | Default. One agent per Compose service. | Not possible across containers |
| Wrapper | `ov-agent run -- <cmd>` inside the app container | Opt-in per entry |

Environment variables set in one container cannot reach another. The default sidecar
therefore delivers files only. Environment export is a compatibility mode for legacy apps
that cannot read a file.

## Manifest

```yaml
project: payments
service: api
refresh: 300s
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
    mode: "0400"
  - name: stripe-api-key
    file: stripe_key
    mode: "0400"
  - name: legacy-token
    env: LEGACY_TOKEN
    optional: true
```

Rules:

- `output_dir` must equal the configured root.
- `file` matches `^[A-Za-z0-9._-]+$` and cannot contain `..` or start with `/`.
- At least one of `file` or `env` is required.
- `env` is rejected in sidecar mode.
- Optional entries may fail without failing the whole refresh.

## Startup and refresh

At startup the agent fetches every required entry. If any required entry fails, it writes
nothing and exits non-zero. The application's `depends_on` health gate prevents it from
starting without secrets.

| Result | Behavior |
|---|---|
| Success | Write atomically, update status and consumer `last_seen` |
| 5xx or network error | Keep last known good, status `degraded`, log |
| 401/403 | Remove files, status `failed`, exit 1 |
| 404 on a required entry | Remove files, status `failed`, exit 1 |
| 404 on an optional entry | Remove that file, status `degraded`, continue |

## Local API

The agent exposes a read-only unix socket at `/run/openvault/agent.sock`:

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/secrets/:name` | The last delivered value for a manifest entry |
| GET | `/v1/status` | Status without values |

It never calls the vault on demand. It cannot widen access beyond the manifest.

## Status

- File: `/run/openvault/status.json`
- Health command: `ov-agent health`
- The container is healthy only after the first successful fetch.

## Consumer metadata

The agent registers its Compose project, service, hostname, and manifest hash. The UI and
`ov access explain` use this for the "used by" view.

## Next

- [Docker Compose](/guide/docker-compose)
- [Troubleshooting](/guide/troubleshooting)

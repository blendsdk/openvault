# Agent

The `ov-agent` binary runs next to one Docker Compose service. Its first start joins with a
one-time token, then it authenticates with mTLS, fetches only its manifest, writes files
atomically to a tmpfs directory, refreshes on an interval, and renews its certificate before
expiry. The application never talks to the vault.

## Modes

| Mode | Command | Use | Environment export |
|---|---|---|---|
| Sidecar | `ov-agent run` | Default. One agent per Compose service. | Not possible across containers |
| Wrapper | `ov-agent run -- <cmd>` | Inside the app container for legacy apps | Opt-in per `env:` entry |
| Once | `ov-agent run --once` | Debugging and CI | Sidecar rules |

Environment variables set in one container cannot reach another. The default sidecar therefore
delivers files only. To export those files as environment variables inside the application
container, use the loader pattern in [Environment variables](/guide/environment-variables).
Wrapper mode is for a fully trusted application that cannot run a loader: the child runs as
the same UID and can read the agent state directory.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENVAULT_URL` | yes | — | HTTPS origin of the agent listener; no path, query, or credentials |
| `OPENVAULT_CA_FILE` | yes | — | PEM bundle that verifies the vault server |
| `OPENVAULT_JOIN_TOKEN` | first start | — | One-time 43-character token; not stored |
| `OPENVAULT_PROJECT` | yes | — | OpenVault project name |
| `OPENVAULT_SERVICE` | yes | — | Service identity name |
| `COMPOSE_PROJECT_NAME` | yes | — | Compose project name |
| `OPENVAULT_MANIFEST` | no | `/etc/openvault/manifest.yaml` | Absolute manifest path |
| `OPENVAULT_OUTPUT_DIR` | no | `/run/secrets` | Absolute output root; must equal the manifest |
| `OPENVAULT_STATE_DIR` | no | `/var/lib/openvault` | Absolute state directory, mode `0700` |
| `OPENVAULT_STATUS_FILE` | no | `/run/openvault/status.json` | Absolute status file |
| `OPENVAULT_SOCKET_PATH` | no | `/run/openvault/agent.sock` | Absolute unix socket |

## Manifest

```yaml
project: payments
service: api
refresh: 300s
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
  - name: stripe-api-key
    file: stripe_key
    mode: "0400"
  - name: legacy-token
    env: LEGACY_TOKEN
    optional: true
```

Rules:

- `project`, `service`, and `output_dir` must equal the environment values.
- `refresh` is 30s–24h; the default is 300s.
- `file` matches `^[A-Za-z0-9._-]+$`, cannot contain `..` or start with `/`.
- `mode` is `0400`, `0440`, `0600`, or `0640`; the default is `0400`.
- At least one of `file` or `env` is required. Both may be present in wrapper mode.
- `env` is rejected in sidecar mode and uses a loader-safe name.
- Optional entries may fail without failing the whole refresh.
- The manifest is read once at startup. A change requires a restart; files that are no longer
  targeted are removed at the next start.

## Startup and refresh

At startup the agent fetches every required entry. If any required entry fails, it writes
nothing and exits non-zero. The application's `depends_on` health gate prevents it from
starting without secrets.

| Result | Behavior |
|---|---|
| Success | Write atomically, update status and consumer `last_seen`/`state` |
| 5xx or network error | Keep last known good, status `degraded`, log |
| 401/403 or TLS certificate rejection | Remove files, clear the stored identity, status `failed`, exit 1 |
| 404 on a required entry | Remove files, status `failed`, exit 1 |
| 404 on an optional entry | Remove that file, status `degraded`, continue |
| Other 4xx, 3xx, or malformed response | Remove files, status `failed`, exit 1 |

Every write uses a temporary file in the same directory, `fsync`, `rename`, and `chmod`.
Startup stages all new files before renaming any of them, so the application never sees a mixed
set.

## Renewal

The agent renews after two thirds of the certificate's actual lifetime with a fresh key and
certificate request. It retries with jitter and exponential backoff, keeps the old certificate
usable until expiry, and reuses the same pending request for the server's five-minute replay
window.
A lost response can therefore be retried without creating a second certificate. After the
window, or after a server restart that lost the replay cache, a retry may require a new join
token. A credential rejection clears the stored identity, so a new token can be used on the next
start.

## Local API

The agent exposes a read-only unix socket at `/run/openvault/agent.sock`:

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/secrets/:name` | The last delivered value for a manifest entry |
| GET | `/v1/status` | Status without values |

It never calls the vault on demand and cannot widen access beyond the manifest.

## Status and health

- File: `/run/openvault/status.json`
- `ov-agent health` prints `ok`, `degraded`, or `failed` and exits 0, 1, or 2.
- `ov-agent health --ready` exits 0 when every required entry is delivered, even if optional
  entries are degraded. The Compose healthcheck uses this mode.
- A status file older than three refresh intervals plus 60 seconds is treated as failed.

## Consumer metadata

The agent registers its Compose project, service, hostname, and manifest hash on join and
renew, and updates `last_seen` and `state` on every fetch plus a final aggregate heartbeat. A
state change writes one `consumer.update` audit event; a `last_seen`-only heartbeat does not.
The metadata is self-reported and never used for authorization.

## Next

- [Docker Compose](/guide/docker-compose)
- [Environment variables](/guide/environment-variables)
- [Troubleshooting](/guide/troubleshooting)

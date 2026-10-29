# Agent delivery

## One agent per service

Each Compose service gets its own agent and its own host tmpfs directory:

```text
/dev/shm/openvault/<compose-project>/<service>/
```

The agent and application mount the same directory; the application mount is read-only.
A sibling service or another Compose project cannot read it.

## Why not one agent per project?

A shared agent would write every project secret into one volume. Any service in the
project could read all of them. Per-service agents cost one small container each and give
least-privilege delivery.

## Failure semantics

| Failure | Behavior |
|---|---|
| Startup, required secret unavailable | Exit non-zero, write nothing |
| Refresh, 5xx or network error | Keep last known good, mark degraded |
| Refresh, 401/403 | Remove files, mark failed, exit |
| Required entry 404 | Remove files, mark failed, exit |
| Optional entry 404 | Remove that file, mark degraded |

The application's `depends_on: condition: service_healthy` prevents it from starting before
the first successful fetch.

## Local API

The agent exposes a read-only unix socket:

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/secrets/:name` | Last delivered value for a manifest entry |
| GET | `/v1/status` | Status without values |

It never calls the vault on demand and cannot widen access beyond the manifest.

## Consumer metadata

The agent registers Compose project, service, hostname, and manifest hash. The server
updates `last_seen` on every refresh. The UI and `ov access explain` use it for the "used
by" view.

## Environment export

A sidecar cannot set environment variables in another container. Environment export is
available only in wrapper mode:

```bash
ov-agent run -- ./start.sh
```

The agent fetches, writes files, exports the manifest's `env:` entries, and execs the child.
Environment variables leak through `/proc`, child processes, and crash dumps; prefer files.

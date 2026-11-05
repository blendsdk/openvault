# Agent delivery

## One agent per service

Each Compose service gets its own agent and its own host tmpfs directory:

```text
/dev/shm/openvault/<compose-project>/<service>/
```

The agent and application mount the same directory; the application mount is read-only.
A sibling service or another Compose project cannot read it. The scaffold derives
`openvault-agent-<service>`, `openvault-state/<compose-project>/<service>`, and
`openvault.<compose-project>.<service>.manifest.yaml` so two services in one Compose project do
not share an agent, a state volume, or a manifest.

## Why not one agent per project?

A shared agent would write every project secret into one volume. Any service in the project
could read all of them. Per-service agents cost one small container each and give least
privilege.

## Runtime

1. Load the strict manifest and verify project/service/output agreement.
2. Join with a single-use token if no valid `0600` identity exists.
3. Fetch every required entry into memory; write files only after all required entries succeed.
4. Write each file with a temporary file, `fsync`, `rename`, and `chmod`; default mode `0400`.
5. Refresh on the manifest interval with a single-flight guard. Transient failures keep the
   last known good; credential failures remove the managed set and exit.
6. Renew at two thirds of the certificate's actual lifetime with a fresh P-256 key and CSR.
   Pending key/CSR material is reused for the server's five-minute replay window.
7. Expose a `0660` unix socket and a value-free status file.

## Failure semantics

| Failure | Behavior |
|---|---|
| Startup, required secret unavailable | Exit non-zero, write nothing |
| Refresh, 5xx or network error | Keep last known good, mark degraded |
| Refresh, 401/403 or TLS certificate rejection | Remove files, mark failed, exit |
| Required entry 404 | Remove files, mark failed, exit |
| Optional entry 404 | Remove that file, mark degraded |
| Other 4xx, 3xx, or malformed response | Remove files, mark failed, exit |

The application's `depends_on: condition: service_healthy` prevents it from starting before
the first successful fetch. The Compose healthcheck calls `ov-agent health --ready`, which
ignores optional-only degradation but requires every required entry.

## Local API

The agent exposes a read-only unix socket:

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/secrets/:name` | Last delivered value for a manifest entry |
| GET | `/v1/status` | Status without values |

It never calls the vault on demand and cannot widen access beyond the manifest.

## Authentication

The first start uses a one-time join token on the agent listener. The agent generates an
EC P-256 key and CSR; the server derives the certificate identity from the token, signs a
fixed-profile certificate, and returns the leaf and CA chain. Every later request uses the
certificate over mTLS. Fetching uses `GET /v1/data/:project/secrets/:name` on the agent
listener; the certificate's owner project must match `:project`. The agent renews after
two thirds of the certificate's lifetime with a fresh key and CSR; the old certificate remains
valid for data until expiry but cannot renew. An expired or revoked certificate causes the
agent to remove its files and exit.

## Consumer metadata

The agent registers Compose project, service, hostname, and manifest hash on join and renew.
Each fetch sends the aggregate state and the entry's optional flag; the server updates
`consumers.last_seen` and `state`. A final `POST /v1/agent/consumer` records the aggregate after
every cycle, including a last-entry failure. A state change writes one `consumer.update` audit
event; a `last_seen`-only update is not audited. Metadata is self-reported and never used for
authorization.

## Wrapper mode

A sidecar cannot set environment variables in another container. Environment export is
available only in wrapper mode:

```bash
ov-agent run -- ./start.sh
```

The agent fetches, writes files, exports only the manifest's `env:` entries, and execs the
child without a shell. The child runs as the same UID and can read the agent state directory;
wrapper mode therefore requires a fully trusted application. Prefer files.

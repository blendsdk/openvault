---
"@openvault/agent": minor
"@openvault/api-contract": minor
"@openvault/server": minor
---

Add the per-service agent, consumer heartbeat state, and the Compose scaffold backend.

The new `ov-agent` binary joins with a one-time token, fetches its manifest over mTLS, writes
tmpfs files atomically, refreshes with the RD-10 failure matrix, renews at two thirds of the
certificate lifetime, exposes a read-only unix socket and value-free status, and supports
`--once` and opt-in wrapper mode.

Agent fetches now report an allowlisted consumer state; state transitions write
`consumer.update` audit events. `POST /v1/admin/scaffold` creates or reuses the project and
identity, grants object-scope `secrets.reader` only for the manifest entries, rotates the join
token atomically, and returns per-service Compose and manifest output.

# Requirements: RD-10 Agent Delivery and Compose

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-10](../../requirements/RD-10-agent-compose.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan
- RD-10 one agent per Compose service with a strict manifest naming one OpenVault project and one service.
- Per-service tmpfs output directory, `0700` ownership, default `0400` files, atomic writes.
- Join with a one-time token, EC P-256 key and CSR, certificate/key storage, and no private-key upload.
- Fetch through the existing agent-listener data route with project-ownership enforcement.
- Startup all-or-nothing and the full refresh failure matrix.
- Consumer metadata on join/renew, immediate `last_seen`/`state` on fetch headers, and a final aggregate heartbeat with one audit event per state change.
- Two-thirds renewal with a fresh key, jitter/backoff, replays on the same pending key, atomic swap.
- Read-only unix socket, value-free status file, `ov-agent health`, `--once`.
- Opt-in wrapper mode with `env:` export only.
- `POST /v1/admin/scaffold`: create or reuse project and identity, object-scope reader grants, one-time token, per-service hardened Compose snippet, manifest skeleton, and previous-token revocation.
- The agent package, server state headers, scaffold route, tests, documentation, deployment example, changelog, and changeset.

### Deferred / out of this plan
- RD-11 `ov docker scaffold` and the rest of the `ov` CLI.
- RD-12 consumer UI.
- RD-13 backup/rotation and operational runbooks.
- RD-14 image publishing, release signing, and external review.
- RD-10 Won't Have: one agent per project, shared agents, Docker socket access, remote Docker hosts, Kubernetes, CSI, and certificate delivery to agents.

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Package and binary | `apps/agent`, `@openvault/agent`, `ov-agent` | AR-1 |
| RD-11 boundary | Agent binary and scaffold backend only | AR-2 |
| Modes | Sidecar, wrapper, `--once` | AR-3 |
| Configuration | `OPENVAULT_*` environment, manifest agreement | AR-4 |
| Manifest | Strict YAML, 1–100 unique entries | AR-5 |
| Output safety | Safe names and four modes | AR-6 |
| Manifest hash | Raw file SHA-256 | AR-7 |
| State | Atomic `identity.json`, pending renewal file | AR-8 |
| Join | One key/CSR, transient retry | AR-9 |
| Renewal | Two-thirds, jitter/backoff, five-minute key reuse | AR-10 |
| Failure matrix | Published matrix plus terminal 4xx | AR-11 |
| Startup | Buffer, then write | AR-12 |
| Status | Value-free JSON, exit 0/1/2 | AR-13 |
| Local API | Unix socket, manifest entries only | AR-14 |
| Wrapper | `env:` only, denylist, no shell | AR-15 |
| Logging | Structured and value-free | AR-16 |
| HTTPS | Core Node with CA and client certificate | AR-17 |
| Consumer state | Fetch headers plus a final heartbeat route; state changes audited | AR-18 |
| Scaffold | Server route, idempotent, per-service compose, object scope | AR-19–AR-22 |
| Schema | No migration | AR-23 |
| Tests | Real TLS, filesystem, PostgreSQL | AR-24 |
| Verification | Full repository gates | AR-25 |
| Dependencies | Pinned workspace libraries | AR-26 |
| Image | Pinned tag, no Dockerfile | AR-27 |
| Manifest changes | Restart required | AR-28 |
| Shutdown | Keep files, exit 0 | AR-29 |
| Concurrency | Single-flight refresh and cancellation | AR-31 |
| Wrapper trust | Same-UID child is trusted; environment sanitized | AR-15, AR-32 |

## Acceptance Criteria

The RD owns its acceptance criteria. This plan adds these executable criteria:

1. Every RD-10 acceptance criterion is covered by at least one specification test in
   [07-testing-strategy.md](07-testing-strategy.md), except the `ov` command wrapper owned by
   RD-11 and the container image owned by RD-14.
2. The agent sends no private key, join token, value, or PEM body in any log, status file,
   local-socket status response, or error message.
3. A manifest with an unknown field, `..`, an absolute file, an unsafe mode, a duplicate
   target, or a project/service/output mismatch fails before any network request.
4. A startup with one required entry unavailable creates no managed output file; a transient
   refresh failure keeps the last known good; a credential failure removes every managed file.
5. The local socket returns 404 for a name outside the manifest and never triggers a vault
   request.
6. The consumer row remains one row per identity; its `last_seen` and `state` change after an
   agent fetch with the state headers, and a final heartbeat records the aggregate. A state
   change writes one `consumer.update` event; a `last_seen`-only update does not.
7. The scaffold route is idempotent for the project, identity, and object-scope assignments,
   revokes previous unused tokens, issues a fresh single-use token, and returns per-service
   Compose and manifest documents that contain no literal token.
8. The scaffold grants only `secrets.reader` at `object` scope; no project- or org-scope
   reader assignment is created, and a reused identity with a broader grant is rejected.
9. Two services in one Compose project receive distinct agent service names, state paths, and
   manifest mounts, and each application depends only on its own agent.
10. Wrapper mode removes every `OPENVAULT_*` variable from the child environment, exports only
    `env:` entries, and documents the same-UID trust residual.
11. `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, the docs
   build, and the integration suite pass on PostgreSQL 16 and 17 before the plan is marked
   done.

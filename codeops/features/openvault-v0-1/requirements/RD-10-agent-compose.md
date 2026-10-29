# RD-10: Agent Delivery and Compose

> **Document**: RD-10-agent-compose.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-05, RD-07, RD-08
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the per-service agent that delivers secrets into a Docker Compose
service without exposing the vault to the application network. Each service gets its own
agent and its own host tmpfs directory. The agent authenticates with mTLS, fetches only its
manifest, writes files atomically, refreshes on an interval, exposes status and a local
read-only API, and registers consumer metadata. A scaffold command generates the Compose
snippet.

## Functional Requirements

### Must Have

- [ ] One agent per Compose service; the manifest names exactly one OpenVault project and one
  service.
- [ ] The output directory is `/dev/shm/openvault/<compose-project>/<service>` (or a
  configured root), mode `0700`, owned by the service UID.
- [ ] The agent and application run with the same UID; the application mounts the directory
  read-only.
- [ ] A manifest maps secret names to output files with an optional mode and `optional` flag.
- [ ] Startup fetches every required entry; if any required entry fails, write nothing and
  exit non-zero.
- [ ] Files are written atomically: temp file in the same directory, `fsync`, `rename`,
  `chmod`; default mode `0400`.
- [ ] Refresh defaults to 300 seconds; 5xx/network errors keep last-known-good and mark
  `degraded`; 401/403 remove files and exit 1; required 404 removes files and exits 1.
- [ ] The agent exposes `GET /v1/secrets/:name` and `GET /v1/status` on a unix socket mode
  `0660`, serving only manifest entries and never calling the vault on demand.
- [ ] A status file at `/run/openvault/status.json` and `ov-agent health` report `ok`,
  `degraded`, or `failed` without values.
- [ ] The agent registers consumer metadata (Compose project, service, hostname, manifest
  hash) on join, renew, and refresh.
- [ ] Wrapper mode `ov-agent run -- <cmd>` exports only entries with `env:` and is opt-in.
- [ ] The agent stores its certificate and key in a private volume mode `0600`.
- [ ] The agent never logs values or file contents.
- [ ] `ov docker scaffold <project> <service>` creates or reuses the project and identity,
  issues a one-time join token, and emits a Compose snippet with the agent service, tmpfs
  mount, network attachment, and health gate.
- [ ] The scaffold is idempotent and does not write the join token into the Compose file.
- [ ] The application uses `depends_on: condition: service_healthy`; the agent is healthy only
  after the first successful fetch of all required entries.

### Should Have

- [ ] Optional entries may fail individually and mark `degraded`.
- [ ] A `--once` mode for debugging and CI.
- [ ] A manifest hash shown in status and consumer metadata.

### Won't Have (Out of Scope)

- One agent per Compose project or a shared agent across services.
- Docker socket access or container orchestration.
- Remote Docker hosts, Kubernetes, or a CSI driver.
- Certificate delivery to agents in v0.1 (secrets only).

## Technical Requirements

### Manifest

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
- `file` matches `^[A-Za-z0-9._-]+$`, no `..`, no absolute path.
- At least one of `file` or `env`.
- `env` is rejected in sidecar mode.
- `optional: true` failures do not fail the whole refresh.

### Failure matrix

| Result | Behavior |
|---|---|
| 200 | Atomic write, update status and `last_seen` |
| 5xx / network | Keep last-known-good, `degraded` |
| 401 / 403 | Remove files, `failed`, exit 1 |
| Required 404 | Remove files, `failed`, exit 1 |
| Optional 404 | Remove that file, `degraded` |

### Compose scaffold

The generated snippet includes:

- agent image with a pinned tag or digest;
- `OPENVAULT_URL`, `OPENVAULT_CA_FILE`, `OPENVAULT_JOIN_TOKEN`, project/service, Compose
  project name;
- `user: "10001:10001"`;
- the per-project/service tmpfs bind mount;
- the agent state volume;
- `vault_net` and the app network;
- a healthcheck calling `ov-agent health`;
- a comment instructing the operator to set the join token outside the Compose file.

### Health

- The status endpoint returns `ok` only after all required entries were written.
- `ov-agent health` exits 0 for `ok`, 1 for `degraded`, 2 for `failed`.
- The Compose healthcheck retries 3 times at 10-second intervals.

## Integration Points

- RD-05 supplies the service identity and mTLS certificate.
- RD-07 records consumer registration and refresh.
- RD-08 supplies secret values and consumer metadata.
- RD-11 exposes `ov docker scaffold` and `ov-agent`.
- RD-12 shows the consumers view.
- RD-13 backs up consumer metadata.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Agent granularity | Per project / per service | Per service | Least privilege and tmpfs isolation | AR-6 |
| Delivery | Env / files / both | Files default; wrapper env opt-in | Environment leaks | AR-6 |
| Output dir | Shared / per service | Per project/service, `0700` | Cross-project isolation | AR-6 |
| Refresh failure | Retain / remove / exit | Retain only on transient failure | Revocation must take effect | AR-27 |
| Scaffold token | Write to Compose / print once | Print once, operator supplies | No secret at rest | AR-29 |
| Remote hosts | v0.1 / v0.2 | v0.2 | Scope control | AR-30 |

## Security Considerations

- **Data sensitivity:** secret values in tmpfs; agent private key; join token.
- **Input validation:** manifest paths, file names, modes, env names, refresh interval.
- **Authentication & authorization:** mTLS only; manifest scope equals identity scope.
- **Injection risks:** no shell execution with values; `ov-agent run` execs the child without
  a shell by default.
- **Encryption needs:** TLS/mTLS; tmpfs; no plaintext on disk.
- **Rate limiting:** refresh interval and server-side data-plane limits.
- **Infrastructure:** non-root, no Docker socket, read-only app mount, no host paths in
  metadata, swap risk documented.

## Acceptance Criteria

1. [ ] A manifest with a `..`, absolute path, or unknown field fails at startup with a clear
   error.
2. [ ] Startup with one required secret unavailable exits non-zero and writes no files.
3. [ ] A successful fetch writes each required file with mode `0400`; a kill during write
   leaves no partial file.
4. [ ] A transient 5xx keeps the previous file and reports `degraded`.
5. [ ] A 401/403 removes all files and exits 1.
6. [ ] The local socket serves only manifest names; another name returns 404.
7. [ ] Consumer metadata is stored once per identity and updated on refresh.
8. [ ] A second Compose project's service cannot read the first project's tmpfs directory.
9. [ ] The scaffold is idempotent and never writes the join token into the Compose file.
10. [ ] The application does not start before the agent is healthy.
11. [ ] The agent logs contain no secret value or file content.
12. [ ] Security requirements verified: mTLS, tmpfs isolation, atomic writes, no logs, no
    Docker socket.

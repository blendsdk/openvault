# RD-10 Agent Delivery and Compose Implementation Plan

> **Feature**: Per-service agent with join/renew, manifest-driven tmpfs delivery, atomic writes, local status socket, wrapper mode, consumer heartbeats, and the Compose scaffold backend.
> **Status**: Plan Preflighted
> **Created**: 2026-11-05 09:41
> **Preflight**: [00-preflight-report.md](00-preflight-report.md) — passed after three review lenses
> **Implements**: openvault-v0-1/RD-10
> **CodeOps Artifact Schema**: 1

## Overview

RD-05 through RD-09 delivered the server side of agent identity, the mTLS listener, the
data-plane secret read, and consumer metadata. What is missing is the workload side: no
`ov-agent` process exists, no manifest is parsed, no file is delivered to a tmpfs directory,
and no scaffold workflow creates a Compose service. The existing server data route touches
`consumers.last_seen` on an agent read but has no way to record `degraded` or `failed`.

This plan adds a new `apps/agent` package. The agent loads a strict YAML manifest, joins with
a one-time token, stores its certificate and key in a `0700` state directory, fetches only its
manifest entries over mTLS, writes files atomically, refreshes on an interval, renews at two
thirds of the certificate lifetime with a fresh key, exposes a read-only unix socket and a
status file, and supports an opt-in wrapper mode. It never logs values or key material.

The server gains two narrow additions. Agent fetches may carry a validated consumer state and
an optional-entry flag so the existing read updates `consumers.last_seen` and `state`. A
`POST /v1/admin/scaffold` route creates or reuses the project and service identity, grants
object-scope `secrets.reader` only for the manifest entries, issues one join token, and returns
a hardened Compose snippet with the token kept outside the file. RD-11 owns the `ov` command
that calls this route.

RD-10 does not implement the full CLI, the web UI, certificate delivery to agents, Docker
socket access, remote hosts, Kubernetes, or backup/rotation. Those remain RD-11 through RD-13.

## Minimum-Sufficient Baseline

**Original goal:** Deliver a service's secrets into a tmpfs directory without exposing the
vault to the application network, and scaffold the Compose wiring safely.

**Smallest viable design:** One new Node package with a manifest parser, state file, HTTPS
client, delivery loop, status file, unix socket, and CLI entry; one server read-header
extension and aggregate heartbeat route; one server scaffold service, route, and pure Compose
renderer. Reuse the existing
agent listener, join/renew services, consumer table, project/identity/assignment services,
secret repository, and test patterns. Add no migration, scheduler service, sidecar framework,
queue, or Docker integration.

**Excluded machinery:** A general-purpose agent framework, a second configuration system, a
file watcher, a persistent value database, a separate heartbeat service, a Docker socket
client, a Kubernetes/CSI mode, a CLI framework in RD-10, and a published container image. See
AR-2, AR-14, AR-18, AR-19, AR-27, and AR-28.

**Approved complexity:** One new workspace package and two narrow server routes: the scaffold
route (the single authorization point for the multi-object workflow) and the value-free agent
heartbeat route (needed to record an aggregate state that a failed last fetch cannot send).
Both are recorded in AR-1, AR-18, and AR-19.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded quality audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-10 |
| 02 | [Current State](02-current-state.md) | Existing server agent subsystem and gaps |
| 03-01 | [Agent Runtime](03-01-agent-runtime.md) | Package, config, manifest, state, HTTPS client, join |
| 03-02 | [Delivery and Lifecycle](03-02-delivery.md) | Refresh, atomic writes, status, socket, renewal, wrapper, health |
| 03-03 | [Server State and Scaffold](03-03-server-state-scaffold.md) | Consumer state headers, scaffold route, Compose renderer |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Run the agent

```bash
OPENVAULT_URL=https://openvaultd:8444 \
OPENVAULT_CA_FILE=/etc/openvault/ca.pem \
OPENVAULT_JOIN_TOKEN="$OPENVAULT_JOIN_TOKEN" \
OPENVAULT_PROJECT=payments \
OPENVAULT_SERVICE=api \
COMPOSE_PROJECT_NAME=payments \
OPENVAULT_MANIFEST=/etc/openvault/manifest.yaml \
ov-agent run
```

### Manifest

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

### Local API

```http
GET /v1/secrets/db-password
-> { "name": "db-password", "value": "...", "encoding": "utf8",
     "versionId": "01J...", "deliveredAt": "..." }

GET /v1/status
-> { "state": "ok", "manifestHash": "sha256:...", "entries": [ ... ] }
```

### Scaffold backend

```http
POST /v1/admin/scaffold
{ "project": "payments", "service": "api",
  "entries": ["db-password", "stripe-api-key"] }
-> 200 {
     "project": { "id": "01J...", "name": "payments" },
     "identity": { "id": "01J...", "name": "api", ... },
     "assignments": [ { "name": "db-password",
                        "assignment": { "role": "secrets.reader", "scopeType": "object", ... } } ],
     "joinToken": { "id": "01J...", "token": "<shown once>", "expiresAt": "..." },
     "compose": "services:\n  openvault-agent-api:\n...",
     "manifest": "project: \"payments\"\n...",
     "manifestFile": "openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml"
   }
```

The token is returned once and is not present in `compose` or `manifest`.

### Health

```bash
ov-agent health   # ok -> 0, degraded -> 1, failed -> 2
```

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Package | New `apps/agent` (`@openvault/agent`, bin `ov-agent`) | AR-1 |
| RD-11 boundary | Agent binary + scaffold backend; CLI owns `ov docker scaffold` | AR-2 |
| Modes | Sidecar default, wrapper opt-in, `--once` | AR-3 |
| Configuration | `OPENVAULT_*` names matching the published snippet | AR-4 |
| Manifest | Strict YAML, 1–100 entries, project/service/output agreement | AR-5 |
| Files | Safe names, default `0400`, four allowed modes | AR-6 |
| Manifest hash | SHA-256 of raw file bytes | AR-7 |
| State | One atomic `identity.json`, one pending-renewal file | AR-8 |
| Join | One key/CSR, transient retry, terminal credential errors | AR-9 |
| Renewal | Two-thirds trigger, jitter/backoff, five-minute key reuse | AR-10 |
| Failure matrix | Exhaustive status mapping, terminal bad requests | AR-11 |
| Startup | Buffer required entries, write only when all required succeed | AR-12 |
| Status | Value-free JSON and health exit codes | AR-13 |
| Local API | `0660` unix socket, manifest entries only | AR-14 |
| Wrapper | `env:` only, UTF-8, loader denylist, no shell | AR-15 |
| Logging | Structured, value-free | AR-16 |
| HTTPS | Core Node, CA file, client cert, TLS 1.2, no redirects | AR-17 |
| Consumer state | Per-fetch headers plus a final heartbeat route; state changes audited | AR-18 |
| Scaffold | One server route, idempotent, per-service compose, object-scope only | AR-19–AR-22 |
| Schema | No migration | AR-23 |
| Tests | Real TLS/filesystem/PostgreSQL | AR-24 |
| Verification | Full repository gates plus PostgreSQL 16/17 | AR-25 |
| Dependencies | `yaml`, `@peculiar/x509`, `zod`, workspace contracts | AR-26 |
| Image | Pinned tag in the snippet; no Dockerfile in this plan | AR-27 |
| Manifest changes | Restart required; hash updates on join/renew | AR-28 |
| Shutdown | Keep files, close socket, exit 0 | AR-29 |
| Concurrency | Single-flight refresh, cancellation, serialized state writes | AR-31 |
| Wrapper trust | Same-UID child is trusted; environment sanitized; residual documented | AR-15, AR-32 |
| Specialist | None | AR-30 |

## Specialist Agents

**None** — the repository's correctness and security/concurrency lenses cover the agent,
TLS, filesystem, and Compose surface.

_Detection evidence: the server already has real CA/CSR fixtures (`apps/server/tests/integration/helpers/agent-tls.ts`), a real mTLS listener (`apps/server/src/transport/secure-application.ts`), and real PostgreSQL integration tests. RD-10 adds ordinary TypeScript over Node `https`, `fs`, and unix sockets plus one server route over existing services. No repeated agent or deployment rework exists._

## Related Files

| File | Change |
|---|---|
| `apps/agent/package.json` | New package, bin, scripts, pinned dependencies |
| `apps/agent/src/{main,config,manifest,state,status,client,join,delivery,renewal,socket,runner,logger,errors}.ts` | Agent runtime |
| `apps/agent/tests/**` | Unit and real-TLS integration tests |
| `packages/api-contract/src/scaffold.ts`, `index.ts` | Scaffold request/response contracts |
| `apps/server/src/controllers/scaffold.ts` | Admin scaffold route |
| `apps/server/src/agent/consumer-service.ts`, `controllers/agent.ts` | Heartbeat state service and route |
| `apps/server/src/scaffold/{service,compose}.ts` | Idempotent scaffold workflow and Compose/manifest rendering |
| `apps/server/src/controllers/secrets.ts` | Consumer-state headers on the agent read |
| `apps/server/src/secrets/{service,repository}.ts` | State-aware consumer heartbeat |
| `packages/api-contract/tests/scaffold.*.test.ts` | Scaffold and heartbeat contract tests |
| `apps/server/src/app.ts` | Register the scaffold service and controller |
| `apps/server/tests/integration/scaffold.*.test.ts` | Scaffold specification and implementation tests |
| `apps/server/tests/integration/secrets-consumer-state.spec.test.ts` | Consumer state coverage |
| `docs/guide/{agent,docker-compose,secrets}.md` | Implemented behavior |
| `docs/reference/{api,configuration}.md` | Scaffold route, headers, agent environment |
| `docs/architecture/agent-delivery.md` | Runtime and renewal details |
| `docs/security/limitations.md` | Accepted agent residuals |
| `docs/changelog.md`, `.changeset/agent.md` | Release note |
| `deploy/compose/agent.example.yaml` | Example scaffold output |

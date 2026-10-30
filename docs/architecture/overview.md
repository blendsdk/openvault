# Architecture overview

OpenVault is a single-node, self-hosted service built on BlendSDK v5.

## Context

```text
browser / CLI ── HTTPS ──▶ reverse proxy ── HTTPS ──▶ WebAFX server ──▶ PostgreSQL
                                                          │
                                                          └── keyring (KEK, outside the database)

app container ◀── tmpfs files ── agent ── mTLS ──▶ WebAFX server (separate listener)
```

The server owns the API, the browser session, the static React build, and the agent mTLS
endpoint. There is no separate UI server and no Redis in v0.1.

## Components

| Component | Responsibility |
|---|---|
| `apps/server` | WebAFX controllers, authentication, policy, crypto, audit |
| `apps/web` | React 19 + Fluent UI v9 UI |
| `apps/agent` | Per-service sidecar and wrapper modes |
| `apps/cli` | `ov` command |
| `packages/core` | Domain types, envelope encryption, policy primitives |
| `packages/api-contract` | Shared schemas, OpenAPI contract, generated client |
| PostgreSQL | Metadata, ciphertext, policy, audit chain |
| Keyring file | KEK, wrapped keys, outside the database |
| Reverse proxy | TLS termination, HSTS, request limits |

## Request path

1. The proxy terminates TLS.
2. WebAFX resolves the caller: browser session, CLI JWT, or agent certificate.
3. The policy service evaluates the action and resource scope.
4. The audit writer records the decision.
5. The handler reads or writes ciphertext.
6. The response is returned in the WebAFX envelope.

## Delivery path

1. An operator runs `ov docker scaffold`.
2. The agent joins with a single-use token and receives a client certificate.
3. The agent fetches its manifest's secrets over mTLS.
4. The agent writes files atomically to `/dev/shm/openvault/<project>/<service>/`.
5. The application reads the files from a read-only mount.
6. The agent registers consumer metadata and refreshes on an interval.

## Storage

PostgreSQL holds:

- projects, principals, assignments
- secret and certificate metadata and ciphertext
- wrapped data keys
- audit events, checkpoints, and wrapped audit keys
- CLI refresh sessions and consumer registrations

The keyring holds the KEK and older keys. It is never stored in PostgreSQL.

## Networks

| Network | Members | Purpose |
|---|---|---|
| `edge_net` | proxy | Public 80/443 |
| `admin_net` | proxy, server | Proxy-to-admin HTTPS only; dedicated subnet |
| `vault_net` | server, agents | Agent mTLS and internal service traffic |
| `db_net` | server, PostgreSQL | Database only |
| app networks | application, its agent | Application delivery |

The proxy is not on `vault_net`. Both listeners bind the container interfaces; the admin
source guard accepts only peers in `OPENVAULT_PROXY_CIDRS` (loopback may call only
`/health` and `/ready`), so `admin_net` placement is defense in depth. The agent mTLS
listener on `8444` accepts only client certificates from the internal CA. The application
has no route to the server or database.

## Next

- [Cryptography](/architecture/crypto)
- [Identity](/architecture/identity)
- [Agent delivery](/architecture/agent-delivery)

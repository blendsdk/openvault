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
endpoint. There is no separate UI server and no Redis in v1.0.

## Components

| Component | Responsibility |
|---|---|
| `apps/server` | WebAFX controllers, authentication, policy, crypto, audit |
| `apps/web` | React 19 + Fluent UI v9 UI |
| `apps/agent` | Per-service sidecar and wrapper modes |
| `apps/cli` | `ov` command, credential store, HTTPS adapter, generated typed client |
| `apps/server/ops` | Encrypted backup, verified restore, and KEK rewrap primitives |
| `packages/core` | Domain types, envelope encryption, policy primitives |
| `packages/api-contract` | Shared Zod schemas and the committed OpenAPI document |
| PostgreSQL | Metadata, ciphertext, policy, audit chain |
| Keyring file | KEK, wrapped keys, outside the database |
| Reverse proxy | TLS termination, HSTS, request limits |

## Web UI

`apps/web` is the minimal v1.0 browser surface: login, projects, secrets with audited reveal,
identities, permissions, audit, and consumers. It uses Fluent UI v9,
`@blendsdk/fluentui-react-components`, `blendsdk/react` for the session bridge/loader/i18n,
and the generated browser client.

The server serves the built SPA with the WebAFX static plugins and a terminal SPA fallback.
The admin listener allows `GET` paths outside `/v1` for the UI; the agent listener keeps its
strict path table. The UI-enabled CSP is same-origin except for inline style elements required
by Griffel.

Secret values exist only in component state during an explicit reveal and clear on blur,
window blur, navigation, logout, or after 60 seconds. The browser never writes values or
tokens to web storage.

## CLI and contract generation

`apps/cli` is a private ESM package with the `ov` binary. It depends on `blendsdk/cmdline` for
strict group parsers, `blendsdk/api-client` for the transport contract and bearer refresh, and
`@openvault/server/init` for the shared bootstrap primitive.

`apps/server/scripts/api-contract.ts` instantiates the real CLI-facing controllers, attaches
one documentation table, builds the OpenAPI 3.1 document, and generates the typed client:

| Artifact | Location |
|---|---|
| OpenAPI document | `packages/api-contract/openapi.json` |
| Generated client | `apps/cli/src/generated/` |
| Drift gate | `pnpm api:check`, run by `pnpm verify` |

The generated client is committed. Biome ignores it because the generator owns its formatting.
The server does not depend on the CLI, so the workspace graph stays acyclic. The real-server CLI
end-to-end test spawns the built binary from `apps/server/tests/integration/cli.spec.test.ts`.

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
`/health` and `/ready`), so `admin_net` placement is defense in depth. The agent listener on
`8444` accepts the token-authenticated `POST /v1/agent/join` without a client certificate and
requires a client certificate from the internal CA on every other agent route. The
application has no route to the server or database.

## Next

- [Cryptography](/architecture/crypto)
- [Identity](/architecture/identity)
- [Agent delivery](/architecture/agent-delivery)

# Getting started

::: warning Early development
OpenVault is under active development. The developer commands, the `ov` CLI, and the API in
this repository are implemented and tested; image publishing and the minimal web UI are still
in progress.
:::

## What OpenVault is

OpenVault stores secrets and certificates for Docker Compose projects. A **project** owns
secrets, certificates, identities, and role assignments. A **service** is one container in a
Compose project. Each service gets its own **agent**, which fetches only that service's
secrets and writes them to an isolated tmpfs directory.

The application never talks to the vault. The agent is the only bridge.

## Developer preview

Requirements: Node.js 24.7+ and pnpm 12.11.2.

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
pnpm install
pnpm verify
```

Run the API and UI:

```bash
pnpm --filter @openvault/server dev
pnpm --filter @openvault/web dev
```

The UI runs at `http://localhost:5173` and proxies `/v1` to the API. The API exposes
`GET /health` for liveness and `GET /ready` for dependency readiness.

Build and try the CLI:

```bash
pnpm --filter @openvault/cli build
export OPENVAULT_CA_FILE=/path/to/proxy-root-ca.pem
node apps/cli/dist/main.js login --url https://localhost --identifier admin@openvault.local
node apps/cli/dist/main.js whoami
```

`ov init --prepare` provisions the keyring, internal CA, server certificate, organization, and
bootstrap administrator for the reference stack. See [CLI](/guide/cli) and
[Configuration](/reference/configuration#cli-and-bootstrap).

Build the docs:

```bash
pnpm docs:dev
```

## Reference stack flow

```bash
cp .env.example .env
docker compose -f deploy/compose/compose.yaml up -d
ov login --url https://localhost --identifier admin@openvault.local
```

Then:

1. Create a project in the UI.
2. Store a secret.
3. Run `ov docker scaffold <project> <service>`.
4. Add the printed agent service to the application's Compose file.
5. Set the one-time join token in the shell and start the service.
6. The agent writes the secret file; the app reads it.

## Core concepts

| Concept | Meaning |
|---|---|
| Project | Namespace for secrets, certificates, identities, and roles |
| Service identity | A non-human principal owned by one project |
| Agent | Sidecar that fetches secrets and writes files for one service |
| Assignment | A role granted to a principal at a scope |
| Capability | A per-object boolean such as `canRead` or `canWrite` |
| Consumer | An agent registered against a service identity |

## Next

- [Install](/guide/install)
- [Docker Compose](/guide/docker-compose)
- [Agent](/guide/agent)
- [RBAC](/guide/rbac)

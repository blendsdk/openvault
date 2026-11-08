# Getting started

::: warning Release status
OpenVault 1.0 is the first stable release. **Current release: 1.0.1.** The `ov` CLI, the web
UI, and the API are included. The OpenAI Codex Security scan is a manual, periodic check. It
is not part of CI/CD and does not block a release. Pre-release images are explicitly not for
production.
:::

## What OpenVault is

OpenVault stores secrets and certificates for Docker Compose projects. A **project** owns
secrets, certificates, identities, and role assignments. A **service** is one container in a
Compose project. Each service gets its own **agent**, which fetches only that service's
secrets and writes them to an isolated tmpfs directory.

The application never talks to the vault. The agent is the only bridge.

## Quickstart

The 1.0.1 images are published to Docker Hub under `blendsdk`:

| Image | Purpose |
|---|---|
| `blendsdk/openvault` | Server and `ov` CLI |
| `blendsdk/openvault-web` | Web UI |
| `blendsdk/openvault-agent` | Per-service agent |

Requirements: Docker with Compose v2.24 or newer.

From the repository root:

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time bootstrap password, sign in at `https://localhost` as
`admin@openvault.local`, and create a project and secret. The
[Docker Compose guide](/guide/docker-compose#bootstrap-password) has the exact
password-copy command.

To deliver a secret to an application as an environment variable, use the
[ready-to-run example](https://github.com/blendsdk/openvault/tree/main/examples/compose-env)
and [Environment variables](/guide/environment-variables).

## Run from source

Requirements: Node.js 24.7+ and pnpm 12.18.0.

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

The UI runs at `http://localhost:5173` and proxies `/v1` to `https://localhost:8443`. The proxy
rewrites the browser origin so the server's origin guard and CSRF checks behave as in
production. The API exposes `GET /health` for liveness and `GET /ready` for dependency
readiness. See [Web UI](/guide/web-ui).

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

## Full-stack review

The fastest way to see the full product is the disposable review stack. It builds local images,
seeds synthetic data, and exposes only `https://localhost:8443`:

```bash
./deploy/compose/review.sh up
./deploy/compose/review.sh password
```

See [Review the app](/guide/review) for the walkthrough, demo data, and cleanup.

## Reference stack flow

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Then read the bootstrap password through the init container, sign in, and delete the copy. See
[Docker Compose](/guide/docker-compose#bootstrap-password). Then:

1. Create a project in the UI at `https://localhost`.
2. Store a secret and reveal it once to confirm the audited read.
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

- [Tutorials](/tutorials/)
- [Install](/guide/install)
- [Docker Compose](/guide/docker-compose)
- [Agent](/guide/agent)
- [RBAC](/guide/rbac)

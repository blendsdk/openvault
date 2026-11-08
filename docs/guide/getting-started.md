# Getting started

## What OpenVault is

OpenVault stores secrets and certificates for Docker Compose projects. A **project** owns
secrets, certificates, identities, and role assignments. A **service** is one container in a
Compose project. Each service gets its own **agent**, which fetches only that service's
secrets and writes them to an isolated private directory.

The application never talks to the vault. The agent is the only bridge.

## Quickstart

The current release is **1.1.0**. The images are published to Docker Hub under `blendsdk`:

| Image | Purpose |
|---|---|
| `blendsdk/openvault` | Server and `ov` CLI |
| `blendsdk/openvault-web` | Web UI |
| `blendsdk/openvault-agent` | Per-service agent |

Requirements: Docker with Compose v2.24 or newer.

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time bootstrap password, sign in at `https://localhost` as
`admin@openvault.local`, and change the password. The
[Docker Compose guide](/guide/docker-compose#bootstrap-password) has the exact
password-copy command.

## First steps

1. Create a project in the UI.
2. Store a secret and reveal it once to confirm the audited read.
3. Deliver a secret to a service with an agent. See
   [Deliver a secret to a Compose service](/tutorials/compose-agent).
4. To load a secret as an environment variable, use the
   [environment-variable example](https://github.com/blendsdk/openvault/tree/main/examples/compose-env)
   and [Environment variables](/guide/environment-variables).

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
- [Tutorials](/tutorials/)

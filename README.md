# OpenVault

[![CI](https://github.com/blendsdk/openvault/actions/workflows/ci.yml/badge.svg)](https://github.com/blendsdk/openvault/actions/workflows/ci.yml)
[![Docs](https://github.com/blendsdk/openvault/actions/workflows/docs.yml/badge.svg)](https://blendsdk.github.io/openvault/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0.1%20development-orange.svg)](#status)

Self-hosted secrets and certificates for Docker Compose projects, built on BlendSDK v5.

OpenVault versions every value, grants narrow access, delivers secrets through a per-service
agent, and records every read in a tamper-evident audit log. It is Azure Key Vault-inspired,
but designed for a small team running Docker Compose on one host.

## Status

OpenVault is in early development. The current repository contains:

- the pnpm/TypeScript 7 workspace and Biome toolchain
- the envelope-encryption core with tests
- a WebAFX server skeleton with a readiness endpoint
- a React 19 + Fluent UI v9 web shell
- the VitePress documentation site and GitHub Actions workflows

Secrets, certificates, RBAC, the agent, and the full UI are being implemented. The target
v0.1 behavior is described in the [documentation](https://blendsdk.github.io/openvault/).

## Why OpenVault?

Docker secrets are built for Swarm, not Compose. Teams end up with `.env` files, shared
volumes, or copy-pasted values. OpenVault gives a Compose project a real secret store:

- versioned secrets and certificates
- project and object scopes with deny-by-default RBAC
- one agent per service, writing to an isolated tmpfs directory
- no vault route from the application network
- audit of every read, denial, and permission change
- a web UI and a CLI for operators

## Architecture

```text
browser / CLI ── HTTPS ──▶ reverse proxy ──▶ WebAFX server ──▶ PostgreSQL
                                                   │
                                                   └── keyring (KEK, outside the database)

app container ◀── tmpfs files ── agent ── mTLS ──▶ WebAFX server
```

The application never talks to the vault. The agent is the only bridge, and each Compose
service gets its own agent and its own tmpfs directory.

## Developer preview

Requirements: Node.js 22.23+, pnpm 12.11.2.

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
pnpm install
pnpm verify
```

Run the API and UI locally:

```bash
pnpm --filter @openvault/server dev
pnpm --filter @openvault/web dev
```

The UI dev server runs on `http://localhost:5173` and proxies `/v1` to the API on port
8443. The API currently exposes `GET /v1/ready` and the WebAFX `GET /health` endpoint.

Build the documentation:

```bash
pnpm docs:dev
pnpm docs:build
```

## Target Compose quick start

The following is the v0.1 target, not yet available:

```bash
cp .env.example .env
docker compose -f deploy/compose/compose.yaml up -d
ov init
ov login
```

Then open `https://localhost`, create a project, and deliver a secret to a service:

```bash
ov docker scaffold payments api
```

The scaffold prints a single-use join token and a Compose snippet. The agent exchanges the
token for a certificate and writes `/run/secrets/db_password`; the application reads the
file and has no route to the vault.

## Repository layout

```text
apps/
  server/      WebAFX API and UI hosting
  web/         React 19 + Fluent UI v9
packages/
  core/        domain and envelope encryption
docs/          VitePress documentation
deploy/        Compose stack and examples (growing)
.github/       CI, docs, security, and release workflows
```

## Security

- AES-256-GCM envelope encryption with a KEK outside the database
- Argon2id passwords, HttpOnly BFF sessions, CSRF protection
- Short-lived mTLS certificates and immediate revocation
- Hash-chained, HMAC-protected audit log
- No SSH for workloads

The threat model and known limitations are in the documentation. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

## Documentation

Full guides and reference: <https://blendsdk.github.io/openvault/>

## Roadmap

- **v0.1**: secrets, certificates, RBAC, audit, agent, CLI, minimal UI, Compose
- **v0.2**: certificate UI, rotation workflow, Redis sessions, remote Docker hosts
- **v0.3**: Kubernetes identity, external KMS/HSM, ACME, high availability

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security issues must
follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

Apache-2.0. See [LICENSE](LICENSE).

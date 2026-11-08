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

The v0.1 feature set is implemented and tested: secrets, certificates, RBAC, audit, the
agent, the CLI, the web UI, encrypted backup/restore, KEK rotation, the hardened reference
Compose stack, and the release-assurance pipeline. The remaining production gate is an
independent external security review; alpha images are explicitly labelled not for
production. See the [security evidence matrix](docs/security/evidence-matrix.md) and the
[release process](docs/security/release-process.md).

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

Requirements: Node.js 24.7+, pnpm 12.18.0.

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
8443. The API exposes `GET /health` for liveness and `GET /ready` for dependency readiness.

Build the documentation:

```bash
pnpm docs:dev
pnpm docs:build
```

## Review the app locally

The review script builds the current checkout, starts the full stack on loopback, and seeds
synthetic projects, secrets, certificates, identities, grants, and audit events:

```bash
./deploy/compose/review.sh up
./deploy/compose/review.sh password
```

Open `https://localhost:8443` and sign in as `admin@openvault.local`. See
[Review the app](docs/guide/review.md) for the walkthrough, browser security checks, and
cleanup.

## Compose quick start

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time password through the init container, remove the copy, then open
`https://localhost`, create a project, and deliver a secret to a service:

```bash
install -m 0600 /dev/null /tmp/openvault-bootstrap
docker compose -f deploy/compose/compose.yaml cp \
  openvault-init:/bootstrap/bootstrap-password /tmp/openvault-bootstrap
cat /tmp/openvault-bootstrap
rm -f /tmp/openvault-bootstrap
```

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

The threat model, evidence matrix, security claims, and known limitations are in the
documentation. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

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

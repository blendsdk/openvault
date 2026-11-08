# OpenVault

[![CI](https://github.com/blendsdk/openvault/actions/workflows/ci.yml/badge.svg)](https://github.com/blendsdk/openvault/actions/workflows/ci.yml)
[![Docs](https://github.com/blendsdk/openvault/actions/workflows/docs.yml/badge.svg)](https://blendsdk.github.io/openvault/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-v1.0%20release-brightgreen.svg)](#status)

Self-hosted secrets and certificates for Docker Compose projects.

OpenVault versions every value, grants narrow access, delivers secrets through a per-service
agent, and records every read in a tamper-evident audit log. It is designed for a small team
running Docker Compose on one host.

## Status

OpenVault 1.0 is the first stable release.
**Current release: [1.0.1](https://github.com/blendsdk/openvault/releases/tag/v1.0.1).**

## Quickstart

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time bootstrap password, sign in at `https://localhost`, and create a project and
secret. To load a secret into an application as an environment variable, use the
[ready-to-run example](examples/compose-env/README.md).

## Why OpenVault?

Docker secrets are built for Swarm, not Compose. Teams end up with `.env` files, shared
volumes, or copy-pasted values. OpenVault gives a Compose project a real secret store:

- versioned secrets and certificates
- project and object scopes with deny-by-default access control
- one agent per service, writing to an isolated temporary filesystem
- no vault route from the application network
- audit of every read, denial, and permission change
- a web UI and a CLI for operators

## How it works

```text
browser / CLI ── HTTPS ──▶ reverse proxy ── HTTPS ──▶ vault server ──▶ database
                                                          │
                                                          └── keyring (outside the database)

app container ◀── files ── agent ── mutual TLS ──▶ vault server
```

The application never talks to the vault. The agent is the only bridge, and each Compose
service gets its own agent and its own private directory.

## Security

- secrets and certificates are encrypted at rest with keys kept outside the database
- access is deny-by-default at organization, project, and object scope
- agents use short-lived certificates, and every read is audited
- the agent is the only route from an application to the vault

See the [security overview](https://blendsdk.github.io/openvault/security/) and
[known limitations](https://blendsdk.github.io/openvault/security/known-limitations).

## Documentation

Full guides, tutorials, and reference: <https://blendsdk.github.io/openvault/>

Start with [Your first secret](docs/tutorials/first-secret.md) or
[Deliver a secret to a Compose service](docs/tutorials/compose-agent.md).

## Roadmap

- **v1.x**: certificate UI, rotation workflow, remote Docker hosts
- **Next**: Kubernetes identity, external key services, ACME, high availability

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security issues must
follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

Apache-2.0. See [LICENSE](LICENSE).

# Changelog

## 1.0.1 — 2026-11-08

### Fixed

- The agent now joins a 1.0.0 or later server correctly.
- Scaffolded agent services start with the correct command.
- The agent health check allows enough time for a small host to start.
- The environment-variable example, its loader, and its documentation.
- Current-release labels in the documentation.

## 1.0.0 — 2026-11-08

The first stable release. The `/v1` API and the v1 data format are stable; breaking changes
require a new major version. See [Versioning and compatibility](/guide/versioning).

### Included

- Versioned secrets and certificates with encrypted storage and a keyring outside the database.
- Deny-by-default access control at organization, project, and object scope.
- Per-service agents that deliver only the secrets and certificates for that service.
- A tamper-evident audit log with verification, export, and checkpoints.
- A web UI and a CLI for projects, secrets, identities, permissions, and audit.
- Encrypted backup and verified restore, plus key-encryption-key rotation.
- A hardened reference Compose stack with a single public entry point.
- Multi-architecture release images published to Docker Hub.

### Deferred

- Certificate screens in the web UI.
- Automated browser checks across multiple engines.

# Current State: RD-13 Operations

> **Snapshot**: `main` at `cae3197`, 2026-11-06

## What Exists

| Area | State |
|---|---|
| Backup | `ov backup` writes an age passphrase archive with manifest SHA-256 checksums. It rejects keyring/CA targets, checks the CA row, checks every referenced KEK, and audits completion. |
| Restore | `ov restore` verifies the archive and keyring, refuses a non-empty target without `--force`, migrates, restores in one transaction, stages and publishes keyring/CA, verifies the audit chain, decrypts one secret per project, and signs a CA probe. |
| KEK rotation | `ov kek rotate` adds the new KEK first, rewraps DEKs, audit keys, CA key, and JWT seed in one transaction, verifies no old references, then removes old keys. |
| Init | `ov init` creates the keyring, CA, server TLS pair, organization, bootstrap administrator, and signing key. Re-runs reuse existing material. |
| Rotation | Secret writes create immutable versions; agents refresh. Workload certificates renew at two thirds of lifetime. Sessions rotate on refresh. |
| Logging | Pino JSON with request ids and broad redaction, including OIDC callback query strings. |
| Readiness | `/health` and `/ready` exist with database, keyring, and CA probes. |
| Migrations | Run automatically at server startup from `OPENVAULT_DB_URL`. |
| Compose | Three services (`proxy`, `openvault-init`, `openvaultd`, plus `postgres`), internal networks, healthchecks, CA volume. |
| Images | No Dockerfile. Compose references `ghcr.io/blendsdk/openvault:0.1.0` and `ghcr.io/blendsdk/openvault-agent:0.1.0`, neither published. |

## Gaps Closed by This Plan

1. No hardened reference stack or Dockerfiles.
2. No least-privilege role provisioning.
3. No separate migration role at server startup.
4. No file-backed database URL support.
5. No agent-certificate check in restore.
6. No host-level doctor checks for database, keyring, or backup age.
7. No CLI checkpoint export.
8. No scheduled off-box checkpoint guidance.
9. No scripted Compose hardening check.
10. Stale deployment and threat-model documentation.

## Constraints

- The logical backup format is stable; do not break existing archives.
- Integration tests share a PostgreSQL database; role tests use transactions and dedicated
  probe objects so they do not mutate application data.
- Compose base-image digests must be real. They are resolved with `docker buildx imagetools
  inspect` during execution, not invented.
- First-party image digests do not exist until RD-14 publishes an image. The Compose file uses
  an explicit image variable and the documentation requires a digest for production.

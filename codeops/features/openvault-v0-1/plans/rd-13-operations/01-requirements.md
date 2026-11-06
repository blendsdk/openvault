# RD-13 Requirements Delta

This plan implements the RD-13 Must Haves and the two Should Haves that can be delivered
without new infrastructure. The full requirement remains
[RD-13-backup-rotation-ops.md](../../requirements/RD-13-backup-rotation-ops.md).

## Already Delivered by RD-11

| Requirement | Evidence |
|---|---|
| Encrypted backup with manifest, database dump, keyring, config, CA, checkpoints | `apps/server/src/ops/backup.ts`, `apps/server/src/ops/archive.ts`, `apps/server/tests/integration/ops.spec.test.ts:197-233` |
| Restore verifies checksums, migrates, publishes keyring/CA, verifies audit chain and secrets | `apps/server/src/ops/restore.ts`, `apps/server/tests/integration/ops.spec.test.ts:234-261` |
| KEK rotation rewraps DEKs, audit key, CA key, JWT seed; ciphertext unchanged | `apps/server/src/ops/kek.ts`, `apps/server/tests/integration/ops.spec.test.ts:339-465` |
| Secret rotation through immutable versions | `apps/server/src/secrets/service.ts`, `apps/server/tests/integration/secrets-lifecycle.spec.test.ts` |
| Certificate renewal and 30/14/7-day warnings | `apps/server/src/certificates/expiry/service.ts:41-50`, `apps/server/tests/integration/certificates-expiry.spec.test.ts` |
| Browser and CLI session rotation | `apps/server/src/auth/sessions.ts`, `apps/server/src/controllers/auth.ts:219-280` |
| Init creates the CA once and stores the wrapped key | `apps/server/src/init/index.ts`, `apps/server/tests/integration/init.spec.test.ts` |
| Bootstrap password is a one-time 0600 file | `apps/server/src/init/index.ts:493-540`, `apps/server/tests/integration/init.spec.test.ts` |
| Structured JSON logs with redaction and request ids | `apps/server/src/observability/logger.ts`, `apps/server/tests/logging.spec.test.ts` |

## Delivered by This Plan

| Requirement | Planned change |
|---|---|
| Restore verifies a pre-backup agent certificate | Optional `--agent-certificate` file, chain/profile check, drill test |
| Reference stack runs server, PostgreSQL, proxy, and UI | Four-service Compose file with a static `web` container |
| Server not published; only proxy exposes 443 | Remove published port 80; only `proxy` has `ports` |
| `vault_net` and `db_net` internal | `internal: true`; agent is the only workload that joins `vault_net` and an app network |
| Container hardening | Non-root users, read-only roots, `cap_drop: ALL`, `no-new-privileges`, tmpfs, resource limits |
| PostgreSQL persistent volume and healthcheck | Existing volume and healthcheck retained |
| Least-privilege roles | `deploy/postgres/roles.sql` plus `init-roles.sh`; server uses `openvault_app`; migrations use `openvault_migrator` |
| DB password from a file or Docker secret | `OPENVAULT_DB_URL_FILE`, `POSTGRES_PASSWORD_FILE`, Compose secrets |
| Scheduled off-box checkpoint export | `ov audit checkpoint --out`, systemd units, cron documentation |
| Backup age in `ov doctor` | `--backup-dir` / `OPENVAULT_BACKUP_DIR`, 24-hour RPO check |
| Images pinned by digest | Third-party base images pinned in Dockerfiles and Compose; first-party images pinned by release digest in RD-14 |
| RPO 24 hours / RTO 1 hour documented | Backup/restore and operations guides |
| Break-glass recovery documented | New operations guide section |
| Log rotation limits | Compose `logging.options.max-size` and `max-file` |

## Explicitly Deferred

- Recipient-key age encryption (passphrase encryption satisfies the requirement).
- A database migration that stores every agent certificate PEM.
- A built-in scheduler or backup daemon.
- High availability, multi-region, Kubernetes, external KMS/HSM, and ACME.

# Operations

This page is the day-two runbook for the reference Compose stack. It assumes the
host directories and Docker secrets were prepared with
`deploy/compose/prepare.sh`.

## Targets

| Target | Value | Evidence |
|---|---|---|
| Recovery point objective (RPO) | 24 hours | Daily encrypted backup timer; `ov doctor --backup-dir` fails on an older archive |
| Recovery time objective (RTO) | 1 hour | Restore drill against a fresh database |
| Audit retention | 180 days by default | `OPENVAULT_AUDIT_RETENTION_DAYS` |
| Soft-delete retention | 30 days by default | `OPENVAULT_SOFT_DELETE_DAYS` |
| Session lifetime | 8 hours by default | `OPENVAULT_SESSION_TTL_HOURS` |

The single-node v0.1 stack has no high availability. A host loss is recovered
from the encrypted backup and the keyring, not from a replica.

## First start

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://vault.example.com
docker compose -f deploy/compose/compose.yaml up -d
```

`prepare.sh` creates the host directories and Docker secrets. It never
overwrites an existing secret file. The first start runs
`openvault-init` (keyring, CA, server TLS, organization, bootstrap admin) and
then `openvault-roles` (runtime, purge, and prune grants).

Read the one-time bootstrap password, sign in, change it, and remove the file:

```bash
install -m 0600 /dev/null /tmp/bootstrap-copy
docker compose -f deploy/compose/compose.yaml cp \
  openvault-init:/bootstrap/bootstrap-password /tmp/bootstrap-copy
# Sign in through the UI, then:
rm -f /tmp/bootstrap-copy
```

The password is never printed to container logs. If the file is lost before the
first login, remove the data directory and start again with an empty database;
there is no recovery path for a never-used bootstrap password.

## Database roles

| Role | Owns | Use |
|---|---|---|
| `openvault_migrator` | Database, schema, tables | Migrations and restore only |
| `openvault_app` | Nothing | The server's runtime connection |
| `openvault_auth` | Nothing | Control-plane authentication, RBAC, and agent identity |
| `openvault_backup` | Nothing | Read-only logical backup dump |
| `openvault_purger` | Nothing | Controlled secret and certificate purge |
| `openvault_pruner` | Nothing | Controlled audit prefix prune |

The server runs startup migrations with `OPENVAULT_MIGRATION_DB_URL` and then
serves traffic as `OPENVAULT_DB_URL`. The app role cannot run DDL and cannot
delete audit events. The `deploy/postgres/grants.sql` file asserts that the
migrator owns every application table.

The role passwords are separate Docker secrets. The full URLs are also secrets;
the server reads them through `OPENVAULT_DB_URL_FILE`,
`OPENVAULT_MIGRATION_DB_URL_FILE`, `OPENVAULT_AUTH_DB_URL_FILE`, and
`OPENVAULT_PURGE_DB_URL_FILE`. The host backup job reads
`OPENVAULT_BACKUP_DB_URL_FILE` for the dump and `OPENVAULT_DB_URL_FILE` for the
audit event.

## Health and diagnosis

```bash
ov doctor \
  --url https://vault.example.com \
  --backup-dir /var/backups/openvault
```

The doctor checks the API readiness, TLS trust, CLI credentials, clock skew, the
database, the keyring, and the newest backup age. A check that is not configured
is reported as skipped, not failed. A configured check that fails exits 1.

The server also exposes:

- `GET /health` — process liveness.
- `GET /ready` — database, keyring, CA signing key, and migration state.

Only the proxy reaches the admin listener. The agent listener uses mTLS and is
never published.

## Backups

The encrypted archive contains the database rows, the keyring, the redacted
configuration, the public internal CA, and the audit checkpoints. The keyring
and the archive passphrase are stored separately.

```bash
ov backup --out /var/backups/openvault/openvault-$(date -u +%Y%m%dT%H%M%SZ).age
ov audit checkpoint --out /var/backups/openvault/checkpoint-$(date -u +%Y%m%dT%H%M%SZ).json
```

Install the systemd timers in `deploy/systemd/` to run both daily and copy them
off-box. The timers are persistent across a reboot; cron equivalents are in the
same directory.

A backup is not usable until it has been restored. Run the drill in
[Backup and restore](/guide/backup-restore) after every schema or release change.

## Restore drill

The drill covers the RD-13 acceptance criteria:

1. Create a project with one secret and one certificate.
2. Join a test agent and save its client certificate PEM.
3. Take an encrypted backup.
4. Destroy the target database and keyring.
5. Restore into an empty database with the saved agent certificate.
6. Verify the audit chain, one secret per project, the CA probe, and the agent
   certificate.
7. Record the elapsed time; it must remain under the one-hour RTO.

The automated version is `apps/server/tests/integration/ops.spec.test.ts`;
the operator version is the sequence above. Both exercise the same restore
function.

## KEK rotation

Stop the server first. A running process holds the old keyring in memory and can
write a row with the old `kek_id` after the CLI verifies the rotation.

```bash
ov kek rotate --dry-run
ov kek rotate --yes
```

Values are never re-encrypted. The command rewraps every DEK, the audit key, the
CA key, and the JWT signing seed, verifies that no old reference remains, and
then removes the old key. Keep the pre-rotation keyring with any backup taken
before the rotation; an old archive needs the old keyring.

## Value and certificate rotation

```bash
ov secret set db-password --project payments --stdin
ov cert generate api --project payments --dns api.example.com
```

Each write creates a new immutable version. Agents refresh on their configured
interval. Certificate expiry warnings fire once at 30, 14, and 7 days through the
configured webhook and the audit log.

## Logs

The server writes structured JSON to stdout with request ids and broad
redaction. Compose rotates the log file at 10 MiB with three files per service.
Do not add a file transport that writes secret-bearing fields; the redaction
contract covers the pino paths, not arbitrary file writes.

## Maintenance windows

Use a maintenance window for:

- KEK rotation.
- Restore.
- CA replacement.
- A PostgreSQL major-version upgrade.

Stop the server before a restore or KEK rotation. Migrations are idempotent and
run at startup, so a normal release does not need a separate migration step.

## Break-glass

1. Take the keyring, the encrypted backup, and the passphrase from separate
   custody locations.
2. Provision a fresh host and PostgreSQL volume.
3. Restore as described in the incident runbook.
4. Rotate every credential and value before returning the service to users.

There is no always-on second administrator and no bypass account. The keyring
and the backup are the recovery authority.

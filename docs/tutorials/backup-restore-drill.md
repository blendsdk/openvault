# Backup, restore, and KEK rotation drill

This tutorial walks through the recovery drill on a disposable host. Do not run it against a
production deployment; it deliberately destroys the target database, keyring, and TLS material.

The goal is to prove three things:

1. The encrypted archive restores into an empty target.
2. The restored data still decrypts and the audit chain verifies.
3. KEK rotation re-wraps every key table without re-encrypting values.

## 1. Prepare the disposable stack

Install the reference stack and create one project with a secret and a certificate. Join a test
agent and save its client certificate PEM; the restore check can use it later.

```bash
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
./deploy/compose/prepare.sh
docker compose -f deploy/compose/compose.yaml up -d
```

Create the data through the UI or CLI, then save a copy of the current agent certificate:

```bash
ov cert get payments-api --project payments --private-key --out /tmp/payments-api.pem
```

The exact project and certificate names are yours; use the values from your drill.

## 2. Set the backup environment

The backup needs a read-only dump role, the runtime database URL for the audit event, the
keyring, the public CA, and a passphrase file. The passphrase file must be mode `0600` and at
least 12 characters.

```bash
export OPENVAULT_DB_URL='postgres://openvault_app:...@postgres:5432/openvault'
export OPENVAULT_BACKUP_DB_URL='postgres://openvault_backup:...@postgres:5432/openvault'
export OPENVAULT_KEYRING=/var/lib/openvault/keyring.json
export OPENVAULT_INTERNAL_CA=/etc/openvault/tls/ca.pem
export OPENVAULT_BACKUP_PASSPHRASE_FILE=/etc/openvault/backup.passphrase
```

Use file-backed `*_DB_URL_FILE` variables in the real deployment. Never put a database password
on a command line.

## 3. Take the backup and a checkpoint

```bash
ov backup --out "/var/backups/openvault/openvault-$(date -u +%Y%m%dT%H%M%SZ).age"
ov audit checkpoint --out "/var/backups/openvault/checkpoint-$(date -u +%Y%m%dT%H%M%SZ).json"
```

Record the archive name and checksum. The command prints the verified row counts and the audit
chain result. Copy the archive, checkpoint, and the current keyring to separate evidence
locations; the keyring is needed to read the archive.

## 4. Destroy the target

Stop the server first. The restore command refuses a running application because an in-memory
keyring could write a row after the restore verifies the database.

```bash
docker compose -f deploy/compose/compose.yaml stop openvaultd
```

Move the target database, keyring, and TLS material aside. Keep a copy of the destroyed state
so you can compare it with the restored state:

```bash
pg_dump "$OPENVAULT_DB_URL" > /tmp/pre-drill.sql
mv /var/lib/openvault/keyring.json /tmp/keyring.pre-drill.json
```

Drop and recreate an empty database owned by the migrator role. The restore target must be empty
unless you pass `--force`.

## 5. Restore

```bash
export OPENVAULT_RESTORE_DB_URL='postgres://openvault_migrator:...@postgres:5432/openvault'
ov restore "/var/backups/openvault/openvault-<timestamp>.age" \
  --agent-certificate /tmp/payments-api.pem \
  --ca-public-dir /etc/openvault/ca \
  --yes
```

Expected result lines:

```text
audit chain: ok
secrets verified: <count>
certificate private keys verified: <count>
JWT signing key: verified
CA key: verified
pre-backup agent certificate: verified
```

If the restored CA differs from the CA that signed the current server certificate, re-provision
the server TLS pair before starting the server. The server fails closed when the certificate does
not chain to the restored CA.

## 6. Start the server and verify

```bash
docker compose -f deploy/compose/compose.yaml up -d
ov secret get <name> --project <project>
ov audit verify
ov doctor --backup-dir /var/backups/openvault
```

The secret value must match the pre-drill value, the audit chain must verify, and `ov doctor`
must report that the newest backup is within the 24-hour RPO. Record the elapsed time; the
target RTO is one hour.

## 7. Rotate the KEK

Stop the server again. Copy the current keyring to the evidence store before rotating; an older
backup needs the keyring that existed when it was taken.

```bash
docker compose -f deploy/compose/compose.yaml stop openvaultd
ov kek rotate --dry-run
ov kek rotate --yes
docker compose -f deploy/compose/compose.yaml up -d
```

Rotation generates a new KEK and re-wraps every secret and certificate data key, the audit HMAC
key, the `ca_keys` CA key, and the JWT signing seed. Values are never re-encrypted. The old key
is removed only after every key table reports that no row references it.

Verify after rotation:

```bash
ov secret get <name> --project <project>
ov audit verify
```

## 8. Repeat the drill after changes

Run the drill after every schema change, release upgrade, or key-custody change. The automated
equivalent is `apps/server/tests/integration/ops.spec.test.ts`, which covers a tampered archive,
a wrong passphrase, a checksum mismatch, a non-empty target, an invalid agent certificate, and a
successful restore with the saved certificate.

## Clean up

Destroy the disposable host or reset the review environment. Keep the drill evidence, archive,
checkpoint, and passphrase in separate custody locations.

## Next

- [Backup and restore](/guide/backup-restore)
- [Rotation](/guide/rotation)
- [Operations](/guide/operations)
- [Incident response](/security/incident-response)

# Backup and restore

## What must be backed up

| Item | Why |
|---|---|
| Database logical dump | Objects, ciphertext, policy, audit chain |
| Keyring file | The KEK and older keys needed to decrypt |
| Configuration snapshot | OIDC issuer, URLs, limits |
| Public internal CA certificate | Agent mTLS trust anchor; the wrapped private key is in the database dump |
| Audit checkpoints | Off-box integrity anchor |

The database without the keyring is unreadable. The keyring without the database is
useless. Back them up together, encrypted. The archive passphrase is a second factor
and must be stored separately.

## Targets

| Target | Value |
|---|---|
| RPO | 24 hours |
| RTO | 1 hour |
| Archive retention | At least the audit retention window (180 days by default) |

An untested backup is not a backup. Run the drill after every schema or release
change, and keep the newest checkpoint off-box.

## Backup

```bash
ov backup --out /var/backups/openvault/openvault-$(date -u +%Y%m%dT%H%M%SZ).backup
ov audit checkpoint --out /var/backups/openvault/checkpoint-$(date -u +%Y%m%dT%H%M%SZ).json
```

The archive contains a logical database dump, the keyring, the redacted configuration
manifest, the public internal CA certificate, and the audit checkpoints. It is encrypted with
using a passphrase from a `0600` file or a hidden prompt. Recipient-key encryption is not
implemented in v1.0.

`OPENVAULT_BACKUP_DB_URL_FILE` selects the read-only `openvault_backup` dump connection;
`OPENVAULT_DB_URL_FILE` is used only for the `backup.create` audit event. Point both at
Docker secrets instead of putting the URLs in the process environment. The backup command
refuses the app/auth role or a connection that cannot read the control-plane tables.
`ov doctor --backup-dir` fails when the newest `.backup` archive is older than 24 hours.

### Schedule

Install the units in `deploy/systemd/`:

```bash
sudo cp deploy/systemd/openvault-*.service deploy/systemd/openvault-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openvault-backup.timer openvault-checkpoint.timer
```

Set `OPENVAULT_OFFBOX_TARGET` in `/etc/openvault/backup.env` so each unit copies the
archive or checkpoint to an independent host. The cron equivalents are in
`deploy/systemd/README.md`.

## Restore

Stop the server before restore. Start the database with an empty target, or use `--force` to
replace a non-empty one. Set `OPENVAULT_RESTORE_DB_URL` to an owner/migrator role that owns the
tables.

```bash
ov restore /var/backups/openvault/openvault-2026-11-06T02-00-00Z.backup \
  --agent-certificate /var/backups/openvault/pre-backup-agent.pem \
  --yes
```

The command verifies the archive checksums and the archived keyring before touching the
target, runs migrations, restores every row, and publishes the restored keyring and public CA.
Set `OPENVAULT_CA_PUBLIC_DIR` or pass `--ca-public-dir` to also publish the proxy's `ca.pem`.
It then verifies the audit chain, decrypts every current secret and certificate private key,
signs and verifies a session-token probe, signs a probe certificate with the restored CA key, and
verifies the supplied pre-backup agent certificate against the restored CA.

The agent certificate is optional. The schema does not store agent leaf PEMs, so the drill
saves a live certificate before the backup and passes it to restore. Without the flag, the CA
probe still verifies the signing key; the result reports the agent check as `not supplied`.

If the restored CA differs from the CA that signed the current server certificate, re-provision
the server TLS pair after restore. The server fails closed on a certificate that does not chain
to the restored CA.

## Drill

Run this on a disposable host or database. It exercises every restore criterion:

1. Create a project with one secret and one certificate.
2. Join a test agent and save its client certificate PEM.
3. Take an encrypted backup and export the newest checkpoint.
4. Destroy the target database, keyring, and TLS material. Keep a copy of the old data for
   comparison.
5. Restore into an empty database with `--agent-certificate`.
6. Confirm the output reports `audit chain: ok`, the expected `secrets verified` and
   `certificate private keys verified` counts, `Session signing key: verified`, `CA key: verified`,
   and `pre-backup agent certificate: verified`.
7. Sign in, read one secret per project, and run `ov audit verify`.
8. Record the elapsed time; it must stay under the one-hour RTO.

The automated test suite covers a tampered archive, a wrong passphrase, a checksum mismatch,
a non-empty target, a non-superuser owner role, an invalid agent certificate, and a successful
restore with the saved certificate.

## Break-glass

Keep these in separate custody locations:

- The keyring file.
- The encrypted archive.
- The backup passphrase.
- The last off-box checkpoint.

There is no always-on second administrator. The offline restore is the recovery path. After a
restore, rotate every credential and value before returning the service to users.

## Next

- [Rotation](/guide/rotation)
- [Operations](/guide/operations)
- [Incident response](/security/incident-response)

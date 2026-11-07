# Scheduled backup and checkpoint units

The timers run on the Docker host, not inside the vault container. They use the
`ov` CLI installed on the host and the same database/keyring paths as the
deployed stack.

## Install

```bash
sudo install -d -m 0755 /etc/openvault
sudo install -d -m 0700 -o openvault -g openvault /var/backups/openvault
sudo install -m 0600 -o openvault -g openvault /dev/null /etc/openvault/backup.env
sudo install -m 0644 deploy/systemd/openvault-*.service deploy/systemd/openvault-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openvault-backup.timer openvault-checkpoint.timer
```

`/etc/openvault/backup.env` must contain the operator environment. It is read by
both units:

```ini
OPENVAULT_DB_URL_FILE=/etc/openvault/db_app_url
OPENVAULT_BACKUP_DB_URL_FILE=/etc/openvault/db_backup_url
OPENVAULT_KEYRING=/var/lib/openvault/keyring.json
OPENVAULT_INTERNAL_CA=/etc/openvault/tls/ca.pem
OPENVAULT_BACKUP_PASSPHRASE_FILE=/etc/openvault/backup-passphrase
# Optional rsync destination, for example an SSH host or mounted NAS.
# OPENVAULT_OFFBOX_TARGET=/mnt/offbox/openvault
```

`OPENVAULT_DB_URL_FILE`, `OPENVAULT_BACKUP_DB_URL_FILE`, and
`OPENVAULT_BACKUP_PASSPHRASE_FILE` must be `0600` and owned by the `openvault` unit user. The passphrase must be stored separately from
the backup archive. The off-box
target is the only copy that can prove the audit chain after a host loss.

## Cron equivalent

```cron
0 2 * * * openvault umask 077; /usr/local/bin/ov backup --out /var/backups/openvault/openvault-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).age && rsync -a --delete /var/backups/openvault/ /mnt/offbox/openvault/
30 2 * * * openvault umask 077; /usr/local/bin/ov audit checkpoint --out /var/backups/openvault/checkpoint-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).json
```

Check the result with `ov doctor --backup-dir /var/backups/openvault`. A backup
older than 24 hours fails the RPO check.

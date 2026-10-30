# Backup and restore

::: warning Target documentation
Backup and restore commands are part of v0.1.
:::

## What must be backed up

| Item | Why |
|---|---|
| PostgreSQL dump | Objects, ciphertext, policy, audit chain |
| Keyring file | The KEK and older keys needed to decrypt |
| Configuration snapshot | OIDC issuer, URLs, limits |
| Audit checkpoints | Off-box integrity anchor |

The database without the keyring is unreadable. The keyring without the database is
useless. Back them up together, encrypted.

## Backup

```bash
ov backup --out /backup/openvault-2026-10-29.age
```

The archive contains the database dump, keyring, and configuration manifest. It is
encrypted with age using a passphrase or recipient key.

The backup passphrase is a second factor. Age-encrypted keyrings and their passphrase flow
are deferred to a later release; until then the keyring is plaintext JSON with mode `0600`, and both
the archive passphrase and the keyring backup must be stored separately from the archive.

## Restore

1. Start PostgreSQL and the server with an empty database.
2. Run:

```bash
ov restore /backup/openvault-2026-10-29.age
```

3. Verify migrations ran.
4. Run `ov audit verify`.
5. Read one secret from each project to confirm decryption.

## Drill

Before relying on backups, run a full drill:

```bash
ov backup --out /tmp/ov-backup.age
docker compose down -v
docker compose up -d
ov restore /tmp/ov-backup.age
ov audit verify
```

Document the result. An untested backup is not a backup.

## Next

- [Rotation](/guide/rotation)
- [Hardening](/security/hardening)

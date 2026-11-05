# Backup and restore

## What must be backed up

| Item | Why |
|---|---|
| PostgreSQL dump | Objects, ciphertext, policy, audit chain |
| Keyring file | The KEK and older keys needed to decrypt |
| Configuration snapshot | OIDC issuer, URLs, limits |
| Public internal CA certificate | Agent mTLS trust anchor; the wrapped private key is in the database dump |
| Audit checkpoints | Off-box integrity anchor |

The database without the keyring is unreadable. The keyring without the database is
useless. Back them up together, encrypted.

## Backup

```bash
ov backup --out /backup/openvault-2026-10-29.age
```

The archive contains a logical JSON database dump, the keyring, the redacted configuration
manifest, the public internal CA certificate, and the audit checkpoints. It is encrypted with
age using a passphrase from a `0600` file or a hidden prompt. Recipient-key encryption is not
implemented in v0.1.

The backup passphrase is a second factor. Store it separately from the archive. The keyring
inside the archive is plaintext JSON before encryption; the archive must remain `0600`.

## Restore

Stop the server before restore. Start PostgreSQL with an empty target, or use `--force` to
replace a non-empty one. Set `OPENVAULT_RESTORE_DB_URL` to an owner/migrator role that owns the
tables.

```bash
ov restore /backup/openvault-2026-10-29.age --yes
```

The command verifies the archive checksums and the archived keyring before touching the
target, runs migrations, restores every row, and publishes the restored keyring and public CA.
Set `OPENVAULT_CA_PUBLIC_DIR` or pass `--ca-public-dir` to also publish the proxy's `ca.pem`.
It then verifies the audit chain, decrypts one current secret per project, and signs a probe
certificate with the restored CA key. The v0.1 schema does not store agent certificate PEMs,
so the pre-backup agent-certificate check is not possible; the CA probe covers the signing key.

If the restored CA differs from the CA that signed the current server certificate, re-provision
the server TLS pair after restore. The server fails closed on a certificate that does not chain
to the restored CA.

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

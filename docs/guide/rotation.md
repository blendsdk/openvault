# Rotation

## Secret rotation

Every write creates an immutable version. The agent picks up the new version on the next
refresh.

```bash
ov secret set db-password --stdin --project payments
```

The previous version remains readable until it is deleted or the secret is purged. Rotate
the consumer first if the old value must keep working during the transition.

## KEK rotation

Stop the server first. The command refuses to run while an `openvault_app` or `openvault_auth` session is
connected. A running process holds the old keyring in memory and can write a row with the old
`kek_id` after the CLI verifies the rotation. Run the command as a role that owns the key
tables; it temporarily disables the immutability triggers.

Copy the current keyring to the backup evidence store before rotating. A backup taken before
the rotation needs the keyring that existed when it was taken; the rotation removes the old
key after it verifies the new one.

```bash
ov kek rotate --dry-run
ov kek rotate --yes
```

Rotation generates a new KEK and re-wraps every secret and certificate data key, the audit
HMAC key, the `ca_keys` CA key, and the JWT signing seed. Values are never re-encrypted. The
old key is removed only after every key table reports that no row references it.

## Workload certificates

The agent renews after two thirds of the certificate's actual lifetime. The lifetime is
`OPENVAULT_CERT_TTL_DAYS` (default 30, range 1–90). Renewal requires a fresh EC P-256 key and
CSR; only the newest unexpired, unrevoked certificate may renew. The old certificate remains
valid for data until expiry but cannot renew. If renewal fails, the agent retries with jitter
and backoff. An expired certificate requires a new join token.

Revocation is one transaction that disables the identity, revokes every unexpired
certificate, and invalidates every unused join token:

```bash
ov identity revoke payments-api --project payments
```

No agent request succeeds more than 5 seconds after the revocation commits, including on an
existing keep-alive connection. An agent that receives 401/403 removes its files and exits.
Secrets already delivered cannot be retracted; rotate those values.

## Browser sessions

`POST /v1/auth/refresh` rotates the session id and cookie. Logout clears the session.

## Next

- [Backup and restore](/guide/backup-restore)
- [Certificates](/guide/certificates)

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

```bash
ov kek rotate
```

Rotation generates a new KEK, re-wraps every data key, the audit HMAC key, the internal CA
key, and the JWT signing key. Values are never re-encrypted. The old key is removed only
after the job completes and verification reads succeed.

## Workload certificates

The agent renews after two thirds of the 30-day lifetime. If renewal fails, it retries with
backoff. The current certificate remains valid until expiry, after which requests fail and
files are removed.

Revocation is immediate:

```bash
ov identity revoke payments-api --project payments
```

## Browser sessions

`POST /v1/auth/refresh` rotates the session id and cookie. Logout clears the session.

## Next

- [Backup and restore](/guide/backup-restore)
- [Certificates](/guide/certificates)

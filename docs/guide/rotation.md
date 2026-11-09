# Rotation

## Rotation policy

Every write creates an immutable version. A secret can also carry an optional rotation
policy: an interval from 1 to 3650 days. The due date is derived from the current version's
creation time plus the interval, so writing a new version completes the rotation and starts
the next interval.

The policy is managed from the secret detail page or the command line:

```bash
ov rotation set db-password --every-days 30 --project payments
ov rotation clear db-password --project payments
```

## Due, due soon, and overdue

The server computes one status for the user interface, the command line, and reminders:

| Status | Meaning |
|---|---|
| `ok` | The due date is farther away than the warning window |
| `due soon` | The due date is inside the warning window |
| `overdue` | The due date has passed |
| none | The secret has no policy |

The warning window defaults to 7 days and is configurable from 1 to 30 days. The project
**Rotation** page lists policy secrets and can show all policies, the secrets that need
attention, or only overdue secrets. The normal secrets list shows the status beside a secret
with a policy.

## Rotate a secret

Open the secret and choose **Rotate now**, or use the command line:

```bash
ov rotation rotate db-password --stdin --project payments
ov rotation rotate db-password --generate --out /secure/db-password --project payments
ov rotation list --due --project payments
ov rotation status db-password --project payments
```

A rotation accepts a value from standard input or a file, or generates 32 random bytes as a
base64url value. The generated value is shown once. With `--out` it is written to a file with
mode `0600` before the new version is written; if the write fails, the file is removed. Copy
the value before closing the dialog or terminal, or regenerate it before submitting.

The previous version remains readable until it is deleted or the secret is purged. Rotate the
consumer first if the old value must keep working during the transition.

## Restart requirement

The agent fetches the new version on its next refresh. A running application does not reload a
value automatically: restart it or make it watch the delivered file. OpenVault does not control
application processes and does not track which application holds which version. The secret
detail page shows the current consumers, their aggregate state, and their last seen time.

## Reminders

An optional daily scan sends a signed warning when a policy secret is due soon or overdue. The
request contains metadata only: the secret name, ids, due date, days until due, status, and the
event time. It never contains a value, a key, or ciphertext. Configure
`OPENVAULT_ROTATION_WEBHOOK_URL` to enable delivery; `OPENVAULT_ROTATION_WEBHOOK_SECRET` adds
the timestamp and HMAC signature described in the configuration reference. Without a webhook,
the scan still writes the rotation warning audit event and the page shows live status.

The scan records one warning per secret version, status, and due date. A failed delivery is
retried on a later scan. Changing the policy can move the due date and allow a new warning.

## KEK rotation

Stop the server first. The command refuses to run while an application or authentication
session is connected. A running process holds the old keyring in memory and can write a row
with the old key id after the CLI verifies the rotation. Run the command with a role that owns
the key tables; it temporarily disables the immutability triggers.

Copy the current keyring to the backup evidence store before rotating. A backup taken before
the rotation needs the keyring that existed when it was taken; the rotation removes the old
key after it verifies the new one.

```bash
ov kek rotate --dry-run
ov kek rotate --yes
```

Rotation generates a new key-encryption key and re-wraps every secret and certificate data
key, the audit authentication key, the CA key, and the session signing key. Values are never
re-encrypted. The old key is removed only after every key table reports that no row references
it.

## Workload certificates

The agent renews after two thirds of the certificate's actual lifetime. The lifetime is
`OPENVAULT_CERT_TTL_DAYS` (default 30, range 1–90). Renewal requires a fresh key and
certificate request; only the newest unexpired, unrevoked certificate may renew. The old certificate remains
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

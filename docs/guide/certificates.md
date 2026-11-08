# Certificates

A certificate is a named project object with immutable versions. A version stores a public
leaf and optional intermediate chain as text, the leaf metadata, and an AES-256-GCM envelope
over the PKCS#8 private key. Import and generation are create-or-renew by name: an existing
active name receives a new immutable version.

## Import

```http
POST /v1/data/payments/certificates/import
{
  "name": "tls-server",
  "certificatePem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "chainPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "allowNotYetValid": false,
  "tags": { "owner": "payments" }
}
-> 201 {
     "id": "01J...", "projectId": "01J...", "name": "tls-server",
     "subject": "CN=tls.payments.internal", "sans": ["DNS:tls.payments.internal"],
     "issuer": "CN=Payments Intermediate", "serial": "1003",
     "fingerprint": "<64 lowercase hex>", "notBefore": "...", "notAfter": "...",
     "daysToExpiry": 364, "chainLength": 3,
     "version": { "id": "01J...", ... }, "certificatePem": "...", "chainPem": "...",
     "warnings": [], "capabilities": { ... }
   }
```

Validation rules:

- The leaf field contains exactly one `CERTIFICATE` block. The chain field contains zero or
  more `CERTIFICATE` blocks. The key field contains exactly one PKCS#8 `PRIVATE KEY` block.
- PEM armor, canonical base64, and bounds are strict. The combined public chain is limited to
  `OPENVAULT_CERT_MAX_BYTES` (131,072); the private key is limited to 16,384 bytes.
- Keys are RSA 2048, RSA 3072, or EC P-256. Traditional `RSA PRIVATE KEY`/`EC PRIVATE KEY`,
  encrypted keys, RSA-PSS, Ed25519, EC P-384, and RSA 4096 are rejected.
- The leaf public key must match the private key. A mismatch is 422 and writes no row.
- Provided chain links are verified with signature-only verification. A used intermediate must
  be a CA certificate with `keyCertSign`. An expired or not-yet-valid intermediate imports with
  a warning. A chain whose first certificate claims the leaf issuer but fails the signature is
  422. A chain that is not the leaf's issuer is dropped and imports the leaf with
  `missing_intermediate`.
- Not-yet-valid leaves are rejected unless `allowNotYetValid` is true. Expired leaves import
  with an `expired` warning.
- Supported SAN types are `DNS:`, `IP:`, `URI:`, and `email:`. Unsupported SAN types are
  rejected rather than stored lossily.

The response returns the normalized public leaf and non-leaf chain and a `warnings` array. The
private key is never returned.

## Generate

```http
POST /v1/data/payments/certificates/generate
{
  "name": "tls-server",
  "subject": "CN=payments.internal",
  "sans": ["DNS:payments.internal", "DNS:api.payments.internal"],
  "keyType": "ec-p256",
  "validityDays": 365
}
-> 201 { ...metadata..., "certificatePem": "...", "chainPem": "", "warnings": [] }
```

Supported key types are `rsa-2048`, `rsa-3072`, and `ec-p256`. The certificate is self-signed
with SHA-256, `CA=false`, `digitalSignature` (plus `keyEncipherment` for RSA), server and client
authentication EKU, and the requested typed SANs. Validity is 1–825 days (default 365).
`notBefore` is backdated 30 seconds to absorb modest client clock lag. Only the public
certificate is returned.

## Renewal

Importing or generating an existing active name appends a new immutable version and moves the
current pointer. The previous version remains readable with `?version=<version-ulid>`. A
soft-deleted name is reserved until purge and returns 409 `certificate_name_conflict`.

Pass the current `version.id` as `expectedVersionId` to reject a delayed retry that would
otherwise move the current pointer backwards. A stale value returns 409
`certificate_version_conflict`. There is no `Idempotency-Key` on certificate writes.

Certificate versions are capped at 1,000 retained versions; a further write returns 409
`certificate_version_limit`.

## Read

`GET /v1/data/:project/certificates/:name` returns metadata plus `certificatePem` (leaf) and
`chainPem` (non-leaf blocks). `GET /:name?version=<ulid>` selects a specific version. The
selected version's subject, SANs, issuer, serial, fingerprint, dates, chain length, and version
identity describe the whole response metadata.

An expired current version returns 410 `certificate_expired`; an explicit `?version=` returns
the stored version even when expired.

The private key requires `certificate.read_private`:

```http
GET /v1/data/payments/certificates/tls-server/private-key
-> 200 { "id": "01J...", "projectId": "01J...", "name": "tls-server",
          "fingerprint": "...", "privateKeyPem": "-----BEGIN PRIVATE KEY-----...",
          "version": { ... }, "capabilities": { ... } }
```

A caller with `certificate.read` but not `certificate.read_private` receives 403. The private
route is limited to 30 requests per minute per principal; import/generate are limited to 10.
The server decrypts before writing its allow event; a tampered envelope returns 500
`certificate_integrity_failed`. The private key is never in metadata, lists, audit events, logs,
errors, or the expiry webhook.

## List and search

```http
GET /v1/data/payments/certificates?q=payments&san=DNS:payments.internal&expiresBefore=2027-01-01T00:00:00.000Z&limit=50
-> 200 { "certificates": [ { "name": "tls-server", ... } ], "nextCursor": null }
```

`q` is a literal case-insensitive subject substring. `san` is an exact case-insensitive SAN.
`expiresBefore`/`expiresAfter` filter the current version's `not_after`. Results are ordered by
name and id; `limit` is 1–100 (default 50). A malformed cursor or inverted expiry window is 422.
List items contain no PEM and no private key.

## Lifecycle

```http
PATCH  /v1/data/payments/certificates/tls-server { "purgeProtected": true }
DELETE /v1/data/payments/certificates/tls-server
POST   /v1/data/payments/certificates/tls-server/recover
POST   /v1/data/payments/certificates/tls-server/purge
```

`PATCH` changes tags and enables one-way purge protection without creating a version. Protection
cannot be disabled. `DELETE` sets `deleted_at` and a purge boundary of
`OPENVAULT_SOFT_DELETE_DAYS` (7–90, default 30). Reads and lists hide a deleted certificate.
Recovery is allowed until the retention boundary. A name stays reserved until purge; a protected
deleted name is reserved permanently.

`purge` requires a deleted certificate, a passed retention boundary, and protection off. It
returns 409 `certificate_not_deleted`, `certificate_retention_active`, or
`purge_protection_locked` otherwise. A deleted project hides its certificates and blocks purge
with 404 `certificate_not_found`; the response does not reveal whether the project exists.

### Purge credential

Purge needs the dedicated `openvault_purger` session because the schema trigger rejects deletes
from the application role. Set `OPENVAULT_PURGE_DB_URL` and grant:

```sql
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificates TO openvault_purger;
GRANT SELECT, DELETE ON certificate_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificate_expiry_notifications TO openvault_purger;
```

Do not make the role a superuser, a table owner, or a member of any owner role. The server
verifies the database, session user, current user, superuser status, and ownership on every
purge. Without a valid URL the server starts and only purge returns 503. The authorization event
is written before the delete; a completion event follows a successful delete. A crash can leave
authorization without completion, which means the outcome is unknown.

## Expiry

A daily job runs at `OPENVAULT_CERT_EXPIRY_HOUR` (UTC, default 3) and considers only the current
version of an active certificate in an active project. It maps the remaining time to the 30, 14,
or 7-day threshold using the raw remaining milliseconds. A certificate first seen at 10 days
receives the 14-day warning only; earlier thresholds are not replayed. Expired certificates are
skipped.

Set `OPENVAULT_CERT_EXPIRY_WEBHOOK_URL` to deliver warnings. The URL must be HTTPS, except
loopback HTTP outside production. Credentials, fragments, and production link-local/metadata
addresses are rejected. The URL is never logged or included in redacted configuration. An
optional `OPENVAULT_CERT_EXPIRY_WEBHOOK_SECRET` (16–256 characters) adds:

```http
X-OpenVault-Timestamp: 2026-11-04T12:00:00.000Z
X-OpenVault-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + rawBody)>
```

Payload:

```json
{
  "event": "certificate.expiry_warning",
  "eventId": "01J...:01J...:30",
  "certificateId": "01J...", "projectId": "01J...", "name": "tls-server",
  "versionId": "01J...", "fingerprint": "...", "notAfter": "...",
  "daysToExpiry": 30, "thresholdDays": 30, "occurredAt": "..."
}
```

The notification table provides one durable claim per `(version, threshold)`. A failed delivery
is retried on a later run. A crash after a claim is recovered after the one-hour lease, normally
on the next daily run. The stable `eventId` lets receivers dedupe a rare duplicate. A successful
delivery writes one `certificate.expiry_warning` audit event with the version detail; a failed
attempt writes an error outcome.

## Audit and errors

Every authenticated route writes an authorization decision after the target project or
object is resolved. Import/generate/renew write one joined `certificate.write` allow with the
mode and renewal flag. Public reads write `certificate.read`; private reads decrypt and export
the key first, then write `certificate.read_private`. Delete, recovery, and purge write their
actions. A denied request writes one deny. A parse, generation, or state-change failure after
authorization writes one independent error outcome; a missing target or malformed request
before an object decision returns 404/422 without an allow event.

| Status | Meaning |
|---|---|
| 403 | The caller can list certificates or already knows the object, but lacks the action; for example, public read without private read |
| 404 | The project, certificate, or version is missing, or the caller cannot list the collection and cannot distinguish hidden from missing |
| 409 | Name conflict, stale version, version limit, or lifecycle conflict |
| 410 | The requested version has expired |
| 413 | The public chain or private key exceeds its bound |
| 422 | Invalid PEM, key, chain, SAN, subject, date, cursor, or request shape |
| 500 | Stored certificate material failed integrity verification |
| 503 | Policy, audit, keyring, or purge unavailable |

## Envelope and limitations

Certificate private keys use the v2 AAD with `objectType=certificate`, project, certificate, and
version. Moving a certificate envelope into a secret row fails authentication. The envelope
change is one-way for this pre-release repository; both version tables must be empty before
first boot.

v1.0 does not implement a CA, ACME, OCSP/CRL, HSM keys, a certificate UI, agent certificate
delivery, certificate consumers, a versions-list route, or import/generate idempotency. A
generated or imported private key exists briefly as a PEM string that cannot be zeroed; the DER
buffer is zeroed. A certificate route never accepts an agent principal: a same-project agent
receives 401 from the controller, and a project-mismatched certificate is rejected 403 by the
existing agent guard.

# Projects and secrets

A project is the namespace for secrets, certificates, identities, and role assignments. A
secret is a named object with immutable encrypted versions and mutable metadata.

## Projects

Organization administrators create, rename, and soft-delete projects. The admin routes use the
project ULID; the data routes use the active project name.

```http
POST /v1/admin/projects
{ "name": "payments" }
-> 201 { "id": "01J...", "name": "payments", "createdAt": "...", "updatedAt": "...",
          "deletedAt": null }

GET    /v1/admin/projects
GET    /v1/admin/projects/01J...
PATCH  /v1/admin/projects/01J...   { "name": "payments-prod" }
DELETE /v1/admin/projects/01J...
```

Project names match `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` and are unique among active projects.
A soft-deleted project immediately hides its secrets, certificates, identities, and
assignments. The rows and audit history remain. There is no project-recovery API; a project
restore is an operator database action. Secrets inside a deleted project cannot be purged
through the API until the project is restored.

A project rename changes the name used by `/v1/data/:project/...` routes. Agents and clients
that address a project by name must update the name; clients that use the project ULID and the
admin routes are unaffected.

## Secret write and read

```http
POST /v1/data/payments/secrets
{ "name": "db-password", "value": "s3cret", "tags": { "env": "prod" } }
-> 201 { "id": "01J...", "name": "db-password", "currentVersion": { ... },
          "version": { ... }, "capabilities": { ... } }

GET /v1/data/payments/secrets/db-password
-> 200 { "value": "s3cret", "encoding": "utf8", "contentType": "text/plain", ... }
```

`POST` creates the secret and its first version. `PUT /:name` writes a new immutable version.
`PATCH /:name` changes tags, content type, or purge protection without creating a version.
The value is required on `POST` and `PUT`; metadata reads and lists never contain a value.

### Encoding and limits

`encoding` is `utf8` (default) or `base64`. Base64 must be canonical. Empty and
whitespace-only decoded values are rejected with 422. A value above 65,536 decoded bytes
returns 413 `secret_too_large`.

Reads return `encoding: "utf8"` when the stored bytes are valid UTF-8 without unsafe control
characters, otherwise canonical base64. The exact bytes are always preserved.

### Versions and expiry

Every `PUT` creates a new version. `GET /:name/versions` lists version metadata newest first,
with `status` (`active`/`expired`) and `isCurrent`. A named version is read with
`GET /:name?version=<version-ulid>`.

An optional `expiresAt` must be in the future. A value read returns 410 `secret_expired` when
the requested version has expired. Without a version selector, the newest active version is
returned; if every version has expired, the read returns 410. A new write becomes the current
version even when the previous version expired.

### Tags and content type

Tags are at most 15 key/value pairs; keys are 1–64 characters and values 1–256 characters.
Control characters are rejected. `contentType` is 1–128 characters and defaults to
`text/plain`.

### Search and pagination

`GET /v1/data/:project/secrets` accepts `q` (literal name substring), `tagKey`, optional
`tagValue`, `limit` (1–100, default 50), and `cursor`. Results are ordered by name. A
malformed cursor returns 422.

## Idempotency

`POST` and `PUT` accept `Idempotency-Key` (1–200 visible ASCII characters). The claim, version,
and audit decision commit in one transaction. A replay within 24 hours returns the current
metadata plus the original written `version`. Reusing a key for a different request or path
returns 409 `idempotency_conflict`. A replay after the secret was purged returns 404.

The request hash is an HMAC derived from the current KEK. A KEK rotation invalidates outstanding
keys, which fail closed with 409. Expired idempotency rows are an operational cleanup item for
the backup/rotation work.

## Capabilities and consumers

Every secret metadata and value response includes `canRead`, `canWrite`, `canDelete`,
`canPurge`, and `canManage`. The server computes them from the policy matrix; clients never
derive permissions from role names.

`GET /:name/consumers` lists the active consumers in the same project whose live role grants
`secret.read` on the secret. It returns Compose project/service and `lastSeen`; host paths and
manifest hashes stay out of secret metadata. A successful agent read refreshes the consumer
`last_seen` timestamp.

## Lifecycle

```http
DELETE /v1/data/payments/secrets/db-password
POST   /v1/data/payments/secrets/db-password/recover
POST   /v1/data/payments/secrets/db-password/purge
```

`DELETE` sets `deleted_at` and a purge boundary of `OPENVAULT_SOFT_DELETE_DAYS` (7–90,
default 30). Reads and lists hide the secret. Recovery is allowed until the retention
boundary. A name stays reserved while its secret is retained, so create, recover, and purge
always address one deterministic row.

`purge` requires a deleted secret, a passed retention boundary, and purge protection off. It
returns 409 `secret_retention_active`, `purge_protection_locked`, or `secret_not_deleted`
otherwise. Purge deletes every version and the parent row.

### Purge protection

`PATCH { "purgeProtected": true }` enables one-way protection while the secret is active.
Protection cannot be disabled. A protected secret can never be purged, so its name stays
reserved permanently; recover it before retention or use a new name.

### Purge credential

Purge needs a dedicated PostgreSQL session because the schema trigger rejects deletes from the
application role. Set `OPENVAULT_PURGE_DB_URL` for a login role named `openvault_purger` with:

```sql
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
```

Do not make the role a superuser, the table owner, or a member of either. The server verifies
the database, session user, and role memberships on every purge. Without a valid URL, the
server still starts and only purge returns 503. A failed purge writes an error outcome; a crash
between the destructive delete and its outcome event leaves the deletion without evidence.

## Audit and errors

Every read and state change writes an authorization decision. State-changing decisions join the
data transaction; reads write one allow before returning plaintext. Secret read/write events
include the resolved version id. A failed read writes an error outcome. Errors never contain a
value, ciphertext, or key id.

| Status | Meaning |
|---|---|
| 403 | The caller has no grant for the action anywhere |
| 404 | The project, secret, or version is missing or outside the caller's visible scope |
| 409 | Name conflict, idempotency conflict, version limit, or lifecycle conflict |
| 410 | The requested version has expired |
| 413 | The decoded value is above 65,536 bytes |
| 422 | Invalid input, tag, cursor, expiry, or idempotency key |
| 500 | Stored ciphertext failed integrity verification |
| 503 | Policy, audit, keyring, or purge unavailable |

## Envelope version

Secret envelopes use the v2 AAD, which binds object type, project, object, and version. This
change is one-way. Before the first deployment of this release, both `secret_versions` and
`certificate_versions` must be empty. A database that already contains v1 version rows needs a
migration or a restore plan; do not deploy v2 over it.

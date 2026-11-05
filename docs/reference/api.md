# API reference

The API is served under `/v1`. Requests and responses use the WebAFX envelopes.

## Success

```json
{ "success": true, "data": { } }
```

## Error

```json
{
  "success": false,
  "error": {
    "code": "secret_not_found",
    "message": "Secret not found",
    "statusCode": 404,
    "timestamp": "2026-10-29T12:00:00.000Z",
    "requestId": "6f1c...",
    "path": "/v1/data/demo/secrets/db-password"
  }
}
```

Request ids use the `X-Request-ID` header. Production errors never contain secret values or
stack traces.

## Authentication

| Caller | Method |
|---|---|
| Browser | `__Host-ov_session` cookie plus `X-CSRF-Token` on mutations |
| CLI | `Authorization: Bearer <jwt>` |
| Agent | mTLS client certificate; `/v1/agent/join` uses a single-use join token |

The browser session cookie is `__Host-ov_session`: HttpOnly, Secure, SameSite=Lax, Path=/,
and no Domain. Session ids are 32 random bytes stored only as a SHA-256 hash. The absolute
lifetime is `OPENVAULT_SESSION_TTL_HOURS` (default 8). Refresh rotates the secret and CSRF
token. OIDC login additionally uses a short-lived `__Host-ov_oidc` binding cookie; the
callback rejects a flow without the matching binding.

A failed local login returns `401 invalid_credentials` with the same body for an unknown
user, a wrong password, a disabled principal, or a locked account. Five failures in a
rolling 15-minute window lock the account for 15 minutes. Login is limited to 5/min per IP
and 10/hour per account; a rejected limit returns `429 RATE_LIMIT_EXCEEDED`.

While `mustChangePassword` is true, the browser may use only `GET /v1/auth/me`,
`POST /v1/auth/password`, `POST /v1/auth/logout`, and `GET /v1/meta/*`. The CLI may use only
`GET /v1/auth/cli/me` and `POST /v1/auth/cli/logout`. Other authenticated routes return
`403 password_change_required`.

## Generated contract

The CLI-facing API is published as OpenAPI 3.1:

| Artifact | Path |
|---|---|
| OpenAPI document | `packages/api-contract/openapi.json` |
| Generated typed client (CLI) | `apps/cli/src/generated/` |
| Generated typed client (web) | `apps/web/src/generated/` |
| Generator | `apps/server/scripts/api-contract.ts` |

`pnpm api:generate` regenerates the OpenAPI document, the CLI client, and the browser client
from the real controllers plus one route metadata table. `pnpm api:check` rebuilds all of them
in memory and fails on any document or client drift; `pnpm verify` runs it. Generated files are
committed but ignored by Biome, because the generator uses its own formatting. The browser
client is built from a separate in-memory document with cookie-session security, because the
published JSON contract stays CLI-facing and bearer-authenticated.

The contract covers the CLI-facing routes only: CLI authentication, projects, secrets,
certificates, identities, assignments, access explanation, audit query/verify/export, scaffold,
meta, and `/ready`. Internal agent, browser/OIDC, and probe routes remain documented by this
reference but are deliberately excluded from the generated client.

The metadata table is the schema source for the generated client; the real controllers are the
source for paths and methods. `api:check` therefore detects route and artifact drift. A
controller schema change that leaves the table untouched is caught by the representative
command end-to-end tests against the real server.

## Routes

### Authentication

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/auth/login` | Starts OIDC with PKCE, state, nonce, and the binding cookie |
| GET | `/v1/auth/callback` | Validates state, binding, nonce, and UserInfo `sub` |
| POST | `/v1/auth/local/login` | Local password; sets the session cookie |
| POST | `/v1/auth/password` | Changes the current password; rotates the session |
| POST | `/v1/auth/logout` | Clears the session |
| GET | `/v1/auth/me` | Session user, CSRF token, and forced-change flag |
| POST | `/v1/auth/refresh` | Rotates the session secret and CSRF token |
| GET | `/v1/auth/sessions` | Lists the current principal's sessions |
| DELETE | `/v1/auth/sessions/:id` | Revokes an owned session by its public id |
| POST | `/v1/auth/cli/login` | Returns an access token and rotating refresh token |
| POST | `/v1/auth/cli/refresh` | Rotates the access and refresh tokens |
| POST | `/v1/auth/cli/logout` | Revokes the refresh family; idempotent |
| GET | `/v1/auth/cli/me` | Current CLI user and forced-change flag |
| GET | `/v1/auth/cli/sessions` | Lists the current principal's CLI families |
| DELETE | `/v1/auth/cli/sessions/:familyId` | Revokes an owned CLI family |
| POST | `/v1/agent/join` | Token-authenticated bootstrap; no client certificate required |
| POST | `/v1/agent/renew` | mTLS renewal with the current certificate |
| POST | `/v1/agent/consumer` | mTLS aggregate consumer heartbeat |

Local login and password change are origin-guarded. The login body is
`{ "identifier": "...", "password": "..." }`; the password-change body is
`{ "currentPassword": "...", "newPassword": "..." }` with a 12–1024 character new password.
The session list returns public ids, timestamps, auth method, and a current flag; it never
returns the secret or CSRF token.

OIDC identities link by `(issuer, subject)`. JIT provisioning requires
`email_verified: true`, an exact allowed-domain match, and an unused normalized email; a
verified email that belongs to another principal is rejected rather than auto-linked. OIDC
access, refresh, and ID tokens are discarded after login and never enter the session cache,
the database, or request logs. A provider timeout or 5xx returns `503 oidc_unavailable`; a bad
code, state, nonce, binding, or UserInfo subject returns `400 oidc_callback_failed`.

### CLI authentication

CLI login uses the same local credential verifier, lockout state, generic failure body, and
per-IP/per-account rate-limit buckets as browser login.

```text
POST /v1/auth/cli/login
{ "identifier": "alice@example.com", "password": "..." }

POST /v1/auth/cli/refresh
{ "refreshToken": "<43-character base64url>" }

POST /v1/auth/cli/logout
{ "refreshToken": "<43-character base64url>" }
```

Login and refresh return:
`{ accessToken, refreshToken, tokenType: "Bearer", accessExpiresAt, refreshExpiresAt, user,
mustChangePassword }`. The access token is an Ed25519 JWT with a 15-minute lifetime, issuer
`openvault`, audience `openvault-cli`, and claims `sub`, `sid`, `jti`, `iat`, `exp`, `kind`.
`sid` is the CLI session family id. The refresh token is 32 random bytes encoded as
43-character base64url; it is not a JWT. A family has an absolute 12-hour lifetime from login;
rotation does not extend it. Reuse of a rotated or revoked token, logout, password change, or
principal disable revokes the family.

CLI requests use `Authorization: Bearer <jwt>` and must not send a browser cookie or CSRF
token. Every request verifies the signature, algorithm, issuer, audience, `kid`, and expiry,
then checks that the principal is active and the family has a live row. A revoked family or
disabled principal returns `401 authentication_required`; a bad login returns
`401 invalid_credentials`; an unknown, expired, or reused refresh token returns
`401 invalid_refresh_token`. Refresh is limited to 60/minute per IP and 30/minute per family;
a rejected limit returns `429 RATE_LIMIT_EXCEEDED`. Logout returns 204 for any well-formed
token, including an already-revoked one, and 400 `validation_error` for a malformed token.

### Service identities

```text
POST /v1/admin/identities
{ "name": "payments-api", "projectId": "01J..." }
-> 201 { "id", "name", "projectId", "status", "createdAt" }

GET /v1/admin/identities?projectId=01J...
-> 200 { "identities": [ { "id", "name", "projectId", "status", "createdAt" } ] }

GET /v1/admin/identities/:id
-> 200 {
     "id", "name", "projectId", "status", "createdAt",
     "certificates": [ { "serial", "fingerprint", "notBefore", "notAfter", "revokedAt" } ],
     "consumer": { "composeProject", "composeService", "hostname", "manifestHash",
                   "state", "firstSeen", "lastSeen", "selfReported": true } | null
   }

POST /v1/admin/identities/:id/revoke
-> 204

POST /v1/admin/identities/:id/join-tokens
{ "ttlSeconds": 900 }
-> 201 { "id", "token", "expiresAt" }
```

The join token is shown once; it is never returned by a read route. `ttlSeconds` defaults to
`OPENVAULT_JOIN_TOKEN_TTL` (15 minutes) and cannot exceed 24 hours. A create without a project
returns `422 validation_error`; a duplicate active name returns `409 identity_name_conflict`;
an unknown or foreign identity returns `404 identity_not_found`. Revoke is idempotent and
revokes all certificates and unused tokens for the identity. A service identity cannot receive
a local credential, OIDC identity, browser session, or CLI family. `identity.read` allows an
auditor; create, revoke, and join-token issuance require an org or owning-project
administrator.

### Role assignments

```text
GET /v1/admin/assignments?principalId=01J...&role=secrets.reader&scopeType=project&scopeId=01J...
-> 200 { "assignments": [ {
     "id": "01J...", "principalId": "01J...", "role": "secrets.reader",
     "scopeType": "project", "scopeId": "01J...", "grantedBy": "01J...",
     "createdAt": "2026-11-03T20:00:00.000Z", "expiresAt": null } ] }

POST /v1/admin/assignments
{ "principalId": "01J...", "role": "secrets.reader",
  "scopeType": "project", "scopeId": "01J...", "expiresAt": "2027-01-01T00:00:00.000Z" }
-> 201 { "id": "01J...", "principalId": "01J...", "role": "secrets.reader",
          "scopeType": "project", "scopeId": "01J...", "grantedBy": "01J...",
          "createdAt": "...", "expiresAt": "2027-01-01T00:00:00.000Z" }

DELETE /v1/admin/assignments/:id
-> 204
```

The assignment create requires `assignment.write` at the target scope or an ancestor.
`org` scope uses the literal id `org`; project and object scopes use a ULID. Object scope is
limited to `secrets.reader` and `certificates.reader`. An expiry must be in the future.

A duplicate tuple returns `409 assignment_conflict`. A visible assignment the caller cannot
write returns `403 access_denied`; an assignment outside the caller's visible scope returns
`404 assignment_not_found`. Removing the last active user organization administrator returns
`409 last_org_admin`. A service identity cannot receive a control-plane role; that request
returns `422 service_control_plane`. Assignment writes are limited to 30 per minute per
principal; reads and explanations are limited to 60 per minute per principal. A rejected limit
returns `429 RATE_LIMIT_EXCEEDED`.

```text
GET /v1/admin/access-explain?action=secret.read&scopeType=object&scopeId=01J...
-> 200 {
     "policyVersion": 8,
     "action": "secret.read",
     "scope": { "type": "object", "id": "01J..." },
     "principals": [ {
       "principalId": "01J...", "name": "payments-api", "kind": "service",
       "role": "secrets.reader", "assignmentId": "01J...",
       "scopeType": "object", "scopeId": "01J...",
       "consumer": { "composeProject": "payments", "composeService": "api",
                     "hostname": "api-1", "state": "ok",
                     "lastSeen": "2026-11-03T19:59:00.000Z" } } ] }
```

The explanation requires `assignment.read` on the explained resource. A project or object
that is missing, soft-deleted, or outside the caller's scope returns `404 resource_not_found`.
The response lists only principals with an effective permission. `policyVersion` is read from
the same statement as the assignment rows.

`GET /v1/meta/roles` returns the static action catalog, the nine role definitions, and the
current `policyVersion`. It is public and contains no principals, assignments, or project data.

```json
{ "actions": [ { "name": "project.create", "plane": "control",
                  "description": "Create a project" } ],
  "roles": [ { "name": "reader",
               "actions": ["project.read", "secret.list", "certificate.list"],
               "scopes": ["org", "project"] } ],
  "policyVersion": 8 }
```

The policy layer computes the current principal's capability flags for a secret or
certificate. Secret metadata and value responses return them; the UI uses these flags and
never derives permissions from client-side role math.

```json
{ "capabilities": { "canRead": true, "canWrite": false, "canDelete": false,
                    "canPurge": false, "canManage": false } }
```

`canManage` is the `assignment.write` action at the object's scope; the other flags map to the
object's read, write, delete, and purge actions.

### Agent authentication

```text
POST /v1/agent/join
{ "token": "<43-character base64url>",
  "csr": "<PEM PKCS#10>",
  "consumer": { "composeProject": "payments", "composeService": "api",
                "hostname": "b7c1...", "manifestHash": "sha256:<64 lowercase hex>" } }
-> 200 { "certificatePem", "chainPem", "identityId", "serial", "notAfter" }

POST /v1/agent/renew
{ "csr": "<PEM PKCS#10>", "consumer": { ... } }
-> 200 { "certificatePem", "chainPem", "identityId", "serial", "notAfter" }
```

`POST /v1/agent/join` is the only agent route that does not require a client certificate. It
is token-authenticated, rate-limited to 10/minute per source IP, and returns `401 join_failed`
for an unknown, expired, used, or revoked token. Token failures use one generic body. The
token is 32 random bytes encoded as 43-character base64url; only a 32-byte SHA-256 hash is
stored. The server claims the token atomically with certificate and consumer insertion, so a
concurrent second exchange cannot issue another certificate.

The server derives the certificate CN and SAN from the token identity, not from the CSR. The
issued certificate has CN = principal id, exactly one SAN URI
`openvault://identity/<id>`, `CA:FALSE`, `digitalSignature`, and `clientAuth`. The CSR must
prove possession of an EC P-256 key; non-P-256 keys, invalid signatures, requested SANs,
`CA:TRUE`, requested key usage/EKU, and unknown critical extensions return
`422 validation_error` and issue no certificate. An arbitrary or empty CSR subject is
accepted. The response contains the leaf certificate and CA chain, never a private key.

Every other agent request requires a client certificate chained to
`OPENVAULT_INTERNAL_CA`, an unexpired certificate, a matching stored SHA-256 fingerprint, no
revocation, an active principal, and an active project. A failed check returns
`401 authentication_required`; a database/cache failure returns 503. The check runs on every
request, not only at the TLS handshake, and the state cache is bounded to 5 seconds.

The agent listener reserves `GET /v1/data/:project/secrets/:name` for the data-plane release.
The certificate principal's `owner_project_id` must equal the id of the project named by
`:project`; the production secret handler and consumer heartbeat are delivered with that
data-plane work. Revocation removes all
certificates and unused tokens in one transaction; no request succeeds more than 5 seconds
after the revocation commits, including on an existing keep-alive connection. Renewal is
allowed after two thirds of the certificate's actual lifetime and requires a fresh CSR/key.
Only the newest unexpired, unrevoked certificate may renew; older certificates remain valid
for data until expiry. Join tokens and workload certificates have bounded retention: tokens
for 24 hours after expiry/use; certificates for 30 days after expiry or revocation.

Startup validates that the wrapped CA signing key is present and matches
`OPENVAULT_INTERNAL_CA`; `GET /ready` then signs and verifies a test certificate with the
loaded key.

### Meta

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/meta/auth` | `{ local, oidc }` |
| GET | `/v1/meta/roles` | Role and action catalog |
| GET | `/v1/meta/capabilities` | Global UI gates and project list |

### Control plane

| Method | Path | Action |
|---|---|---|
| GET | `/v1/admin/projects` | `project.read` |
| POST | `/v1/admin/projects` | `project.create` |
| GET | `/v1/admin/projects/:project` | `project.read` |
| PATCH | `/v1/admin/projects/:project` | `project.update` |
| DELETE | `/v1/admin/projects/:project` | `project.delete` |
| GET | `/v1/admin/identities` | `identity.read` |
| POST | `/v1/admin/identities` | `identity.create` |
| GET | `/v1/admin/identities/:id` | `identity.read` |
| POST | `/v1/admin/identities/:id/revoke` | `identity.revoke` |
| POST | `/v1/admin/identities/:id/join-tokens` | `identity.join_token` |
| POST | `/v1/admin/scaffold` | `assignment.write` plus the service checks |
| GET | `/v1/admin/assignments` | `assignment.read` |
| POST | `/v1/admin/assignments` | `assignment.write` |
| DELETE | `/v1/admin/assignments/:id` | `assignment.write` |
| GET | `/v1/admin/access-explain` | `assignment.read` |
| POST | `/v1/admin/kek/rotate` | `kek.rotate` |

Project examples:

```http
POST /v1/admin/projects { "name": "payments" }
-> 201 { "id": "01J...", "name": "payments",
          "createdAt": "2026-11-04T12:00:00.000Z",
          "updatedAt": "2026-11-04T12:00:00.000Z", "deletedAt": null }

PATCH /v1/admin/projects/01J... { "name": "payments-prod" }
-> 200 { "id": "01J...", "name": "payments-prod", ... }

DELETE /v1/admin/projects/01J...
-> 204
```

Project names match `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`. A duplicate active name returns 409
`project_name_conflict`. A deleted project returns 404 and hides its secrets, certificates,
identities, and assignments. There is no project-recovery route in v0.1. Project **list items**
add `certificateCount`, the number of active certificates in the project; single-project
responses keep the existing shape.

### Compose scaffold

`POST /v1/admin/scaffold` creates or reuses the project and service identity, grants
object-scope `secrets.reader` only for the listed entries, revokes older unused join tokens,
and returns a per-service Compose snippet plus a manifest skeleton.

```http
POST /v1/admin/scaffold
{ "project": "payments", "service": "api",
  "entries": ["db-password", "stripe-api-key"] }
-> 200 {
     "project": { "id": "01J...", "name": "payments", ... },
     "identity": { "id": "01J...", "name": "api", "projectId": "01J...",
                    "status": "active", "createdAt": "..." },
     "assignments": [ { "name": "db-password",
                        "assignment": { "role": "secrets.reader",
                          "scopeType": "object", "scopeId": "01J...", ... } } ],
     "joinToken": { "id": "01J...", "token": "<43 chars>", "expiresAt": "..." },
     "compose": "services:\n  openvault-agent-api:\n...",
     "manifest": "project: \"payments\"\n...",
     "manifestFile": "openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml"
   }
```

The token is returned once and never appears in `compose` or `manifest`. A project with entries
must already exist and contain those secrets. A new project can be created by sending an empty
entry list. Re-running is idempotent for the project, identity, and live assignments and issues
a fresh token. If the reused identity already has a broader live grant, the route returns 409
`identity_scope_conflict`. The service name uses `^[a-z0-9][a-z0-9_-]{0,62}$` so it is safe in
Compose paths and YAML. The route is rate limited to 5 requests per minute per principal.

### Consumer heartbeat and fetch headers

`POST /v1/agent/consumer` accepts `{ "state": "ok" | "degraded" | "failed" }` over mTLS and
updates `consumers.last_seen` and `state`. A state change writes one `consumer.update` audit
event; a `last_seen`-only update does not.

An agent secret fetch may send:

| Header | Values | Meaning |
|---|---|---|
| `X-OpenVault-Consumer-State` | `ok`, `degraded`, `failed` | Aggregate state before this entry |
| `X-OpenVault-Entry-Optional` | `true`, `false` | Whether a 404/410 degrades or fails |

The server records the state after a successful read. A 404/410 records `degraded` for an
optional entry and `failed` for a required entry. Invalid or repeated values return 422.

### Data plane

| Method | Path | Action |
|---|---|---|
| GET | `/v1/data/:project/secrets` | `secret.list` |
| POST | `/v1/data/:project/secrets` | `secret.write` |
| GET | `/v1/data/:project/secrets/:name` | `secret.read` |
| GET | `/v1/data/:project/secrets/:name/versions` | `secret.read` |
| PUT | `/v1/data/:project/secrets/:name` | `secret.write` |
| PATCH | `/v1/data/:project/secrets/:name` | `secret.write` |
| DELETE | `/v1/data/:project/secrets/:name` | `secret.delete` |
| POST | `/v1/data/:project/secrets/:name/recover` | `secret.recover` |
| POST | `/v1/data/:project/secrets/:name/purge` | `secret.purge` |
| GET | `/v1/data/:project/secrets/:name/consumers` | `secret.list` |
| GET | `/v1/data/:project/certificates` | `certificate.list` |
| POST | `/v1/data/:project/certificates/import` | `certificate.write` |
| POST | `/v1/data/:project/certificates/generate` | `certificate.write` |
| GET | `/v1/data/:project/certificates/:name` | `certificate.read` |
| GET | `/v1/data/:project/certificates/:name/private-key` | `certificate.read_private` |
| PATCH | `/v1/data/:project/certificates/:name` | `certificate.write` |
| DELETE | `/v1/data/:project/certificates/:name` | `certificate.delete` |
| POST | `/v1/data/:project/certificates/:name/recover` | `certificate.recover` |
| POST | `/v1/data/:project/certificates/:name/purge` | `certificate.purge` |

Secret examples:

```http
POST /v1/data/payments/secrets
Idempotency-Key: 6f1c2d3e
{ "name": "db-password", "value": "s3cret", "encoding": "utf8",
  "contentType": "text/plain", "tags": { "env": "prod" } }
-> 201 { "id": "01J...", "projectId": "01J...", "name": "db-password",
          "tags": { "env": "prod" }, "contentType": "text/plain", "status": "active",
          "currentVersion": { "id": "01J...", "createdAt": "...", "createdBy": "01J...",
                              "expiresAt": null },
          "version": { "id": "01J...", ... }, "consumers": [],
          "capabilities": { "canRead": true, "canWrite": true, "canDelete": true,
                            "canPurge": true, "canManage": false } }

GET /v1/data/payments/secrets/db-password
-> 200 { "value": "s3cret", "encoding": "utf8", "version": { ... }, ... }

GET /v1/data/payments/secrets?q=db&tagKey=env&tagValue=prod&limit=50
-> 200 { "secrets": [ { "name": "db-password", ... } ], "nextCursor": null }

PUT /v1/data/payments/secrets/db-password
Idempotency-Key: 8a2b
{ "value": "new-value" }
-> 200 { "currentVersion": { ... }, "version": { ... }, ... }

PATCH /v1/data/payments/secrets/db-password
{ "tags": { "env": "prod", "team": "payments" }, "purgeProtected": true }
-> 200 { ... }

DELETE /v1/data/payments/secrets/db-password
-> 204

POST /v1/data/payments/secrets/db-password/recover
-> 200 { "status": "active", ... }

POST /v1/data/payments/secrets/db-password/purge
-> 204
```

Values are at most 65,536 decoded bytes; empty and whitespace-only values return 422. A
replayed `Idempotency-Key` returns the original written `version`. Metadata, lists, and errors
never contain a value. Purge returns 409 until the retention boundary passes and protection is
off, and 503 when `OPENVAULT_PURGE_DB_URL` is not configured. The full behavior is in the
[secrets guide](/guide/secrets).

### Certificates

```http
POST /v1/data/payments/certificates/import
{ "name": "tls-server", "certificatePem": "-----BEGIN CERTIFICATE-----...",
  "chainPem": "-----BEGIN CERTIFICATE-----...",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----...", "allowNotYetValid": false,
  "tags": { "owner": "payments" } }
-> 201 { "name": "tls-server", "subject": "CN=...", "sans": ["DNS:..."],
          "issuer": "...", "serial": "...", "fingerprint": "<64 lowercase hex>",
          "notBefore": "...", "notAfter": "...", "daysToExpiry": 364,
          "chainLength": 2, "version": { "id": "01J...", ... },
          "certificatePem": "...", "chainPem": "...", "warnings": [],
          "capabilities": { ... } }

POST /v1/data/payments/certificates/generate
{ "name": "tls-server", "subject": "CN=payments.internal",
  "sans": ["DNS:payments.internal"], "keyType": "ec-p256", "validityDays": 365 }
-> 201/200 { ...metadata..., "certificatePem": "...", "chainPem": "", "warnings": [] }

GET /v1/data/payments/certificates/tls-server
-> 200 { ...metadata..., "certificatePem": "...", "chainPem": "..." }

GET /v1/data/payments/certificates/tls-server/private-key
-> 200 { "privateKeyPem": "-----BEGIN PRIVATE KEY-----...", "version": { ... },
          "fingerprint": "...", "name": "tls-server", "capabilities": { ... } }

GET /v1/data/payments/certificates?q=payments&san=DNS:payments.internal&limit=50
-> 200 { "certificates": [ { "name": "tls-server", ... } ], "nextCursor": null }

PATCH /v1/data/payments/certificates/tls-server
{ "tags": { "owner": "payments" }, "purgeProtected": true }
-> 200 { ... }

DELETE /v1/data/payments/certificates/tls-server
-> 204

POST /v1/data/payments/certificates/tls-server/recover
-> 200 { "status": "active", ... }

POST /v1/data/payments/certificates/tls-server/purge
-> 204
```

Import/generate are create-or-renew by name: a new name returns 201 and an active name returns
200 with a new immutable version. `?version=<ulid>` reads a selected version; an expired current
version returns 410 unless explicitly selected. Metadata and lists never contain a PEM body or
private key. `certificate.read` returns the public chain; `certificate.read_private` is required
for the private key and returns 403 for a caller with only public read. A deleted name is
reserved until purge; pass `expectedVersionId` to reject a stale renewal. Purge requires a
deleted certificate, passed retention, no protection, and `OPENVAULT_PURGE_DB_URL`; a deleted
project blocks purge. The full behavior is in the [certificates guide](/guide/certificates).


### Audit

| Method | Path | Action |
|---|---|---|
| GET | `/v1/audit/events` | `audit.read` |
| GET | `/v1/audit/verify` | `audit.read` |
| GET | `/v1/audit/export` | `audit.read` |

`GET /v1/audit/events` accepts `from`, `to`, `actorId`, `action`, `objectType`, `objectId`,
`result`, `requestId`, `projectId`, `limit` (1–500, default 100), and `cursor`. Results are
newest first. `objectId` requires `objectType`.

```http
GET /v1/audit/events?action=secret.read&result=deny&limit=50
-> 200 { "success": true, "data": { "events": [...], "nextCursor": "..." } }
```

`GET /v1/audit/verify` returns `ok`, `checkedRange`, `firstBrokenEventId`, and a stable
`reason`. A broken chain is still HTTP 200 with `ok: false`. `GET /v1/audit/export` streams
`application/x-ndjson` in ascending order and records the attempt before the first byte.

Limits are 60 event queries, 10 verifications, and 5 exports per minute per principal.
Invalid filters or cursors return 422; a project outside the caller's grant or an
organization-only verify returns 403; storage or audit-key failures return 503.

### Operational

`GET /health` is provided by WebAFX. `GET /ready` checks the database, keyring, TLS/CA
material, CA signing key loaded at startup (including a sign/verify probe), and audit table.

## Status codes

| Code | Meaning |
|---|---|
| 400 | Invalid request body or a failed OIDC callback (`oidc_callback_failed`) |
| 401 | Missing or invalid credential (`authentication_required`, `invalid_credentials`, or `join_failed`) |
| 403 | Policy denial, `csrf_invalid`, `password_change_required`, or `access_denied` |
| 404 | Unknown or hidden object, `identity_not_found`, or `oidc_not_configured` |
| 409 | Duplicate, last-admin, or `renewal_not_due`/`identity_name_conflict` conflict |
| 413 | Payload too large |
| 422 | WebAFX route validation failure, including an invalid CSR or consumer metadata |
| 429 | Rate limited (`RATE_LIMIT_EXCEEDED`) |
| 500 | Integrity failure or unexpected error |
| 503 | Database, audit, CA signing key, or identity provider unavailable (`oidc_unavailable`) |

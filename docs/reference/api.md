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
    "requestId": "6f1c..."
  },
  "requestId": "6f1c...",
  "path": "/v1/data/demo/secrets/db-password"
}
```

Request ids use the `X-Request-ID` header. Errors never contain secret values or stack
traces.

## Authentication

| Caller | Method |
|---|---|
| Browser | `__Host-ov_session` cookie plus `X-CSRF-Token` on mutations |
| CLI | `Authorization: Bearer <jwt>` |
| Agent | mTLS client certificate |

The browser session cookie is `__Host-ov_session`: HttpOnly, Secure, SameSite=Lax, Path=/,
and no Domain. Session ids are 32 random bytes stored only as a SHA-256 hash. The absolute
lifetime is `OPENVAULT_SESSION_TTL_HOURS` (default 8). Refresh rotates the secret and CSRF
token. OIDC login additionally uses a short-lived `__Host-ov_oidc` binding cookie; the
callback rejects a flow without the matching binding.

A failed local login returns `401 invalid_credentials` with the same body for an unknown
user, a wrong password, a disabled principal, or a locked account. Five failures in a
rolling 15-minute window lock the account for 15 minutes. Login is limited to 5/min per IP
and 10/hour per account; a rejected limit returns `429 RATE_LIMIT_EXCEEDED`.

While `mustChangePassword` is true, only `GET /v1/auth/me`, `POST /v1/auth/password`,
`POST /v1/auth/logout`, and `GET /v1/meta/*` are allowed. Other authenticated routes return
`403 password_change_required`.

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
| POST | `/v1/auth/cli/login` | Returns a JWT pair |
| POST | `/v1/auth/cli/refresh` | Rotates the JWT pair |
| POST | `/v1/auth/cli/logout` | Revokes the refresh family |
| POST | `/v1/agent/join` | Join token plus CSR |
| POST | `/v1/agent/renew` | mTLS renewal |

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
| POST | `/v1/admin/identities/:id/revoke` | `identity.revoke` |
| POST | `/v1/admin/identities/:id/join-tokens` | `identity.join_token` |
| GET | `/v1/admin/assignments` | `assignment.read` |
| POST | `/v1/admin/assignments` | `assignment.write` |
| DELETE | `/v1/admin/assignments/:id` | `assignment.write` |
| GET | `/v1/admin/access-explain` | `assignment.read` |
| POST | `/v1/admin/kek/rotate` | `kek.rotate` |

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
| DELETE | `/v1/data/:project/certificates/:name` | `certificate.delete` |
| POST | `/v1/data/:project/certificates/:name/recover` | `certificate.recover` |
| POST | `/v1/data/:project/certificates/:name/purge` | `certificate.purge` |

### Audit

| Method | Path | Action |
|---|---|---|
| GET | `/v1/audit/events` | `audit.read` |
| GET | `/v1/audit/verify` | `audit.read` |
| GET | `/v1/audit/export` | `audit.read` |

### Operational

`GET /health` is provided by WebAFX. `GET /ready` checks the database and keyring.

## Status codes

| Code | Meaning |
|---|---|
| 400 | Invalid request body or a failed OIDC callback (`oidc_callback_failed`) |
| 401 | Missing or invalid credential (`authentication_required` or `invalid_credentials`) |
| 403 | Policy denial, `csrf_invalid`, `password_change_required`, or `access_denied` |
| 404 | Unknown or hidden object, or `oidc_not_configured` |
| 409 | Duplicate or last-admin conflict |
| 413 | Payload too large |
| 422 | WebAFX route validation failure |
| 429 | Rate limited (`RATE_LIMIT_EXCEEDED`) |
| 500 | Integrity failure or unexpected error |
| 503 | Database, audit, or identity provider unavailable (`oidc_unavailable`) |

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

## Routes

### Authentication

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/auth/login` | Redirects to OIDC |
| GET | `/v1/auth/callback` | OIDC callback |
| POST | `/v1/auth/local/login` | Local password; sets session |
| POST | `/v1/auth/logout` | Clears session |
| GET | `/v1/auth/me` | Session user and CSRF token |
| POST | `/v1/auth/refresh` | Rotates the session |
| POST | `/v1/auth/cli/login` | Returns a JWT pair |
| POST | `/v1/auth/cli/refresh` | Rotates the JWT pair |
| POST | `/v1/auth/cli/logout` | Revokes the refresh family |
| POST | `/v1/agent/join` | Join token plus CSR |
| POST | `/v1/agent/renew` | mTLS renewal |

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
| 401 | Missing or invalid credential |
| 403 | Policy denial |
| 404 | Unknown or hidden object |
| 409 | Duplicate or last-admin conflict |
| 413 | Payload too large |
| 422 | Validation failure |
| 429 | Rate limited |
| 500 | Integrity failure or unexpected error |
| 503 | Database or audit unavailable |

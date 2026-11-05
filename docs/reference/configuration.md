# Configuration

Configuration is read from environment variables, validated at boot, and passed to the
WebAFX application. Missing required values stop startup before migrations or a listener
bind. The server requires Node.js 24.7 or newer (the built-in Argon2 API).

| Variable | Default | Required | Notes |
|---|---|---|---|
| `ENV_MODE` | `production` | no | `production`, `development`, or `test` |
| `OPENVAULT_BASE_URL` | — | yes | Absolute HTTPS URL; no credentials, query, or fragment |
| `OPENVAULT_ADMIN_PORT` | `8443` | no | Canonical admin HTTPS port |
| `PORT` | — | no | Compatibility alias for `OPENVAULT_ADMIN_PORT`; a conflict is an error |
| `OPENVAULT_AGENT_PORT` | `8444` | no | Agent TLS port; join is token-authenticated, other routes are mTLS; must differ from the admin port |
| `OPENVAULT_DB_URL` | — | yes | PostgreSQL connection string |
| `OPENVAULT_KEYRING` | — | yes | Absolute path to a regular file with mode `0600` |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | none | no | Reserved for age keyrings; setting it fails closed in the current release |
| `OPENVAULT_TLS_CERT` | — | yes | Readable server certificate PEM |
| `OPENVAULT_TLS_KEY` | — | yes | Readable private-key PEM that matches the certificate |
| `OPENVAULT_INTERNAL_CA` | — | yes | Readable public CA certificate with `CA:TRUE` and a valid self-signature; the private key is wrapped in `ca_keys` |
| `OPENVAULT_OIDC_ISSUER` | none | no | HTTPS URL; enables OIDC |
| `OPENVAULT_OIDC_CLIENT_ID` / `_SECRET` | none | with OIDC | Non-empty when an issuer is set |
| `OPENVAULT_OIDC_REDIRECT_URL` | `${BASE_URL}/v1/auth/callback` | no | HTTPS URL |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | none | no | Comma-separated domain allowlist |
| `OPENVAULT_SECRET_MAX_BYTES` | `65536` | no | 1024–65536; decoded value limit enforced by the secret routes |
| `OPENVAULT_PURGE_DB_URL` | none | no | Dedicated `openvault_purger` PostgreSQL URL used only by secret and certificate purge |
| `OPENVAULT_CERT_MAX_BYTES` | `131072` | no | 1024–131072; combined public chain bound; the private key is separately limited to 16,384 bytes |
| `OPENVAULT_CERT_EXPIRY_HOUR` | `3` | no | 0–23 UTC; daily expiry-scan hour |
| `OPENVAULT_CERT_EXPIRY_WEBHOOK_URL` | none | no | HTTPS URL (loopback HTTP outside production); credentials, fragments, and production link-local/metadata targets are rejected |
| `OPENVAULT_CERT_EXPIRY_WEBHOOK_SECRET` | none | no | 16–256 characters; adds `X-OpenVault-Timestamp` and an HMAC signature; never logged or redacted-exposed |
| `OPENVAULT_SOFT_DELETE_DAYS` | `30` | no | 7–90 |
| `OPENVAULT_AUDIT_RETENTION_DAYS` | `180` | no | 30–3650 |
| `OPENVAULT_JOIN_TOKEN_TTL` | `15m` | no | 1m–24h; default join-token lifetime; an admin request may override it up to 24 hours |
| `OPENVAULT_CERT_TTL_DAYS` | `30` | no | 1–90; workload certificate lifetime; renewal is at two thirds of the issued lifetime |
| `OPENVAULT_SESSION_TTL_HOURS` | `8` | no | 1–24 |
| `OPENVAULT_LOG_LEVEL` | `info` | no | `error`, `warn`, `info`, or `debug` |
| `OPENVAULT_TRUST_PROXY` | `true` | no | Trust forwarded headers only from peers in `OPENVAULT_PROXY_CIDRS` |
| `OPENVAULT_PROXY_CIDRS` | `172.16.0.0/12` | no | Comma-separated IPv4/IPv6 CIDRs; canonical network addresses only |

`OPENVAULT_ADMIN_PORT` wins over `PORT`. If both are set and differ, startup fails with a
keyed error. The agent port must differ from the resolved admin port.

`OPENVAULT_SESSION_TTL_HOURS` is an absolute lifetime measured from session creation, not a
sliding idle timeout. `OPENVAULT_OIDC_ALLOWED_DOMAINS` enables JIT provisioning; without it,
OIDC identities must already be linked. JIT also requires `email_verified: true` and an exact
domain match.

## Audit maintenance

Pruning and checkpoint export are separate server-side commands. They read the same server
configuration as the process and the prune command additionally reads:

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_PRUNE_DB_URL` | — | for `audit:prune` | PostgreSQL URL for the dedicated `openvault_pruner` session |

Deployment must create a login role named `openvault_pruner` and grant it `SELECT, DELETE`
on `audit_events`. The delete predicate reads the `id` column, so `DELETE` alone is not
enough. Do not grant `UPDATE`, `TRUNCATE`, or ownership. The prune credential can delete any
audit prefix at any time without writing a prune event, and its export file contains every
tenant's events; treat the URL and file as high-value secrets. The application role must
also be a non-owner, non-superuser role for the append-only trigger to be effective; the
migration owner or a superuser can disable it. Run maintenance on the vault host, or supply
the same database, keyring, TLS/CA, and base URL settings as the server. The prune command
checks that its connection targets the same database that was verified and exported.

## Body limits

The HTTP JSON parser accepts up to 1 MiB, with per-path guards: 64 KiB for the legacy
`/v1/secrets*` paths, 512 KiB for `/v1/data*` (sized for worst-case JSON escaping of a 64 KiB
value), and 128 KiB for other JSON under `/v1`. `OPENVAULT_SECRET_MAX_BYTES` and
`OPENVAULT_CERT_MAX_BYTES` are decoded product-value limits; the decoded bytes remain the
authoritative check.

Requests with a non-JSON body under `/v1` are rejected with `415`.

## Secret and certificate purge

Secret and certificate purge need a dedicated login role named `openvault_purger`, because
the database trigger rejects deletes from the application role. Set `OPENVAULT_PURGE_DB_URL` to
that role's URL and grant:

```sql
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificates TO openvault_purger;
GRANT SELECT, DELETE ON certificate_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificate_expiry_notifications TO openvault_purger;
```

Do not make the role a superuser, a table owner, or a member of any owner role. The server
verifies the database, session user, current user, superuser status, ownership, and role
memberships on every purge.
Without a valid URL the server still starts and only purge returns 503. The URL is a high-value
secret and is not included in the redacted configuration or logs.

## Certificate expiry

The expiry job runs once per UTC day at `OPENVAULT_CERT_EXPIRY_HOUR`. It considers only the
current version of an active certificate in an active project and sends one warning per
`(version, 30/14/7-day threshold)`. Set `OPENVAULT_CERT_EXPIRY_WEBHOOK_URL` to deliver warnings;
without it, warnings are logged and audited with `webhook: "skipped"`.

The webhook receives public metadata only. With `OPENVAULT_CERT_EXPIRY_WEBHOOK_SECRET`, the
request carries `X-OpenVault-Timestamp` and `X-OpenVault-Signature:
sha256=<HMAC-SHA256(secret, timestamp + "." + rawBody)>`. A failed delivery is retried on a
later run. The notification table makes the claim durable; a crash after a claim is recovered
after a one-hour lease on a later run.

## Keyring

The keyring is a JSON file outside PostgreSQL:

```json
{
  "version": 1,
  "current": "k2",
  "keys": {
    "k1": "base64-32-bytes",
    "k2": "base64-32-bytes"
  }
}
```

The path is required and must be an absolute path to a regular file with exact mode
`0600`. Group- or world-readable files stop startup.

Age-encrypted keyrings are deferred to a later release. Setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` fails closed with an unsupported-feature error; there is
no plaintext fallback. The reference stack is not bootable until the `ov init` provisioner
CLI and backup/rotation releases create the keyring file.

## Workload CA

The public CA certificate at `OPENVAULT_INTERNAL_CA` must match the CA key stored in
`ca_keys`. The key is a P-256 scalar wrapped by the current KEK; it is never a file and is
never returned. The deployment provisioner generates the CA once. Re-running the provisioner
does not rotate it. Startup fails closed if the row is missing, the KEK cannot unwrap it, or it does not match
the public certificate. `/ready` signs and verifies a short test certificate with the loaded
key; it does not re-read the row. KEK rotation and backup/restore are later releases; they
must re-wrap and restore the wrapped `ca_keys` row together with the public certificate.

## Readiness

| Endpoint | Semantics |
|---|---|
| `GET /health` | Liveness only; remains 200 during a dependency outage |
| `GET /ready` | PostgreSQL, keyring, TLS/CA, CA signing key loaded at startup (including a sign/verify probe), and audit-table probes; 200 or 503 `not_ready` |

`/v1/ready` is not part of the contract. The readiness database probe uses a 2-second
connection timeout and a bounded outer timeout.

## Proxy trust

Only set `OPENVAULT_TRUST_PROXY=true` when the server is reachable exclusively through the
proxy. The reference Compose stack uses a dedicated `admin_net` and a single pinned proxy
address:

```text
OPENVAULT_PROXY_CIDRS=172.30.0.2/32
```

Forwarded headers from any other source are ignored. Loopback peers may call only `/health`
and `/ready` so container health checks work.

## TLS and headers

The admin listener is HTTPS only and uses TLS 1.2 or newer. The agent listener accepts a
client certificate chained to `OPENVAULT_INTERNAL_CA` on every route except
`POST /v1/agent/join`; join is token-authenticated. The server does not own the public HSTS
contract; Caddy sets HSTS and the public client/upstream timeouts.

## Agent configuration

The `ov-agent` binary reads its own environment. These variables are separate from the
server's configuration.

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_URL` | — | yes | HTTPS origin of the agent listener; no credentials, path, query, or fragment |
| `OPENVAULT_CA_FILE` | — | yes | PEM bundle that verifies the vault server |
| `OPENVAULT_JOIN_TOKEN` | none | first start | One-time 43-character base64url token; not stored |
| `OPENVAULT_PROJECT` | — | yes | OpenVault project name |
| `OPENVAULT_SERVICE` | — | yes | Service identity name |
| `COMPOSE_PROJECT_NAME` | — | yes | Compose project name |
| `OPENVAULT_MANIFEST` | `/etc/openvault/manifest.yaml` | no | Absolute manifest path |
| `OPENVAULT_OUTPUT_DIR` | `/run/secrets` | no | Absolute output root; the manifest must equal it |
| `OPENVAULT_STATE_DIR` | `/var/lib/openvault` | no | Absolute state directory; mode `0700` |
| `OPENVAULT_STATUS_FILE` | `/run/openvault/status.json` | no | Absolute value-free status file |
| `OPENVAULT_SOCKET_PATH` | `/run/openvault/agent.sock` | no | Absolute read-only unix socket |

The manifest `project`, `service`, and `output_dir` must equal the environment. `refresh` is
30s–24h (default 300s), and each entry has a safe `file` or `env` target plus an optional
`mode` and `optional` flag. `ov-agent health` reads the status file; `--ready` is the Compose
health gate and exits 0 when every required entry is delivered.

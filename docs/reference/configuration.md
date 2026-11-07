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
| `OPENVAULT_DB_URL` | — | one URL form | Runtime PostgreSQL connection string; the server connects as `openvault_app` |
| `OPENVAULT_DB_URL_FILE` | — | one URL form | Read the runtime URL from a regular file that is not group- or world-writable; Docker secrets are `0444` and work |
| `OPENVAULT_MIGRATION_DB_URL` | none | no | Migrator URL used for startup DDL; must target the same host, port, and database |
| `OPENVAULT_MIGRATION_DB_URL_FILE` | none | no | File form of the migrator URL |
| `OPENVAULT_KEYRING` | — | yes | Absolute path to a regular file with mode `0600` |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | none | no | Reserved for age keyrings; setting it fails closed in the current release |
| `OPENVAULT_TLS_CERT` | — | yes | Readable server certificate PEM |
| `OPENVAULT_TLS_KEY` | — | yes | Readable private-key PEM that matches the certificate |
| `OPENVAULT_INTERNAL_CA` | — | yes | Readable public CA certificate with `CA:TRUE` and a valid self-signature; the private key is wrapped in `ca_keys` |
| `OPENVAULT_OIDC_ISSUER` | none | no | HTTPS URL; enables OIDC |
| `OPENVAULT_OIDC_CLIENT_ID` / `_SECRET` | none | with OIDC | Non-empty when an issuer is set |
| `OPENVAULT_OIDC_REDIRECT_URL` | `${BASE_URL}/v1/auth/callback` | no | HTTPS URL |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | none | no | Comma-separated domain allowlist |
| `OPENVAULT_OIDC_ENDPOINT_ORIGINS` | issuer origin | no | Comma-separated HTTPS origins allowed for authorization, token, JWKS, and UserInfo endpoints |
| `OPENVAULT_SECRET_MAX_BYTES` | `65536` | no | 1024–65536; decoded value limit enforced by the secret routes |
| `OPENVAULT_AUTH_DB_URL` | app URL in development/test | production | Dedicated `openvault_auth` PostgreSQL URL for control-plane writes |
| `OPENVAULT_AUTH_DB_URL_FILE` | none | no | File form of the auth URL |
| `OPENVAULT_BACKUP_DB_URL` | none | for `ov backup` | Dedicated read-only `openvault_backup` URL used for the logical dump |
| `OPENVAULT_BACKUP_DB_URL_FILE` | none | no | File form of the backup URL |
| `OPENVAULT_PURGE_DB_URL` | none | no | Dedicated `openvault_purger` PostgreSQL URL used only by secret and certificate purge |
| `OPENVAULT_PURGE_DB_URL_FILE` | none | no | File form of the purge URL |
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
| `OPENVAULT_RUN_MIGRATIONS` | `true` | no | Run startup migrations; set `false` when a one-shot init job already migrated |
| `OPENVAULT_PROXY_CIDRS` | `127.0.0.1/32,::1/128` | no | Comma-separated IPv4/IPv6 CIDRs; set the proxy address explicitly in a multi-container deployment |

`OPENVAULT_ADMIN_PORT` wins over `PORT`. If both are set and differ, startup fails with a
keyed error. The agent port must differ from the resolved admin port.

`OPENVAULT_DB_URL_FILE`, `OPENVAULT_MIGRATION_DB_URL_FILE`,
`OPENVAULT_AUTH_DB_URL_FILE`, `OPENVAULT_BACKUP_DB_URL_FILE`, and
`OPENVAULT_PURGE_DB_URL_FILE` read the URL from a file instead of the environment. The file
must be a regular file and must not be group- or world-writable; Docker secrets mount as
`0444`. Setting both the direct and file forms is an error. The migrator, auth, backup, and
purge URLs must target the same host, port, and database as `OPENVAULT_DB_URL`; they may use a
different role.

`OPENVAULT_SESSION_TTL_HOURS` is an absolute lifetime measured from session creation, not a
sliding idle timeout. The auth URL must target the same database as `OPENVAULT_DB_URL`.
`OPENVAULT_OIDC_ALLOWED_DOMAINS` enables JIT provisioning; without it,
OIDC identities must already be linked. JIT also requires `email_verified: true` and an exact
domain match.

## CLI and bootstrap

The `ov` client reads its own connection settings. These variables are separate from the
server process.

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_URL` | none | for `ov login` and `ov doctor` | HTTPS origin of the public API; no credentials, path, query, or fragment |
| `OPENVAULT_CA_FILE` | none | recommended | PEM bundle that verifies the server; must match the proxy's certificate chain |
| `OPENVAULT_BACKUP_PASSPHRASE_FILE` | none | for non-interactive backup/restore | `0600` file with the archive passphrase; at least 12 characters |
| `OPENVAULT_RESTORE_DB_URL` | `OPENVAULT_MIGRATION_DB_URL` or `OPENVAULT_DB_URL` | for restore | Owner/migrator URL used to disable triggers, truncate, and load rows |
| `OPENVAULT_RESTORE_DB_URL_FILE` | none | for restore | File form of the restore URL |
| `OPENVAULT_RESTORE_AGENT_CERTIFICATE` | none | no | Pre-backup agent certificate PEM verified after restore |
| `OPENVAULT_BACKUP_DIR` | none | for `ov doctor` | Directory checked against the 24-hour RPO |
| `OPENVAULT_WEB_ROOT` | `apps/web/dist` beside the server | no | Built SPA directory; when absent the server runs API-only |
| `OPENVAULT_DEV_URL` | `https://localhost:8443` | dev only | Vite proxy target for local UI development |

The bootstrap command `ov init` reads the server database and file settings from the
environment. It never accepts the database URL as a command-line option, because a PostgreSQL
URL usually contains a password.

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_DB_URL` | none | yes | Application runtime URL; the app role cannot perform bootstrap writes |
| `OPENVAULT_MIGRATION_DB_URL` | `OPENVAULT_DB_URL` | for `ov init` | Migrator/owner URL used for DDL and bootstrap data writes; must target the same database |
| `OPENVAULT_KEYRING` | none | yes | Absolute keyring path; created atomically with mode `0600` when absent |
| `OPENVAULT_INTERNAL_CA` | derived from the TLS certificate directory | yes | Public internal CA path |
| `OPENVAULT_CA_PUBLIC_DIR` | none | no | Directory that receives `ca.pem` for the proxy |
| `OPENVAULT_TLS_CERT` / `OPENVAULT_TLS_KEY` | none | for TLS provisioning | Server certificate and PKCS#8 key paths; both or neither |
| `OPENVAULT_BASE_URL` | `https://localhost` | no | HTTPS origin used for server-certificate SANs |
| `OPENVAULT_ORG_NAME` | `OpenVault` | no | Organization display name |
| `OPENVAULT_BOOTSTRAP_ADMIN_NAME` | `OpenVault Administrator` | no | Administrator display name |
| `OPENVAULT_BOOTSTRAP_ADMIN_EMAIL` | `admin@openvault.local` | no | Administrator email |
| `OPENVAULT_BOOTSTRAP_PASSWORD_FILE` | none | one password mode | Operator-supplied `0600` password file |
| `OPENVAULT_BOOTSTRAP_PASSWORD_OUTPUT` | beside the keyring | no | One-time generated password path |

`ov init --prepare` implies `--generate-password` and derives the paths from the environment;
it is the reference Compose provisioner. The generated password is written once with mode
`0600` and is never printed. Re-running init does not rotate the CA or replace an existing
administrator password. If the keyring is missing but wrapped state exists, init fails closed
and asks for a restore from backup.

## Backup, restore, and KEK rotation

`ov backup` requires `OPENVAULT_BACKUP_DB_URL` for the read-only logical dump,
`OPENVAULT_DB_URL` for the `backup.create` audit event, `OPENVAULT_KEYRING`, and
`OPENVAULT_INTERNAL_CA` (or a `ca.pem` beside `OPENVAULT_TLS_CERT`). The dump connection is
refused if it is the `openvault_app` or `openvault_auth` role or cannot read the control-plane
tables. The archive is encrypted
with age using the passphrase from `--passphrase-file`, `OPENVAULT_BACKUP_PASSPHRASE_FILE`, or
an interactive hidden prompt. The v0.1 archive contains a logical JSON row dump, the raw
keyring, a redacted configuration manifest, the public CA, and audit checkpoints. It is not a
`pg_dump` custom-format archive.

`ov restore` uses `OPENVAULT_RESTORE_DB_URL` for migrations and data loading. It must target
the same database as `OPENVAULT_DB_URL`, and that role must own the tables so user triggers can
be disabled. Stop the server during restore. The target must be empty unless `--force` is
supplied, and `--yes` is required in a non-interactive session. The command verifies the
archive checksums, every current secret and certificate private key, the JWT signing key, the
audit chain, and the CA key before reporting success. `--agent-certificate` adds the pre-backup
agent certificate check.

`ov kek rotate` also needs table ownership. Stop the server first: a running process holds the
old keyring in memory and could write a row with the old `kek_id` after the CLI's verification.
The command removes the old key only after every key table has been checked.

## Web UI serving

The server serves the built SPA when `OPENVAULT_WEB_ROOT` (or the default `apps/web/dist`)
contains `index.html` and `assets`. Hashed assets are immutable for one year; `index.html` is
not cached; unmatched `GET` HTML routes fall back to the SPA. Unknown API routes remain JSON
404s. If the build is absent the server starts normally and serves no UI.

The UI-enabled CSP allows same-origin scripts, connections, images, fonts, and inline style
elements. Scripts are same-origin only and `unsafe-eval` is never allowed. API-only mode keeps
the deny-by-default policy.

For local development, `pnpm --filter @openvault/web dev` proxies `/v1` to
`OPENVAULT_DEV_URL`, disables verification for the local certificate, and rewrites
`Origin`/`Referer` to `OPENVAULT_BASE_URL`.

## Audit maintenance

`ov audit checkpoint --out <file>` exports the newest checkpoint using
`OPENVAULT_DB_URL` or `OPENVAULT_DB_URL_FILE`. It is safe to schedule and does not modify
the chain. Pruning is a separate server-side command. It reads the same server
configuration as the process and additionally reads:

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_PRUNE_DB_URL` | — | for `audit:prune` | PostgreSQL URL for the dedicated `openvault_pruner` session |

Deployment must create a login role named `openvault_pruner` and grant it `EXECUTE` on
`public.openvault_prune_audit_prefix(text)`. Do not grant table, sequence, column, `UPDATE`,
`TRUNCATE`, or ownership privileges. The application verifies the retained chain, exports the
prefix, writes the boundary checkpoint, and inserts a short-lived single-use authorization;
the procedure consumes that authorization, re-checks the boundary and count, deletes the prefix,
and writes a completion receipt in one transaction. A holder of the pruner credential alone
cannot delete an audit prefix or write a checkpoint. The export file contains every tenant's
events; treat the URL and file as high-value secrets. Run maintenance on the vault host, or
supply the same database, keyring, TLS/CA, and base URL settings as the server. The prune
command checks that its connection targets the same database that was verified and exported.

## Body limits

The HTTP JSON parser accepts up to 1 MiB, with per-path guards: 64 KiB for the legacy
`/v1/secrets*` paths, 512 KiB for `/v1/data*` (sized for worst-case JSON escaping of a 64 KiB
value), and 128 KiB for other JSON under `/v1`. `OPENVAULT_SECRET_MAX_BYTES` and
`OPENVAULT_CERT_MAX_BYTES` are decoded product-value limits; the decoded bytes remain the
authoritative check.

Requests with a non-JSON body under `/v1` are rejected with `415`.

## Least-privilege database roles

| Role | Ownership | Purpose |
|---|---|---|
| `openvault_migrator` | Database, schema, tables | Migrations and restore |
| `openvault_app` | None | Data-plane runtime DML and explicit reads |
| `openvault_auth` | None | Control-plane authentication, RBAC, and agent-identity DML |
| `openvault_backup` | None | Read-only logical backup dump |
| `openvault_purger` | None | Controlled purge |
| `openvault_pruner` | None | Controlled audit prune; `EXECUTE` on the prune procedure only |

The server runs startup migrations with `OPENVAULT_MIGRATION_DB_URL` and then serves
traffic with `OPENVAULT_DB_URL`. The runtime role cannot create tables or delete audit
events. `deploy/postgres/grants.sql` asserts that the migrator owns every application
table, so a drifted deployment fails loudly instead of silently granting the runtime role
DDL. The app role has no access to `principals`, `local_credentials`,
`role_assignments`, `oidc_identities`, `cli_sessions`, `join_tokens`, `workload_certs`,
`consumers`, `policy_state`, or `org`; those are control-plane or credential tables. The app
role reads consumer summaries through the restricted `secret_consumer_summaries` view. Re-run
`grants.sql` after a migration that adds a table the runtime, purge, prune, or backup path
must access. The `openvault-roles` job runs `ensure-auth-role.sql` and
`ensure-backup-role.sql` on every deployment so an existing database also gets those roles.

## Secret and certificate purge

Secret and certificate purge need a dedicated login role named `openvault_purger`, because
the database trigger rejects deletes from the application role. The reference stack creates
all six roles with `deploy/postgres/roles.sql`, makes `openvault_migrator` the database and
table owner, and applies `deploy/postgres/grants.sql`. Set `OPENVAULT_PURGE_DB_URL` to that
role's URL or point `OPENVAULT_PURGE_DB_URL_FILE` at a Docker secret. The equivalent grants
are:

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
`0600`. The parent directory must be owned by the current user and must not be group- or
world-writable; `0700` is used when init creates it. A group- or world-readable file, or a
group- or world-writable directory, stops startup.

Age-encrypted keyrings are deferred to a later release. Setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` fails closed with an unsupported-feature error; there is
no plaintext fallback. `ov init` creates the keyring file; `ov backup`, `ov restore`, and `ov kek rotate` consume and replace it.

## Workload CA

The public CA certificate at `OPENVAULT_INTERNAL_CA` must match the CA key stored in
`ca_keys`. The key is a P-256 scalar wrapped by the current KEK; it is never a file and is
never returned. The deployment provisioner generates the CA once. Re-running the provisioner
does not rotate it. Startup fails closed if the row is missing, the KEK cannot unwrap it, or it does not match
the public certificate. `/ready` signs and verifies a short test certificate with the loaded
key; it does not re-read the row. `ov kek rotate` re-wraps the `ca_keys` row; `ov restore`
re-materializes the public certificate and verifies the restored CA key.

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

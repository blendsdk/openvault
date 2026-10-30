# Configuration

Configuration is read from environment variables, validated at boot, and passed to the
WebAFX application. Missing required values stop startup before migrations or a listener
bind.

| Variable | Default | Required | Notes |
|---|---|---|---|
| `ENV_MODE` | `production` | no | `production`, `development`, or `test` |
| `OPENVAULT_BASE_URL` | — | yes | Absolute HTTPS URL; no credentials, query, or fragment |
| `OPENVAULT_ADMIN_PORT` | `8443` | no | Canonical admin HTTPS port |
| `PORT` | — | no | Compatibility alias for `OPENVAULT_ADMIN_PORT`; a conflict is an error |
| `OPENVAULT_AGENT_PORT` | `8444` | no | Agent mTLS port; must differ from the admin port |
| `OPENVAULT_DB_URL` | — | yes | PostgreSQL connection string |
| `OPENVAULT_KEYRING` | — | yes | Absolute path to a regular file with mode `0600` |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | none | no | Reserved for age keyrings; setting it fails closed until RD-13 |
| `OPENVAULT_TLS_CERT` | — | yes | Readable server certificate PEM |
| `OPENVAULT_TLS_KEY` | — | yes | Readable private-key PEM that matches the certificate |
| `OPENVAULT_INTERNAL_CA` | — | yes | Readable CA certificate with `CA:TRUE` and a valid self-signature |
| `OPENVAULT_OIDC_ISSUER` | none | no | HTTPS URL; enables OIDC |
| `OPENVAULT_OIDC_CLIENT_ID` / `_SECRET` | none | with OIDC | Non-empty when an issuer is set |
| `OPENVAULT_OIDC_REDIRECT_URL` | `${BASE_URL}/v1/auth/callback` | no | HTTPS URL |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | none | no | Comma-separated domain allowlist |
| `OPENVAULT_SECRET_MAX_BYTES` | `65536` | no | Product-value limit, 1 KiB–1 MiB (RD-08) |
| `OPENVAULT_CERT_MAX_BYTES` | `131072` | no | Product-value limit, 1 KiB–2 MiB (RD-09) |
| `OPENVAULT_SOFT_DELETE_DAYS` | `30` | no | 7–90 |
| `OPENVAULT_AUDIT_RETENTION_DAYS` | `180` | no | 30–3650 |
| `OPENVAULT_JOIN_TOKEN_TTL` | `15m` | no | 1m–24h |
| `OPENVAULT_CERT_TTL_DAYS` | `30` | no | 1–90 |
| `OPENVAULT_SESSION_TTL_HOURS` | `8` | no | 1–24 |
| `OPENVAULT_LOG_LEVEL` | `info` | no | `error`, `warn`, `info`, or `debug` |
| `OPENVAULT_TRUST_PROXY` | `true` | no | Trust forwarded headers only from peers in `OPENVAULT_PROXY_CIDRS` |
| `OPENVAULT_PROXY_CIDRS` | `172.16.0.0/12` | no | Comma-separated IPv4/IPv6 CIDRs; canonical network addresses only |

`OPENVAULT_ADMIN_PORT` wins over `PORT`. If both are set and differ, startup fails with a
keyed error. The agent port must differ from the resolved admin port.

## Body limits

The transport boundary is fixed at 64 KiB for `/v1/secrets*` and 128 KiB for
`/v1/certificates*` and other JSON under `/v1`. `OPENVAULT_SECRET_MAX_BYTES` and
`OPENVAULT_CERT_MAX_BYTES` are product-value limits enforced by the secret and certificate
routes in RD-08/RD-09; they do not widen or narrow the HTTP parser.

Requests with a non-JSON body under `/v1` are rejected with `415`.

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

Age-encrypted keyrings are deferred to RD-13. Setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` fails closed with an unsupported-feature error; there is
no plaintext fallback. The reference stack is not bootable until the `ov init` provisioner
(RD-11/RD-13) creates the keyring file.

## Readiness

| Endpoint | Semantics |
|---|---|
| `GET /health` | Liveness only; remains 200 during a dependency outage |
| `GET /ready` | PostgreSQL, keyring, TLS/CA, and audit-table probes; 200 or 503 `not_ready` |

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

The admin listener is HTTPS only and uses TLS 1.2 or newer. The agent listener requires a
client certificate chained to `OPENVAULT_INTERNAL_CA`. The server does not own the public
HSTS contract; Caddy sets HSTS and the public client/upstream timeouts.

# Configuration

Configuration is read from environment variables, validated at boot, and passed to the
WebAFX application. Missing required values stop startup.

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OPENVAULT_BASE_URL` | — | yes | Public URL for OIDC redirects and cookies |
| `PORT` | `8443` | no | WebAFX listen port |
| `OPENVAULT_DB_URL` | — | yes | PostgreSQL connection string |
| `OPENVAULT_KEYRING` | `/etc/openvault/keyring.json` | no | KEK keyring |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | none | no | If the keyring is age-encrypted |
| `OPENVAULT_TLS_CERT` / `_KEY` | — | yes | Server certificate |
| `OPENVAULT_OIDC_ISSUER` | none | no | Enables OIDC |
| `OPENVAULT_OIDC_CLIENT_ID` / `_SECRET` | none | with OIDC | |
| `OPENVAULT_OIDC_REDIRECT_URL` | `${BASE_URL}/v1/auth/callback` | no | |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | none | no | If set, JIT provisioning is allowed |
| `OPENVAULT_SECRET_MAX_BYTES` | `65536` | no | 1 KiB–1 MiB |
| `OPENVAULT_CERT_MAX_BYTES` | `131072` | no | Certificate import limit |
| `OPENVAULT_SOFT_DELETE_DAYS` | `30` | no | 7–90 |
| `OPENVAULT_AUDIT_RETENTION_DAYS` | `180` | no | |
| `OPENVAULT_JOIN_TOKEN_TTL` | `15m` | no | Max 24h |
| `OPENVAULT_CERT_TTL_DAYS` | `30` | no | Workload certificates |
| `OPENVAULT_SESSION_TTL_HOURS` | `8` | no | Browser sessions |
| `OPENVAULT_LOG_LEVEL` | `info` | no | Mapped to WebAFX `LOG_LEVEL` |
| `OPENVAULT_TRUST_PROXY` | `true` | no | Trust forwarded headers only from the proxy |
| `OPENVAULT_PROXY_CIDRS` | `172.16.0.0/12` | no | Allowed forwarded-header sources |

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

Mode `0600`. Optionally age-encrypted with a passphrase supplied through
`OPENVAULT_KEYRING_PASSPHRASE_FILE`.

## Proxy trust

Only set `OPENVAULT_TRUST_PROXY=true` when the server is reachable exclusively through the
proxy. Otherwise a client can spoof `X-Forwarded-For` and defeat rate limiting.

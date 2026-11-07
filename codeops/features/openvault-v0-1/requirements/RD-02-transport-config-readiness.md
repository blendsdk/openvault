# RD-02: Transport, Configuration, and Readiness

> **Document**: RD-02-transport-config-readiness.md
> **Status**: Preflighted
> **Created**: 2026-10-29
> **Preflight**: [00-preflight-report-RD-02.md](00-preflight-report-RD-02.md) (2026-11-07)
> **Project**: OpenVault
> **Depends On**: RD-01
> **Integrates**: RD-03 (OIDC settings), RD-05 (agent identity, CA key), RD-07 (audit
> semantics), RD-08 (secret data route), RD-13 (age keyring, offline rotation)
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines how OpenVault reads configuration, terminates TLS, separates browser
and agent traffic, trusts forwarded headers, enforces request limits, and reports readiness.
It exists because the original scaffold silently ignored its documented configuration and
served plain HTTP, which is not safe for a secrets product.

RD-02 owns the transport and configuration boundary. Later RDs own the policy and product
behavior that runs on that boundary; the [Staged ownership](#staged-ownership) table records
which acceptance criterion belongs to which owner.

## Functional Requirements

### Must Have

- [ ] A typed configuration loader reads `process.env`, validates every RD-02 variable with
  Zod, and refuses to start on missing or malformed required values.
- [ ] A TLS admin listener is reachable only from the configured reverse-proxy CIDRs. Loopback
  peers may call only `/health` and `/ready`, so container health checks work without opening
  the admin API.
- [ ] A separate agent listener serves the token-authenticated join route and requires a live
  client certificate signed by the internal CA on every other agent route. Certificate and
  principal state is checked on every request, subject to the RD-05 positive cache bounded to
  5 seconds; no request succeeds more than 5 seconds after a revocation commits.
- [ ] There is no plaintext HTTP listener and no published `8443` port.
- [ ] Proxy trust is limited to the configured proxy CIDRs. Forwarded headers from any other
  source are ignored and the socket address is used for attribution. The default CIDR list is
  loopback only; a multi-container deployment must pin the proxy address explicitly.
- [ ] Security headers include a strict API CSP, the documented UI CSP profile, Helmet
  defaults, no `X-Powered-By`, and HSTS at the proxy.
- [ ] Request bodies use a layered limit: a 512 KiB JSON parser ceiling on `/v1/data*`, a
  128 KiB ceiling on other JSON under `/v1`, and decoded product limits of 64 KiB for secret
  values, 128 KiB for certificate chains, and 16 KiB for certificate private keys.
  `application/x-www-form-urlencoded` is disabled for the JSON API.
- [ ] Request and header timeouts are set at the proxy and server.
- [ ] The API uses the WebAFX envelopes: `{ success: true, data }` on success and
  `{ success: false, error: { code, message, statusCode, timestamp, requestId, path } }` on
  failure. `requestId` and `path` are inside `error`; there are no top-level copies.
- [ ] The API base path is `/v1`; a breaking change requires a new path prefix.
- [ ] CORS is disabled; the UI and API are same-origin.
- [ ] Server and agents require NTP. CLI access tokens are accepted within an inclusive
  ±30-second window. Agent certificates are backdated 30 seconds at issuance and their
  validity is evaluated against the server clock with no additional grace.
- [ ] The keyring API never returns raw key buffers to server callers; key use is scoped to a
  synchronous callback. Serialization and inspection are redacted. Shutdown and failed
  startup zeroize best-effort; KEK rotation is an offline operation with the server stopped.
- [ ] Production server artifacts contain no source maps.
- [ ] `/health` reports liveness. `/ready` checks PostgreSQL, the loaded keyring, the loaded
  TLS/CA material, the audit table, and the loaded CA signer's ability to sign and verify a
  test certificate. Startup separately verifies that the wrapped CA key is present, unwraps,
  and matches the public certificate. Both endpoints return generic bodies without
  configuration.
- [ ] The keyring file must be an absolute path to a regular file with mode `0600`, owned by
  the runtime user, in a directory that is not group- or world-writable. The server refuses to
  start otherwise.
- [ ] Logs redact `value`, `privateKey`, `password`, `token`, `authorization`, `cookie`, and
  `set-cookie`, plus the additional credential fields in the logging configuration.
- [ ] Error responses never include stack traces, SQL, filesystem paths, or key material.

### Should Have

- [ ] A redacted configuration dump for support: `ov config show --redacted` prints
  `toRedactedConfig(loadConfig(process.env))` with no secret values.
- [ ] Startup error reporting records the failing environment key and a fixed reason without
  the value or file content.
- [ ] A test proves that both listeners reject a plaintext connection.

### Won't Have (Out of Scope)

- Automatic certificate reload without restart.
- Multiple admin listeners or multi-region routing.
- A public metrics endpoint.
- Age-encrypted keyrings in this RD; the passphrase variable is reserved and fails closed
  until the RD-13 age work lands.

## Technical Requirements

### Configuration

| Variable | Required | Default | Validation |
|---|---|---|---|
| `ENV_MODE` | no | `production` | `production`, `development`, or `test`; production suppresses stack traces |
| `OPENVAULT_BASE_URL` | yes | — | absolute HTTPS URL; no credentials, query, or fragment |
| `PORT` | no | — | compatibility alias for `OPENVAULT_ADMIN_PORT`; a differing pair is an error |
| `OPENVAULT_ADMIN_PORT` | no | `8443` | integer 1–65535; canonical admin port |
| `OPENVAULT_AGENT_PORT` | no | `8444` | integer 1–65535; must differ from the resolved admin port |
| `OPENVAULT_DB_URL` | yes | — | PostgreSQL URL; read a file form through `OPENVAULT_DB_URL_FILE` |
| `OPENVAULT_KEYRING` | yes | — | absolute path to a regular file with mode `0600` |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | no | — | reserved for age keyrings; must be unset in v0.1, setting it fails closed |
| `OPENVAULT_TLS_CERT` | yes | — | readable PEM chain; leaf must be currently valid, issued by the internal CA, include the `openvaultd` DNS name, and cover the base-URL host |
| `OPENVAULT_TLS_KEY` | yes | — | readable PEM private key that matches the certificate; any PEM key format is accepted |
| `OPENVAULT_INTERNAL_CA` | yes | — | readable PEM CA certificate that is currently valid, `CA:TRUE`, and self-verifying; the private key is only in `ca_keys` |
| `OPENVAULT_OIDC_ISSUER` | no | — | HTTPS URL |
| `OPENVAULT_OIDC_CLIENT_ID` | with OIDC | — | non-empty |
| `OPENVAULT_OIDC_CLIENT_SECRET` | with OIDC | — | non-empty |
| `OPENVAULT_OIDC_REDIRECT_URL` | no | `${BASE_URL}/v1/auth/callback` | HTTPS URL |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | no | — | comma-separated domains |
| `OPENVAULT_SECRET_MAX_BYTES` | no | `65536` | 1024–65536; decoded value limit |
| `OPENVAULT_CERT_MAX_BYTES` | no | `131072` | 1024–131072; combined leaf and chain bound |
| `OPENVAULT_SOFT_DELETE_DAYS` | no | `30` | 7–90 |
| `OPENVAULT_AUDIT_RETENTION_DAYS` | no | `180` | 30–3650 |
| `OPENVAULT_JOIN_TOKEN_TTL` | no | `15m` | 1m–24h |
| `OPENVAULT_CERT_TTL_DAYS` | no | `30` | 1–90 |
| `OPENVAULT_SESSION_TTL_HOURS` | no | `8` | 1–24 |
| `OPENVAULT_TRUST_PROXY` | no | `true` | boolean |
| `OPENVAULT_PROXY_CIDRS` | no | `127.0.0.1/32,::1/128` | CIDR list; a multi-container deployment must set the proxy address |
| `OPENVAULT_LOG_LEVEL` | no | `info` | `error`, `warn`, `info`, `debug` |

`OPENVAULT_ADMIN_PORT` is canonical. `PORT` is accepted only when it agrees with
`OPENVAULT_ADMIN_PORT`; if both are set and differ, startup fails. The agent port must differ
from the resolved admin port.

Variables added by later RDs — `OPENVAULT_AUTH_DB_URL`, `OPENVAULT_MIGRATION_DB_URL`,
`OPENVAULT_PURGE_DB_URL`, their `*_FILE` forms, `OPENVAULT_RUN_MIGRATIONS`,
`OPENVAULT_OIDC_ENDPOINT_ORIGINS`, and the certificate-expiry settings — are validated by the
same loader and documented in the configuration reference. They are not part of the RD-02
acceptance set.

### Listeners

```text
proxy (TLS) ──▶ admin listener (TLS, proxy CIDR only) ──▶ API + UI
agent ── TLS/token join + mTLS ──▶ agent listener (client cert required except token join)
  ──▶ join/renew/fetch
```

- The admin listener serves `/v1/*` and the static UI. It accepts direct traffic only from
  peers in `OPENVAULT_PROXY_CIDRS`, except that loopback peers may call `/health` and `/ready`.
- The agent listener serves `/v1/agent/*` and the agent-scoped
  `GET /v1/data/:project/secrets/:name` route. `POST /v1/agent/join` is token-authenticated
  and allowed without a client certificate. Every other agent route requires a live client
  certificate and checks fingerprint, expiry, revocation, principal status, and project status
  on every request, subject to the RD-05 positive cache bounded to 5 seconds. The data route
  requires the certificate principal's `owner_project_id` to equal the id of the project named
  by `:project`.
- The agent listener sets `requestCert: true` and `rejectUnauthorized: false` so the
  token-authenticated join can complete before a client certificate exists. A default-deny
  agent middleware is the certificate boundary for every protected route. The middleware is
  mounted globally before controller routing, exempts only the exact `POST /v1/agent/join`
  request, and denies any request that does not carry a listener marker.
- The agent listener scope admits the `/v1/data` prefix so the value read can be routed. The
  controller layer permits only `GET /v1/data/:project/secrets/:name` for an agent
  certificate; every other data route returns 401, and the negative boundary is tested.
- Both listeners validate the same principal, policy, and audit rules for their routes.
- `OPENVAULT_TRUST_PROXY=true` means trust the immediately connected proxy only when its
  source address is in `OPENVAULT_PROXY_CIDRS`; otherwise ignore forwarded headers. The
  default list is loopback only and does not include the Docker private range.

### Readiness

`GET /ready` returns 200 only when all of these are true:

1. PostgreSQL responds to `SELECT 1`.
2. The keyring is loaded and the current key is present.
3. The loaded server TLS certificate and private key still match; the loaded internal CA
   still parses, is currently valid, has `CA:TRUE`, and is self-verifying.
4. The audit table is reachable. A read-only check is allowed; no event is written.
5. The loaded CA signer can sign and verify a test certificate against the internal CA.

Startup independently requires the `ca_keys` row to be present, the wrapped scalar to unwrap
with the current KEK, the derived public key to match the configured CA certificate, and the
CA certificate to be currently valid with `CA:TRUE` and `pathlen:0`. Failure exits non-zero
before any listener binds; `/ready` does not re-read the row.

The readiness service runs its probes in parallel under a 2-second timeout. On any failure it
returns 503 with the WebAFX error envelope and code `not_ready`, with no internal details.

## Staged Ownership

RD-02 is delivered before RD-05, RD-08, and RD-13. The following table keeps one owner per
behavior and records where RD-02 verifies the boundary.

| Behavior | Owner | RD-02 verification |
|---|---|---|
| Agent certificate policy, fingerprint, expiry, revocation, principal and project state, 5-second cache | RD-05 | Listener-wide default-deny, exact join exception, project match on the data route |
| `ca_keys` custody, unwrap, public-key match, CA signer | RD-05 | Startup fail-closed and `/ready` sign/verify probe |
| Secret data route and product behavior | RD-08 | Agent listener route scope and `owner_project_id` match |
| Audit event semantics and writer | RD-07 | Audit table reachability only |
| Age-encrypted keyring and offline rotation | RD-13 | Passphrase variable fails closed; shutdown zeroization |
| OIDC flow and session behavior | RD-03 | Conditional configuration validation |

## Integration Points

- RD-03 uses the admin listener, session cookies, and the OIDC settings.
- RD-05 uses the agent listener, internal CA, `ca_keys`, and the 5-second certificate cache.
- RD-07 uses the database and the audit readiness check.
- RD-08 uses the `/v1/data/:project/secrets/:name` route on the agent listener.
- RD-10 and RD-12 consume the public base URL, CSP profile, and security headers.
- RD-13 owns age encryption, backup/restore, and offline KEK rotation.
- RD-14 tests both listeners, the proxy trust boundary, and the release security gates.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Transport | Single listener / split listeners / network only | Split admin + agent listeners | No shared cleartext bridge; distinct trust | AR-2 |
| Config failure | Warn / fail closed | Fail closed | A secrets service must not start half-configured | AR-19 |
| Proxy trust | Hop count / proxy CIDR / all | Proxy CIDR only, loopback default | Prevent IP spoofing and audit poisoning without trusting the Docker private range | AR-20 |
| Readiness | Liveness only / dependency checks | Dependency checks | Compose and operators need truthful state | AR-19 |
| Body limits | WebAFX default / literal 64/128 KiB / layered | Layered parser and decoded limits | Reduce unauthenticated DoS surface without rejecting valid escaped values | AR-21, PF-003 |
| Agent revocation | Per-request DB read / 5-second cache | 5-second cache | Bounds the revocation window while keeping request cost acceptable | RD-05 |

## Security Considerations

- **Data sensitivity:** configuration includes database credentials and the OIDC secret; the
  keyring path reveals key custody. Never log values. The v0.1 keyring is plaintext JSON
  protected by mode `0600`, the host boundary, and the backup encryption.
- **Input validation:** every RD-02 environment value is schema-validated; URLs, CIDRs, and
  file modes are parsed before any listener binds.
- **Authentication & authorization:** both listeners enforce their own credential type;
  route-level policy is applied by RD-03/RD-05/RD-06.
- **Injection risks:** no SQL from configuration; logs use structured fields; request paths
  are normalized once and rejected on malformed encoding or dot segments.
- **Encryption needs:** TLS 1.2 or newer on both listeners; mTLS for every agent route except
  the token-authenticated join; HSTS at the proxy.
- **Proxy boundary:** the default `OPENVAULT_PROXY_CIDRS` is loopback only. A broad range such
  as `172.16.0.0/12` is rejected as a default because it can include `db_net` and
  `vault_net`. The reference Compose stack pins the proxy to `172.30.0.2/32`.
- **Rate limiting:** listener-level connection limits (1024 admin, 512 agent) and route-level
  limits by the owning RD.
- **Infrastructure:** non-root, read-only rootfs, no published admin or agent port, proxy CIDR
  enforcement, and startup fail-closed for missing keyring, TLS, CA, or database material.
- **CSP:** API-only mode uses `default-src 'none'`. When the built SPA is present, the UI
  profile allows `script-src 'self'`, `style-src 'self' 'unsafe-inline'` for the Fluent UI
  Griffel runtime, `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self'`, and
  `form-action 'self'`. `unsafe-eval` is never allowed; `crossOriginEmbedderPolicy` is
  disabled for the UI build.

## Acceptance Criteria

1. [ ] Starting with any required variable missing exits non-zero before binding a port, and
   the startup error names the missing key without printing its value.
2. [ ] An invalid `OPENVAULT_DB_URL`, TLS certificate, internal CA, or keyring file exits
   non-zero before serving traffic.
3. [ ] A keyring file with mode `0644` causes startup to fail with a permission error; a
   keyring directory that is group- or world-writable also fails.
4. [ ] The admin listener rejects a direct non-loopback connection from outside the proxy
   CIDRs. Loopback peers may call `/health` and `/ready` only. The default CIDR list is
   loopback only; a peer at `172.16.1.1` is not trusted when the proxy is pinned to
   `172.30.0.2/32`.
5. [ ] The agent listener allows a token-authenticated join without a client certificate and
   rejects a protected agent request without a certificate or with one signed by an unknown
   CA. The agent-scoped data route accepts a certificate for the owning project and rejects a
   certificate from another project; the secret response itself is verified by RD-08/RD-10.
6. [ ] A request with a spoofed `X-Forwarded-For` from a non-proxy source is attributed to the
   socket address, not the header; the trust-proxy predicate rejects a non-proxy peer.
7. [ ] Startup exits non-zero when the keyring or the wrapped CA key is missing, mismatched,
   or cannot unwrap. `GET /ready` returns 503 when PostgreSQL is stopped or a loaded
   dependency probe fails, and 200 when all probes pass.
8. [ ] A `/v1/data*` JSON body above 512 KiB returns 413 `payload_too_large`, including a
   chunked body. A non-`/v1/data` JSON body above 128 KiB returns 413. A decoded secret value
   above 64 KiB returns 413 `secret_too_large`; a certificate chain above 128 KiB or a
   private key above 16 KiB returns 413 `certificate_too_large`.
9. [ ] Responses include the API CSP (`default-src 'none'` when the UI is absent, the
   documented UI profile when present), `X-Content-Type-Options`, `Referrer-Policy`, and no
   `X-Powered-By`; `/v1` responses include `Cache-Control: no-store`; HSTS is set at the
   proxy.
10. [ ] Production responses contain no stack traces, SQL, filesystem paths, or key material,
    including the unexpected-error path.
11. [ ] Success and error responses match the WebAFX nested envelope; `/v1` is the only API
    prefix.
12. [ ] A cross-origin request receives no `Access-Control-Allow-Origin` header.
13. [ ] CLI access tokens are rejected outside the inclusive ±30-second window. Agent
    certificates are issued with a 30-second backdated `notBefore` and are validated against
    the server clock with no additional `notAfter` grace.
14. [ ] `JSON.stringify(keyring)` and `util.inspect(keyring)` contain no key bytes. A captured
    key buffer is all zeroes after `destroy()`; shutdown and failed startup destroy the
    keyring; offline rotation zeroizes the old buffers in the rotation process.
15. [ ] Security requirements are verified by AC1–AC14 and the RD-14 release suite: TLS 1.2+,
    mTLS with the token-authenticated join exception, proxy trust with the loopback default,
    layered body limits, log redaction, no plaintext listener, no published `8443`, and no
    source maps.
16. [ ] `ov config show --redacted` prints a support-safe configuration with no database
    password, OIDC client secret, key bytes, or raw database URL.
17. [ ] A plaintext connection to the admin and agent listener ports fails to complete an
    HTTP request.

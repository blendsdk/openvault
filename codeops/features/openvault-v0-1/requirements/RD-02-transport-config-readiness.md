# RD-02: Transport, Configuration, and Readiness

> **Document**: RD-02-transport-config-readiness.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-01
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines how OpenVault reads configuration, terminates TLS, separates browser
and agent traffic, trusts forwarded headers, enforces request limits, and reports readiness.
It exists because the current scaffold silently ignores its documented configuration and
serves plain HTTP, which is not safe for a secrets product.

## Functional Requirements

### Must Have

- [ ] A typed configuration loader that reads `process.env`, validates every documented
  variable with Zod, and refuses to start on missing or malformed required values.
- [ ] A TLS admin listener reachable only from the reverse proxy.
- [ ] A separate mTLS agent listener that requires a client certificate signed by the
  internal CA.
- [ ] No plaintext HTTP listener and no published `8443` port.
- [ ] Proxy trust limited to configured proxy CIDRs; forwarded headers from any other source
  are ignored.
- [ ] Security headers: Helmet defaults plus a strict CSP, no `X-Powered-By`, HSTS at the
  proxy.
- [ ] Request body limits: 64 KiB for secret routes, 128 KiB for certificate routes, and a
  small global default. `application/x-www-form-urlencoded` is disabled for the JSON API.
- [ ] Request and header timeouts at the proxy and server.
- [ ] The API uses the WebAFX envelopes: `{ success: true, data }` on success and
  `{ success: false, error: { code, message, statusCode, timestamp, requestId }, requestId,
  path }` on failure.
- [ ] The API base path is `/v1`; a breaking change requires a new path prefix.
- [ ] CORS is disabled; the UI and API are same-origin.
- [ ] Server and agents require NTP; token and certificate validation tolerates at most 30
  seconds of clock skew.
- [ ] The keyring API never returns raw key buffers, redacts serialization and inspection, and
  zeroizes keys on rotation and shutdown.
- [ ] Production server artifacts contain no source maps.
- [ ] `/health` reports liveness; `/ready` checks PostgreSQL, keyring, CA/key material, and
  the audit table; both return generic bodies without configuration.
- [ ] Keyring file must be mode `0600`; the server refuses to start if it is group- or
  world-readable.
- [ ] Logs redact `value`, `privateKey`, `password`, `token`, `authorization`, `cookie`, and
  `set-cookie`.
- [ ] Error responses never include stack traces, SQL, file paths, or key material.

### Should Have

- [ ] A redacted configuration dump for support (`ov config show --redacted`).
- [ ] Startup telemetry that records config validation failures without secret values.
- [ ] A test that both listeners reject a plaintext connection.

### Won't Have (Out of Scope)

- Automatic certificate reload without restart.
- Multiple admin listeners or multi-region routing.
- A public metrics endpoint.

## Technical Requirements

### Configuration

| Variable | Required | Default | Validation |
|---|---|---|---|
| `OPENVAULT_BASE_URL` | yes | — | absolute HTTPS URL |
| `PORT` | no | `8443` | integer 1–65535 |
| `OPENVAULT_ADMIN_PORT` | no | `8443` | integer 1–65535 |
| `OPENVAULT_AGENT_PORT` | no | `8444` | integer 1–65535 |
| `OPENVAULT_DB_URL` | yes | — | PostgreSQL URL |
| `OPENVAULT_KEYRING` | yes | — | absolute path, file mode `0600` |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | no | — | absolute path, file mode `0600` |
| `OPENVAULT_TLS_CERT` | yes | — | readable PEM certificate |
| `OPENVAULT_TLS_KEY` | yes | — | readable PKCS#8 key |
| `OPENVAULT_INTERNAL_CA` | yes | — | readable PEM CA |
| `OPENVAULT_OIDC_ISSUER` | no | — | HTTPS URL |
| `OPENVAULT_OIDC_CLIENT_ID` | with OIDC | — | non-empty |
| `OPENVAULT_OIDC_CLIENT_SECRET` | with OIDC | — | non-empty |
| `OPENVAULT_OIDC_REDIRECT_URL` | no | `${BASE_URL}/v1/auth/callback` | HTTPS URL |
| `OPENVAULT_OIDC_ALLOWED_DOMAINS` | no | — | comma-separated domains |
| `OPENVAULT_SECRET_MAX_BYTES` | no | `65536` | 1024–1048576 |
| `OPENVAULT_CERT_MAX_BYTES` | no | `131072` | 1024–2097152 |
| `OPENVAULT_SOFT_DELETE_DAYS` | no | `30` | 7–90 |
| `OPENVAULT_AUDIT_RETENTION_DAYS` | no | `180` | 30–3650 |
| `OPENVAULT_JOIN_TOKEN_TTL` | no | `15m` | 1m–24h |
| `OPENVAULT_CERT_TTL_DAYS` | no | `30` | 1–90 |
| `OPENVAULT_SESSION_TTL_HOURS` | no | `8` | 1–24 |
| `OPENVAULT_TRUST_PROXY` | no | `true` | boolean |
| `OPENVAULT_PROXY_CIDRS` | no | `172.16.0.0/12` | CIDR list |
| `OPENVAULT_LOG_LEVEL` | no | `info` | `error`, `warn`, `info`, `debug` |

### Listeners

```text
proxy (TLS) ──▶ admin listener (TLS, proxy CIDR only) ──▶ API + UI
agent ── mTLS ──▶ agent listener (client cert required) ──▶ join/renew/fetch
```

- Admin listener serves `/v1/*` and the static UI. It is reachable only from the proxy
  network.
- Agent listener serves `/v1/agent/*` and secret fetch endpoints. It requires a valid client
  certificate and checks fingerprint, expiry, and revocation.
- Both listeners validate the same principal, policy, and audit rules for their routes.
- `OPENVAULT_TRUST_PROXY=true` means trust the immediately connected proxy only when its
  source address is in `OPENVAULT_PROXY_CIDRS`; otherwise ignore forwarded headers.

### Readiness

`GET /ready` returns 200 only when all of these are true:

1. PostgreSQL responds to `SELECT 1`.
2. The keyring is loaded and the current key is present.
3. The server TLS material and internal CA parsed successfully.
4. The audit table is writable (a read-only check is allowed; no event is written).
5. The configured internal CA trusts the expected agent chain.

Otherwise return 503 with `{ success: false, error: { code: "not_ready", ... } }` and no
internal details.

## Integration Points

- RD-03 uses the admin listener and session cookies.
- RD-05 uses the agent listener and internal CA.
- RD-07 uses the database and audit readiness check.
- RD-10 and RD-12 consume the public base URL and security headers.
- RD-14 tests both listeners and the proxy trust boundary.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Transport | Single listener / split listeners / network only | Split admin + agent listeners | No shared cleartext bridge; distinct trust | AR-2 |
| Config failure | Warn / fail closed | Fail closed | A secrets service must not start half-configured | AR-19 |
| Proxy trust | Hop count / proxy CIDR / all | Proxy CIDR only | Prevent IP spoofing and audit poisoning | AR-20 |
| Readiness | Liveness only / dependency checks | Dependency checks | Compose and operators need truthful state | AR-19 |
| Body limits | WebAFX default / explicit | Explicit small limits | Reduce unauthenticated DoS surface | AR-21 |

## Security Considerations

- **Data sensitivity:** config includes DB credentials and OIDC secret; keyring path reveals
  key custody. Never log values.
- **Input validation:** every env value is schema-validated; URLs and CIDRs are parsed.
- **Authentication & authorization:** both listeners enforce their own credential type;
  route-level policy is applied later.
- **Injection risks:** no SQL from config; logs use structured fields.
- **Encryption needs:** TLS 1.2+ on both listeners; mTLS for agents.
- **Rate limiting:** listener-level connection limits and route-level limits later.
- **Infrastructure:** non-root, read-only rootfs, no published admin port, proxy CIDR
  enforcement.

## Acceptance Criteria

1. [ ] Starting with any required variable missing exits non-zero before binding a port, and
   the log names the missing key without printing its value.
2. [ ] An invalid `OPENVAULT_DB_URL`, TLS certificate, internal CA, or keyring file exits
   non-zero before serving traffic.
3. [ ] A keyring file with mode `0644` causes startup to fail with a permission error.
4. [ ] The admin listener rejects a direct connection from outside the proxy CIDR.
5. [ ] The agent listener rejects a connection without a client certificate and one signed by
   an unknown CA.
6. [ ] A request with a spoofed `X-Forwarded-For` from a non-proxy source is attributed to the
   socket address, not the header.
7. [ ] `GET /ready` returns 503 when PostgreSQL is stopped or the keyring is missing, and 200
   when both are available.
8. [ ] A 64 KiB + 1 byte secret body returns 413; a 128 KiB + 1 byte certificate body returns
   413.
9. [ ] Responses include CSP, `X-Content-Type-Options`, `Referrer-Policy`, and no
   `X-Powered-By`; `/v1` responses include `Cache-Control: no-store`.
10. [ ] Production responses contain no stack traces, SQL, file paths, or key material.
11. [ ] Success and error responses match the WebAFX envelopes; `/v1` is the only API prefix.
12. [ ] A cross-origin request receives no `Access-Control-Allow-Origin` header.
13. [ ] A token or certificate with more than 30 seconds of clock skew is rejected.
14. [ ] `JSON.stringify(keyring)` and `util.inspect(keyring)` contain no key bytes; a rotation
    or shutdown zeroizes the old key buffers.
15. [ ] Security requirements verified: TLS, mTLS, proxy trust, limits, redaction.

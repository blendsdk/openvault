# Transport and Listeners: RD-02

> **Document**: 03-02-transport-listeners.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Overview

This component adds the HTTPS admin listener, the mTLS agent listener, request-boundary
middleware, proxy-source enforcement, TLS material validation, and the secure WebAFX adapter.
The public contract is owned by
[RD-02 §Listeners](../../requirements/RD-02-transport-config-readiness.md#listeners); this
document records the implementation design and the decisions in AR-4–AR-8, AR-13–AR-16.

## Architecture

```text
admin_net / proxy ──▶ https.Server (server cert) ──▶ wrapper(listener=admin)
                                                        │
vault_net / agent ──▶ https.Server (client cert required) ──▶ wrapper(listener=agent)
                                                        │
                                                        ▼
                                      pre-WebAFX scope/source/body/header middleware
                                                        │
                                                        ▼
                                      WebAFX app.express(routes, DI, envelopes, /health)
```

The two servers share one Express application and one WebAFX `initialize()` pass. Each server
sets a private listener marker before handing the request to Express. The marker is not derived
from a header and cannot be set by a client.

## Secure Application Adapter

`apps/server/src/transport/secure-application.ts` defines:

```ts
export class SecureWebApplication extends WebApplication {
  public prepare(): Promise<void>;
  public startTransport(options?: StartTransportOptions): Promise<TransportHandle>;
  public override start(): Promise<() => Promise<void>>; // always throws
  protected override loadConfiguration(): Promise<void>; // no-op
}

export interface StartTransportOptions {
  /** Test override; 0 asks the OS for an ephemeral port. */
  readonly adminPort?: number;
  readonly agentPort?: number;
}

export interface TransportHandle {
  readonly adminPort: number;
  readonly agentPort: number;
  readonly stop: () => Promise<void>;
}
```

Rules:

1. `prepare()` calls WebAFX's protected `initialize()` exactly once.
2. `startTransport()` refuses a second start, creates both HTTPS servers, binds them, marks the
   app started, installs one signal-handler set, and returns the handle.
3. `start()` throws `SecureWebApplication requires startTransport()`; the plaintext starter is
   never reachable from production code.
4. Shutdown closes both servers with `Promise.all`, sets the app started, calls WebAFX
   `shutdown()` for plugin/service disposal, destroys the keyring provider, and removes signal
   handlers. It is idempotent and has a hard timeout. It does not reuse WebAFX's one-server
   `createShutdownFn`; its own signal-handler set covers both listeners (AR-4).
5. If binding the second server fails, the first is closed and keyring material is destroyed.
6. `loadConfiguration()` is a no-op so WebAFX cannot load `.env.js`/`.env.local.js` after the
   Zod loader (AR-11).

`startTransport` throws a startup error if the application has no TLS material. The adapter does
not read `process.env` or files itself. `createApplication(config, dependencies)` supplies the
validated runtime dependencies through a small `SecureApplicationDependencies` interface:

```ts
export interface SecureApplicationDependencies {
  readonly database: PostgreSQLDatabase;
  readonly tls: TlsMaterial;
  readonly keyring: KeyringProvider;
  /** Test override; production builds probes from database/tls/keyring. */
  readonly readinessProbes?: readonly ReadinessProbe[];
}
```

`createApplication` installs the pre-stack on `app.express` before `prepare()`, builds the
production readiness probes when `readinessProbes` is absent, and owns the database dispose hook.
`createTestApplication(config, dependencies)` reuses the same assembly, accepts fake
`readinessProbes`, and returns the app for supertest without calling `startTransport`.
`createApplication` is the only production construction path.

## TLS Material

`apps/server/src/transport/tls.ts` defines `TlsMaterial.load(config)`:

- Read `OPENVAULT_TLS_CERT`, `OPENVAULT_TLS_KEY`, and `OPENVAULT_INTERNAL_CA` as UTF-8 PEM.
- Parse the server certificate with `X509Certificate`; parse the private key with
  `createPrivateKey`; require `certificate.checkPrivateKey(key)`.
- Parse the CA certificate; require `ca.ca === true` and a valid self/CA verification
  (`ca.verify(ca.publicKey)`).
- Expose only what Node needs: `certPem`, `keyObject`, `caPem`, and the parsed certificate
  metadata needed by readiness. Do not log key material or certificate file contents.
- Accept a certificate chain in `OPENVAULT_TLS_CERT`; the first certificate is the leaf.
- Reject malformed, unreadable, or mismatched material with `TlsMaterialError`.

Server options:

| Listener | Options |
|---|---|
| Admin | `key`, `cert`, `minVersion: "TLSv1.2"`, no client certificate |
| Agent | `key`, `cert`, `minVersion: "TLSv1.2"`, `requestCert: true`, `rejectUnauthorized: true`, `ca: [caPem]` |

Node's TLS stack rejects a missing client certificate or a certificate from an unknown CA
before the HTTP request is routed. RD-02 stops there; RD-05 adds fingerprint, expiry, and
revocation checks (AR-3).

## Listener Scope

`apps/server/src/transport/scope.ts` installs a default-deny middleware before WebAFX
initialisation.

### Normalisation

From `req.originalUrl || req.url || "/"`:

1. If the value is absolute (`http://` or `https://`), use its pathname; otherwise strip the
   query string.
2. Percent-decode once. Malformed encoding returns a `BadRequestError`.
3. Collapse repeated `/` and lowercase the path.
4. If the path is still not a valid pathname, return `BadRequestError`.

The normalised path is used only for scope/limit decisions; WebAFX still receives the original
request for routing and diagnostics.

### Scope table

| Listener | Allowed normalised paths |
|---|---|
| Admin | `/health`, `/ready`, `/v1`, `/v1/**` except `/v1/agent` and `/v1/agent/**` |
| Agent | `/health`, `/v1/agent`, `/v1/agent/**` |

Anything else returns `NotFoundError` through the WebAFX envelope. The admin allowlist is
default-deny; static UI routes are added in RD-12 with the same table. Tests cover uppercase,
percent-encoded letters, duplicate slashes, trailing slashes, absolute-form URLs, and
`/v1/agent` attempts on the admin listener (AR-5).

## Proxy Trust and Source Guard

`apps/server/src/transport/proxy.ts` owns CIDR parsing/matching and the Express trust function.

- `normalizePeerAddress` converts IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4, trims zone
  identifiers, and rejects non-IP values.
- `CidrMatcher` uses Node's `BlockList` (no new dependency) for IPv4 and IPv6; `contains()`
  returns false for malformed or mixed-family addresses rather than throwing.
- The admin listener guard checks `req.socket.remoteAddress` before WebAFX routing:
  - loopback peers may call only `/health` and `/ready`;
  - other peers must be in `OPENVAULT_PROXY_CIDRS`;
  - a rejected peer gets `ForbiddenError` and never reaches a controller.
- The agent listener does not use source CIDRs; mTLS is its authentication.
- If `OPENVAULT_TRUST_PROXY` is true, after `prepare()` set Express
  `app.set("trust proxy", (remoteAddress) => matcher.contains(remoteAddress))`; otherwise
  leave it false. WebAFX must be constructed with `TRUST_PROXY: false` so it never sets hop
  count 1 (AR-6).
- The guard never uses `req.ip` for the source decision.
- If the configured CIDR list is the broad default in production, log one warning with the
  variable name and the reference Compose recommendation (AR-7). Do not log the address list.

## Request Boundary

The middleware is installed on `app.express` before `prepare()` so it executes before
WebAFX's core parsers. Order:

0. Correlation ID: reuse a valid inbound `X-Request-ID` UUID or generate one, then set `req.id`,
   the `X-Request-ID` response header, and `req.headers["x-request-id"]` so WebAFX's later
   request-id middleware reuses the same value. This runs before every rejection path.
1. Helmet with the strict API CSP (03-03) and existing Helmet baseline.
2. `/v1` `Cache-Control: no-store`.
3. Listener scope.
4. Admin source guard.
5. URL-encoded rejection for `/v1`.
6. Content-Length precheck.
7. JSON parser with `limit: "128kb"` and a `verify` byte counter.
8. Body-parser error mapper (413/400).
9. Pre-stack error logger: call the shared pino provider with the WebAFX message-first signature
   (`warn("request rejected", { requestId, method, path, statusCode, code })`), then call
   `next(error)`. Guard on `!req.services` so only errors raised before `prepare()` are logged
   here; WebAFX's terminal handler remains the single envelope renderer.
10. WebAFX `initialize()` middleware, plugins, controllers, `/health`, 404, error handler.

The correlation middleware and the pre-stack logger are why a 403/404/400/413/415 response still
carries `requestId` and an `X-Request-ID` header, and why the rejection appears once in the
structured log. Use `createLoggerPlugin(provider)` (the two-step pino API) rather than the
one-liner so the pre-stack logger and `req.log` share the same provider and redaction policy.

### Limits

| Path | Limit |
|---|---|
| `/v1/secrets` and `/v1/secrets/**` | 64 KiB |
| `/v1/certificates` and `/v1/certificates/**` | 128 KiB |
| All other JSON under `/v1` | 128 KiB |

The parser is installed with a 128 KiB ceiling. `verify` checks the actual bytes for the
normalised path and throws `ApiError(413, "payload_too_large", "Payload too large")`. An
oversized `Content-Length` is rejected before reading the body. WebAFX's own `BODY_LIMIT` is
set to `128kb` as a second ceiling. Installed body-parser 2.4.0 skips its own read because the
custom parser has already finished the Request stream (`onFinished.isFinished(req)`); it does
not use a `req._body` flag. The implementation test asserts that the body is parsed exactly once
and that the pre-parser limit still wins, not that `req._body` exists.

These transport guardrails are fixed at RD-02's required values. `OPENVAULT_SECRET_MAX_BYTES`
and `OPENVAULT_CERT_MAX_BYTES` are product-value limits enforced in RD-08/RD-09 and do not
change the parser boundary (03-01).

`application/x-www-form-urlencoded` under `/v1` returns
`ApiError(415, "unsupported_media_type", "Use application/json")`. WebAFX's URL-encoded parser
remains installed for non-`/v1` paths only; the `/v1` guard rejects before it runs (AR-13,
AR-14).

### Headers

- CSP: `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
- `X-Content-Type-Options`, `Referrer-Policy`, and the rest of Helmet's defaults remain.
- `X-Powered-By` is removed by WebAFX.
- CORS is disabled through `CORS: false`; no `Access-Control-Allow-Origin` is emitted.
- HSTS is owned by Caddy at the public edge; WebAFX Helmet may emit its default HSTS header,
  which is harmless. The plan does not rely on the app for the public HSTS contract.
- `/v1/**` responses set `Cache-Control: no-store`.

### Timeouts and connections

| Server setting | Value |
|---|---|
| `headersTimeout` | 10 s |
| `requestTimeout` | 30 s |
| `keepAliveTimeout` | 15 s |
| `maxConnections` (admin) | 1024 |
| `maxConnections` (agent) | 512 |

Caddy enforces the client leg with the global `servers.timeouts` block and the upstream leg with
`transport http` read/write timeouts and `keepalive` (the exact Caddyfile is in 03-04). The
upstream keepalive stays below the origin's 15 s `keepAliveTimeout` to avoid intermittent 502s
on reused connections.

## Error Handling

| Condition | Result |
|---|---|
| Missing/invalid client certificate | TLS handshake failure on agent listener |
| Admin peer outside proxy CIDRs | `403` WebAFX envelope; no controller; `requestId` and `X-Request-ID` present; logged once |
| Admin peer on loopback for non-health path | `403`; same correlation/logging |
| Client asks for agent path on admin (or vice versa) | `404` WebAFX envelope; same correlation/logging |
| Oversized body | `413 payload_too_large`; same correlation/logging |
| URL-encoded body under `/v1` | `415 unsupported_media_type`; same correlation/logging |
| Malformed JSON | `400 invalid_json`; same correlation/logging |
| Unknown route | WebAFX `404` envelope |
| Unexpected handler error | WebAFX `500` envelope, no stack in production |

The error mapper converts body-parser's `entity.too.large` and syntax errors before WebAFX's
final error handler. All responses use WebAFX's envelope
`{ success: false, error: { code, message, statusCode, timestamp, requestId, path } }`; `requestId`
and `path` are nested inside `error`, matching `03-03` and the framework renderer. The pre-stack
correlation middleware supplies the ID and the pre-stack logger records the rejection once.

## Startup and Shutdown Sequence

```text
loadConfig
  → KeyringProvider.load
  → TlsMaterial.load
  → runMigrations
  → create PostgreSQL pool
  → create SecureWebApplication
  → prepare (WebAFX initialize)
  → bind admin HTTPS
  → bind agent HTTPS
  → install signal handlers
  → return handle
```

Shutdown:

```text
stop()
  → close admin and agent listeners (drain)
  → mark started and call WebAFX shutdown (plugins/services)
  → destroy keyring provider
  → remove signal handlers
```

The secure runtime never calls `WebApplication.start()`; there is no plaintext listener. The
`createApplication(config, dependencies)` factory is the only production construction path.
A test helper may use the same app through `app.express` with supertest; it does not bind a
plaintext port.

## Integration Points

- 03-01 supplies config/keyring; 03-03 supplies readiness/logging/errors.
- RD-03 uses the admin listener and browser session routes.
- RD-05 uses the agent listener and adds certificate policy/revocation.
- RD-10 uses the agent listener for join/renew/fetch.
- RD-12 adds static UI routes to the admin scope table.
- RD-14 tests transport and deployment boundaries.

## Testing Requirements

- ST-15–ST-26 and ST-39 in [07-testing-strategy.md](07-testing-strategy.md) cover TLS, mTLS,
  no plaintext, scope isolation, proxy trust, headers, limits, error envelopes, and real
  `TlsMaterial` validation failures.
- ST-19 includes non-`/v1` prefix denials; ST-32 asserts that a 403/413/415 pre-stack rejection
  carries `requestId` and `X-Request-ID` and produces one structured log entry.
- Integration tests use `apps/server/tests/integration/helpers/tls.ts` to generate a temporary
  CA/server/client fixture with the system `openssl`; no private keys are committed.
- Listener tests bind ephemeral ports through `startTransport({ adminPort: 0, agentPort: 0 })`.
- Shutdown tests assert both listeners stop, services dispose, and the keyring provider is
  destroyed.

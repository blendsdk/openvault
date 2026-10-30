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
   `createShutdownFn` or `setupSignalHandlers` (AR-4).
5. If binding the second server fails, the first is closed and keyring material is destroyed.
6. `loadConfiguration()` is a no-op so WebAFX cannot load `.env.js`/`.env.local.js` after the
   Zod loader (AR-11).

`startTransport` throws a startup error if the application has no TLS material; the factory in
`apps/server/src/app.ts` must always supply it.

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

1. Helmet with the strict API CSP (03-03) and existing Helmet baseline.
2. `/v1` `Cache-Control: no-store`.
3. Listener scope.
4. Admin source guard.
5. URL-encoded rejection for `/v1`.
6. Content-Length precheck.
7. JSON parser with `limit: "128kb"` and a `verify` byte counter.
8. Body-parser error mapper (413/400).
9. WebAFX `initialize()` middleware, plugins, controllers, `/health`, 404, error handler.

### Limits

| Path | Limit |
|---|---|
| `/v1/secrets` and `/v1/secrets/**` | 64 KiB |
| `/v1/certificates` and `/v1/certificates/**` | 128 KiB |
| All other JSON under `/v1` | 128 KiB |

The parser is installed with a 128 KiB ceiling. `verify` checks the actual bytes for the
normalised path and throws `ApiError(413, "payload_too_large", "Payload too large")`. An
oversized `Content-Length` is rejected before reading the body. WebAFX's own `BODY_LIMIT` is
set to `128kb` as a second ceiling; `req._body` prevents a second parse.

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

Caddy adds 30 s read/write and 120 s idle timeouts (03-04).

## Error Handling

| Condition | Result |
|---|---|
| Missing/invalid client certificate | TLS handshake failure on agent listener |
| Admin peer outside proxy CIDRs | `403` WebAFX envelope; no controller |
| Admin peer on loopback for non-health path | `403` |
| Client asks for agent path on admin (or vice versa) | `404` WebAFX envelope |
| Oversized body | `413 payload_too_large` |
| URL-encoded body under `/v1` | `415 unsupported_media_type` |
| Malformed JSON | `400 invalid_json` |
| Unknown route | WebAFX `404` envelope |
| Unexpected handler error | WebAFX `500` envelope, no stack in production |

The error mapper converts body-parser's `entity.too.large` and syntax errors before WebAFX's
final error handler; all responses keep the standard `{ success: false, error, requestId, path }`
shape.

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

- ST-15–ST-26 in [07-testing-strategy.md](07-testing-strategy.md) cover TLS, mTLS, no plaintext,
  scope isolation, proxy trust, headers, limits, and error envelopes.
- Integration tests use `apps/server/tests/integration/helpers/tls.ts` to generate a temporary
  CA/server/client fixture with the system `openssl`; no private keys are committed.
- Listener tests bind ephemeral ports through `startTransport({ adminPort: 0, agentPort: 0 })`.
- Shutdown tests assert both listeners stop, services dispose, and the keyring provider is
  destroyed.

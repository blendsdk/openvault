# Current State: RD-02 Transport, Configuration, and Readiness

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Existing Implementation

### What Exists

- A minimal WebAFX application factory in `apps/server/src/app.ts`: it reads `PORT` and
  `ENV_MODE`, constructs `WebApplication`, and registers `ReadyController` under `/v1`.
- A process entry point in `apps/server/src/main.ts`: it runs BlendSDK migrations first and then
  calls `app.start()`, which binds a plaintext HTTP listener.
- A constant readiness response in `apps/server/src/controllers/ready.ts` under `/v1/ready`.
- A dependency-free `Keyring` and AES-256-GCM envelope primitive in
  `packages/core/src/keyring.ts` and `packages/core/src/crypto.ts`, with unit tests.
- A PostgreSQL URL parser in `apps/server/src/db/url.ts` that rejects TLS query parameters and
  malformed URLs without echoing passwords.
- A reference Compose stack with Caddy, a server, PostgreSQL, TLS/keyring volumes, and no
  published `8443` port; the Caddyfile has no HSTS or proxy timeouts.
- BlendSDK WebAFX 5.68.1, including controllers, DI, plugins, Helmet baseline, request IDs,
  envelopes, `/health`, and the pino logger plugin.
- PostgreSQL 16/17 integration tests, generated row types, and a migration ledger.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/app.ts` | WebAFX factory and controller registration | Load typed config, register services, add middleware, build secure app |
| `apps/server/src/main.ts` | Startup and migrations | Validate config/material first; start secure listeners |
| `apps/server/src/controllers/ready.ts` | Constant readiness | Root `/ready` with dependency probes |
| `apps/server/src/db/url.ts` | PostgreSQL URL parsing | Reuse from config; keep TLS fail-closed behavior |
| `packages/core/src/keyring.ts` | Raw-buffer keyring API | Callback access, redaction, inspect, destroy |
| `packages/core/src/crypto.ts` | Envelope crypto | Adapt to the hardened keyring API |
| `packages/core/src/index.ts` | Core exports | Remove raw key-material export |
| `apps/server/tests/integration/migrations.spec.test.ts` | Migration startup regression tests | Supply a complete valid config fixture; assert the migration-specific failure |
| `apps/server/tests/ready.test.ts` | Legacy `/v1/ready` test | Replace with the PL-1/PL-2 harness tests |
| `packages/core/tests/crypto.test.ts` | Keyring and envelope tests | Update to callback access and redacted serialization |
| `deploy/compose/compose.yaml` | Target topology | Add `admin_net`, CA/agent/proxy env, healthcheck |
| `deploy/compose/Caddyfile` | Public TLS proxy | HSTS, upstream TLS CA, global/transport timeouts |
| `docs/reference/configuration.md` | Config reference | Align required paths, ports, proxy trust, age deferral |

### Code Analysis

`WebApplication.start()` calls `expressApp.listen(PORT)` at
`apps/server/node_modules/blendsdk/dist/webafx/application/web-application.js:656-677`. It has
no HTTPS or mTLS option. The protected lifecycle methods (`initialize()`, `shutdown()`,
`setupSignalHandlers()`) are available to a subclass, but `shutdown()` is a no-op unless
`started` is true (`web-application.js:526-528`). WebAFX also installs both JSON and URL-encoded
body parsers (`web-application.js:189-190`) and sets `trust proxy` to hop count 1 when
`TRUST_PROXY` is true (`web-application.js:171-176`). Its default Helmet configuration disables
CSP (`web-application.js:209-214`).

Two orderings matter for the new pre-stack. First, WebAFX installs its body parsers before
`requestIdMiddleware()` (`web-application.js:192`) and before the service container
(`:298-303`), so any pre-stack rejection would otherwise lack `req.id`/`X-Request-ID` and
`req.services`; the plan installs its own correlation and pre-stack logging before
`prepare()`. Second, installed body-parser 2.4.0 does not use a `req._body` flag; it skips a
second read when the request stream is finished (`onFinished.isFinished(req)`). A custom parser
that consumes the stream is skipped correctly, but the implementation test must prove the
one-parse property rather than assert a flag that does not exist.

`Keyring.current` and `Keyring.get()` return `KeyMaterial` containing the internal `Buffer`
(`packages/core/src/keyring.ts:57-68`), and `toJSON()` returns base64 key material
(`packages/core/src/keyring.ts:76-82`). `util.inspect` would print the private `Map`.

## Gaps Identified

### Gap 1: No typed fail-closed configuration

**Current behavior:** only `PORT` and `ENV_MODE` are read; required files and documented
variables are ignored; WebAFX can load `.env.js` after construction.
**Required behavior:** every documented value is validated before migrations and before any
listener binds; secrets never appear in logs; a bad file or malformed value stops startup.
**Fix required:** add `loadConfig`, file/permission checks, a redacted dump, and a bridge that
passes only standard settings to WebAFX.

### Gap 2: No TLS or mTLS listener

**Current behavior:** `app.start()` binds plaintext HTTP and exposes the same routes to any
network peer.
**Required behavior:** one HTTPS admin listener restricted to proxy CIDRs and one mTLS agent
listener requiring a client certificate from the internal CA; no plaintext listener.
**Fix required:** add validated TLS material and a `SecureWebApplication` adapter that owns two
HTTPS servers and a correct shutdown.

### Gap 3: Proxy trust is all-or-nothing

**Current behavior:** WebAFX maps `TRUST_PROXY: true` to Express hop count 1, trusting the
immediate peer without checking it is the configured proxy.
**Required behavior:** trust forwarded headers only when the socket peer is in
`OPENVAULT_PROXY_CIDRS`; otherwise attribute the socket address and reject direct admin traffic.
**Fix required:** custom CIDR/BlockList trust function, IPv4-mapped normalization, and a
default-deny listener source guard.

### Gap 4: Request limits and headers do not match the contract

**Current behavior:** WebAFX's global parser has no route split; body-parser overflow becomes a
500; URL-encoded bodies are accepted; CSP is disabled; no `/v1` no-store policy exists.
**Required behavior:** 64/128 KiB path limits with 413 envelopes, 415 for URL-encoded `/v1`,
strict CSP, Helmet baseline, no-store, no CORS, no `X-Powered-By`.
**Fix required:** pre-parser limits/error mapping and explicit Helmet/Cache-Control middleware.

### Gap 5: Readiness is a constant

**Current behavior:** `/v1/ready` returns 200 without checking PostgreSQL, keyring, CA, or audit.
**Required behavior:** WebAFX `/health` liveness and root `/ready` dependency checks; 503 with
the `not_ready` envelope and no internal details.
**Fix required:** add a readiness service, disposable database pool, keyring/TLS/CA probes, and
the root controller.

### Gap 6: Keyring custody is too permissive

**Current behavior:** public methods return raw buffers; serialization and inspection expose key
material; no destroy path.
**Required behavior:** no raw-buffer return from the server-facing API; redacted
`JSON.stringify`/`util.inspect`; mode `0600`; best-effort zeroization on shutdown.
**Fix required:** harden core `Keyring`, adapt crypto, and add a server provider/loader.

### Gap 7: Deployment does not carry the new trust boundary

**Current behavior:** Compose has no `OPENVAULT_INTERNAL_CA`, agent port, admin network, or
proxy CIDR; Caddy has no HSTS/timeouts; docs say keyring is optional.
**Required behavior:** reference stack matches the validated config and trust boundary.
**Fix required:** add `admin_net`, pinned proxy address/CIDR, required env, Caddy HSTS/timeouts,
and documentation.

## Dependencies

### Internal

- RD-01 schema/migrations, generated types, CI, and root policy tests.
- `packages/core` keyring and envelope crypto.
- `apps/server` WebAFX application, PostgreSQL adapter, and test harness.

### External

- Node.js 22.23.3, HTTPS/TLS, `X509Certificate`, `BlockList`, and OpenSSL for test fixtures.
- BlendSDK 5.68.1 (`webafx`, `webafx-pino`, `postgresql`).
- PostgreSQL 16/17 for integration tests.
- Caddy 2.10 in the reference Compose stack.

No new production npm dependency is planned.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WebAFX protected lifecycle changes in a future BlendSDK release | Medium | High | One-method adapter, contract tests, upgrade review, reopen trigger in AR-4 |
| Path normalisation misses an encoded/case variant | Low | High | Default-deny scope table and adversarial path tests in ST-19 |
| IPv4-mapped or IPv6 peer bypasses CIDR check | Medium | High | Normalise mapped addresses; test dual-stack and malformed values (ST-20) |
| Broad default proxy CIDR includes DB/agent networks | Medium | High | `admin_net` + pinned proxy in compose; production warning; AR-7 |
| Keyring zeroization is best-effort in Node | High | Medium | Document limitation; destroy internal buffers; no plaintext logs |
| OpenSSL unavailable in some developer environment | Low | Medium | CI is Linux; document prerequisite; unit tests not needing TLS still run |
| Readiness DB probe hangs | Low | High | 2 s pool timeout + bounded `Promise.race`; ST-30 |
| Body parser order differs after a WebAFX upgrade | Low | High | One-parse test (`onFinished.isFinished`), 413/415 tests, reopen trigger in AR-13 |
| Age-encrypted keyring is unsupported until RD-13 | Certain | Medium | Fail closed on passphrase file; explicit AR-2 deferral |
| Agent revocation is not checked until RD-05 | Certain | High | Chain-only scope is explicit; RD-05 requirement remains; no agent routes in RD-02 |

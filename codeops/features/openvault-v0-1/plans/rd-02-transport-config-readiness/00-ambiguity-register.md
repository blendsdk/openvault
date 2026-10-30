# Ambiguity Register: RD-02 Transport, Configuration, and Readiness

> **Status**: ✅ GATE PASSED — all 28 items resolved
> **Last Updated**: 2026-10-30 12:14
> **Root invocation ID**: `ov-rd02-plan-20261030-1214`
> **Policy version**: 1

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|----------|-----------------|-------------------|---------------|--------|
| AR-1 | Scope | Which requirement set and feature owns this plan? | RD-02 only / absorb RD-03/05/12 | User requested `rd-02-transport-config-readiness`; RD-02 only | ✅ Resolved |
| AR-2 | Security | RD-02 says the keyring may be age-encrypted and lists `OPENVAULT_KEYRING_PASSPHRASE_FILE`. | Implement age now / defer plaintext-only | User chose defer to RD-13. If the passphrase file is set, startup fails closed with a clear unsupported-feature error; no age-encrypted keyring in RD-02. | ✅ Resolved |
| AR-3 | Security | RD-02 requires an agent client certificate from the internal CA; RD-05 adds fingerprint, expiry, and revocation. | Chain only / enforce all now | User chose chain only. RD-02 enforces TLS plus a certificate that chains to `OPENVAULT_INTERNAL_CA`; fingerprint, expiry, and revocation enforcement remain RD-05. | ✅ Resolved |
| AR-4 | Technical | BlendSDK WebAFX starts a plaintext HTTP server and has no TLS/mTLS option. | WebAFX subclass adapter / upstream framework change / plaintext behind proxy / rebuild Express stack | AI — delegated by `--auto-design` (transport runtime; note R1) | ✅ Resolved |
| AR-5 | Technical | Two listeners over one WebAFX application need a trust-boundary model. | One app + normalised scope gate / two full WebAFX apps / prefix-only request checks | AI — delegated by `--auto-design` (listener isolation; note R2) | ✅ Resolved |
| AR-6 | Security | Proxy trust must not trust arbitrary forwarded headers; WebAFX's boolean `TRUST_PROXY` maps to hop count 1. | App-level CIDR trust function + listener guard / WebAFX `TRUST_PROXY: true` / hop count | AI — delegated by `--auto-design` (proxy trust; note R3) | ✅ Resolved |
| AR-7 | Security | The default proxy CIDR `172.16.0.0/12` spans Docker networks and can include the database container. | Keep default and pin compose / narrow default and pin compose / reject default in production | AI — delegated by `--auto-design` (network policy; note R4) | ✅ Resolved |
| AR-8 | Technical | Server TLS and agent mTLS need validated certificate/key material and listener options. | Node HTTPS servers with TLS 1.2+ and CA validation / external TLS terminator only / WebAFX-only HTTP | AI — delegated by `--auto-design` (TLS mechanism; note R5) | ✅ Resolved |
| AR-9 | Security | `packages/core` `Keyring` currently exposes raw key Buffers and base64 serialization. | Harden core + server provider / server wrapper only / leave API and document | AI — delegated by `--auto-design` (key custody; note R6) | ✅ Resolved |
| AR-10 | Behavioral | How should keyring files be located, permission-checked, and loaded? | Required absolute path + exact 0600 + JSON parse / optional default path / no permission check | AI — delegated by `--auto-design` (key custody; note R6) | ✅ Resolved |
| AR-11 | Technical | Config validation must read process environment but WebAFX `ApplicationSettings` does not validate custom env or required files, and loads `.env.js` overrides. | Zod loader + pass only standard settings to WebAFX + disable file loading / WebAFX settings only / raw `process.env` | AI — delegated by `--auto-design` (configuration; note R7) | ✅ Resolved |
| AR-12 | Behavioral | `PORT` and `OPENVAULT_ADMIN_PORT` both default to 8443. | Admin port canonical, `PORT` fallback, conflict is an error / `PORT` wins / two independent listeners | AI — delegated by `--auto-design` (configuration; note R7) | ✅ Resolved |
| AR-13 | Behavioral | WebAFX's global body parser cannot enforce the 64 KiB secret and 128 KiB certificate limits; oversized bodies currently become 500. | Pre-parser JSON limit + `verify` byte count + 413 mapper / global limit only / route middleware after parse | AI — delegated by `--auto-design` (request limits; note R8) | ✅ Resolved |
| AR-14 | Behavioral | `application/x-www-form-urlencoded` is accepted by WebAFX but must be disabled for `/v1`. | Reject pre-parser with 415 / allow parser / disable globally by overriding WebAFX internals | AI — delegated by `--auto-design` (request media policy; note R8) | ✅ Resolved |
| AR-15 | Security | CSP, HSTS, no-store, CORS, and security-header ownership are split between WebAFX, Helmet, and Caddy. | Strict API CSP + proxy HSTS + no-store + CORS off / WebAFX defaults / proxy-only | AI — delegated by `--auto-design` (headers; note R9) | ✅ Resolved |
| AR-16 | Non-functional | Request/header timeouts and listener connection limits are unspecified. | 10 s headers, 30 s request, 15 s keep-alive, bounded connections / framework defaults / no limits | AI — delegated by `--auto-design` (availability; note R10) | ✅ Resolved |
| AR-17 | Behavioral | `/health`, `/ready`, and `/v1/ready` overlap; WebAFX owns `/health` and the existing controller is under `/v1`. | WebAFX `/health` liveness + root `/ready` dependency probe / keep `/v1/ready` / duplicate both | AI — delegated by `--auto-design` (readiness; note R11) | ✅ Resolved |
| AR-18 | Technical | Readiness checks need a database connection, timeout, and disposal without leaking pools. | BlendSDK `PostgreSQLDatabase` with 2 s connection timeout, singleton dispose, bounded probe / raw `pg` client per probe / no DB probe | AI — delegated by `--auto-design` (readiness; note R11) | ✅ Resolved |
| AR-19 | Security | CA readiness cannot verify a live agent chain when no agent is connected. | Parse CA and require CA:TRUE/self-signed / require a peer certificate / skip CA check | AI — delegated by `--auto-design` (readiness semantics; note R11) | ✅ Resolved |
| AR-20 | Security | Logs must redact `value`, `privateKey`, `password`, `token`, `authorization`, `cookie`, and `set-cookie`; WebAFX logs URLs and plugin defaults redact only two headers. | Pino plugin + full redact path set + no config values / default plugin only / custom logger | AI — delegated by `--auto-design` (observability; note R12) | ✅ Resolved |
| AR-21 | Behavioral | Startup ordering must fail before binding ports and must not touch the database on a bad config. | Config/keyring/TLS/CA validation → migrations → bind listeners / migrations first / bind then validate | AI — delegated by `--auto-design` (startup safety; note R13) | ✅ Resolved |
| AR-22 | Behavioral | Error responses need the WebAFX envelope for 413, 415, 503, and unexpected errors without leaking internals. | WebAFX `ApiError` mapping and production error handler / custom envelopes / raw Express | AI — delegated by `--auto-design` (error contract; note R14) | ✅ Resolved |
| AR-23 | Technical | OIDC settings are optional and not used for a flow in RD-02. | Validate conditionally and store redacted / ignore until RD-03 / implement discovery now | AI — delegated by `--auto-design` (configuration; note R7) | ✅ Resolved |
| AR-24 | Test strategy | TLS/mTLS tests need trusted and unknown CA material without committing private keys. | Generate ephemeral certs with the system `openssl` in a temp directory / commit fixtures / add a certificate library | AI — delegated by `--auto-design` (testing; note R15) | ✅ Resolved |
| AR-25 | Naming & integration | Module/file names and compose network ownership for the transport layer. | `config/`, `security/`, `transport/`, `readiness/`; add `admin_net` and Caddy HSTS/timeouts / put everything in `app.ts` / reuse `vault_net` for admin | AI — delegated by `--auto-design` (structure; note R16) | ✅ Resolved |
| AR-26 | Non-functional | RD-02 acceptance 13 requires a 30 s clock-skew rejection, but no token or agent-certificate validator exists in RD-02. | Shared policy/helper now; enforce in RD-03/RD-05 / implement a fake validator / skip the policy | AI — delegated by `--auto-design` (shared policy; note R17) | ✅ Resolved |
| AR-27 | UX & support | RD-02 Should Have asks for `ov config show --redacted`, but the CLI is RD-11. | Provide `toRedactedConfig` now; CLI command in RD-11 / add a CLI entry now / omit support output | AI — delegated by `--auto-design` (support surface; note R18) | ✅ Resolved |
| AR-28 | Technical | `createApp` is the current test seam; production needs a secure factory with validated dependencies. | `createApplication(config, dependencies)` for production; `createTestApplication` for in-process tests / keep one ambiguous factory / use raw Express in tests | AI — delegated by `--auto-design` (test/build seam; note R19) | ✅ Resolved |

## Resolution Notes

### R1 — WebAFX secure runtime adapter

**Authority:** AI — delegated by `--auto-design`
**Eligibility:** technical implementation mechanism inside RD-02's approved transport and security policy.
**Objective:** HTTPS admin and mTLS agent listeners without replacing WebAFX's routing, DI, plugins, envelopes, or lifecycle.
**Decision:** add a small `SecureWebApplication` adapter that calls WebAFX's protected `initialize()` once, starts two Node `https` servers over the same Express app, and owns a single idempotent shutdown that closes both servers and calls WebAFX's `shutdown()` after marking the app started. Override `loadConfiguration()` to a no-op and `start()` to throw so the plaintext starter cannot be used.
**Evidence:** `apps/server/node_modules/blendsdk/dist/webafx/application/web-application.js:656-677`; `web-application.d.ts:30-34,177,261`; `apps/server/src/main.ts:5-19`.
**Rejected alternatives:** upstream WebAFX change (external package change, not available in this repo); plaintext behind Caddy (violates RD-02's no-plaintext-listener requirement); rebuilding Express middleware/controllers (reinvents WebAFX).
**Strongest counterargument:** relying on protected methods is a compatibility risk. Mitigation: one adapter method, no duplicate middleware, contract tests, and a documented reopen trigger on a BlendSDK upgrade.
**Confidence:** High — the lifecycle methods are protected and the alternative is a larger rewrite.
**Hardening:** independent design challenger returned **Simplify**; required changes are folded into AR-4–AR-8 and AR-16.
**Reopen triggers:** WebAFX adds native HTTPS/mTLS options; protected lifecycle signatures change; a two-listener shutdown test fails.

### R2 — Listener scope isolation

**Authority:** AI — delegated by `--auto-design`
**Decision:** one WebAFX app and one default-deny scope table. Each HTTPS server wrapper marks the listener kind in a private request property. The gate normalises the path (decode once, collapse duplicate slashes, lowercase), rejects malformed encodings, and permits only `/health` and `/v1/agent/**` on the agent listener; the admin listener permits `/health`, `/ready`, and non-agent `/v1/**`. Unknown paths are denied before WebAFX routing.
**Evidence:** Express default routing is case-insensitive; the current `/v1/ready` controller is `apps/server/src/controllers/ready.ts:10`; design-challenger probe showed a case-sensitive prefix gate could be bypassed.
**Rejected alternatives:** two complete WebAFX apps (duplicate DI/database work); prefix checks without normalisation (bypassable); relying only on route registration (agent routes do not exist yet).
**Strongest counterargument:** a path classifier is security-sensitive. Mitigation: default deny, one scope table, tests for case, encoded characters, duplicate slashes, trailing slashes, and absolute-form URLs.
**Confidence:** High.
**Reopen triggers:** a new listener kind; static UI routes added; WebAFX adds native per-server routing.

### R3 — Proxy trust and source attribution

**Authority:** AI — delegated by `--auto-design`
**Decision:** never pass `OPENVAULT_TRUST_PROXY` to WebAFX's `TRUST_PROXY`; pass `false`. Install an Express `trust proxy` function that trusts only socket peers inside the configured CIDRs (normalising IPv4-mapped IPv6) and install a listener-level source guard before WebAFX middleware. Use `req.socket.remoteAddress`, never `req.ip`, for the guard. Allow loopback only for `/health` and `/ready` so container healthchecks work.
**Evidence:** WebAFX sets `trust proxy` to `1` when `TRUST_PROXY` is true (`web-application.js:171-176`); `proxy-addr`/`ipaddr.js` handling of mapped addresses was demonstrated by the challenger.
**Rejected alternatives:** WebAFX boolean trust (any immediate peer); hop count; trusting `X-Forwarded-For` directly.
**Strongest counterargument:** Docker/dual-stack address forms can bypass a naive CIDR check. Mitigation: explicit normalisation and tests.
**Confidence:** High.
**Reopen triggers:** IPv6-only deployment; proxy chain changes; healthcheck source changes.

### R4 — Proxy network default

**Authority:** AI — delegated by `--auto-design`
**Decision:** keep RD-02's documented default for compatibility, but update the reference Compose stack to use a dedicated `admin_net` with a pinned proxy address and set `OPENVAULT_PROXY_CIDRS` to that single proxy address. Emit a production warning when the broad default is still in use. Document that `vault_net` agents and `db_net` are never admin peers.
**Evidence:** `RD-02:93`; current `deploy/compose/compose.yaml` puts proxy, server, and agents on `vault_net` and PostgreSQL on `db_net`.
**Rejected alternatives:** change the documented default without a requirements revision; rely on network isolation alone.
**Strongest counterargument:** operators who omit the variable still get a broad CIDR. Mitigation: Compose sets it; startup warning in production; README.
**Confidence:** Medium — depends on operators applying the reference Compose settings.
**Reopen triggers:** RD-13 changes the deployment topology; a narrower default is approved.

### R5 — TLS and mTLS material

**Authority:** AI — delegated by `--auto-design`
**Decision:** read server certificate/key and internal CA as PEM, reject unreadable/malformed material, require the private key to match the certificate, require TLS 1.2 or newer, and require client certificates on the agent listener with `requestCert`/`rejectUnauthorized` and the internal CA. RD-05 owns fingerprint, expiry, and revocation.
**Evidence:** RD-02 listeners and readiness; Node `https`/`X509Certificate`; `RD-05:102,136-140`.
**Rejected alternatives:** terminate mTLS at Caddy (agent traffic bypasses the app trust boundary); accept any client certificate; disable verification to handle clock skew.
**Strongest counterargument:** Node's built-in verification has no 30 s skew tolerance. That tolerance is a token/certificate policy for RD-03/RD-05, not a reason to disable TLS verification.
**Confidence:** High.
**Reopen triggers:** RD-05 adds certificate policy; WebAFX adds TLS support.

### R6 — Keyring custody

**Authority:** AI — delegated by `--auto-design`
**Decision:** harden `packages/core` so `Keyring` does not return raw Buffers from its public API. Use `withCurrentKey()`/`withKey()` callback access for the crypto primitive; make `toJSON()` and `util.inspect` redacted; implement idempotent `destroy()` that zeroes internal buffers; reject unsafe key ids. Add a server `KeyringProvider` that loads an absolute path, requires exact mode `0600`, parses the documented JSON shape, exposes only status, and destroys on shutdown. RD-13 owns age encryption and export for backup/rotation.
**Evidence:** `packages/core/src/keyring.ts:4-9,57-68,76-82`; `packages/core/src/index.ts:10`; `docs/reference/configuration.md` keyring shape; RD-02 Must Have keyring bullets.
**Rejected alternatives:** server wrapper only while core keeps returning raw keys (does not meet the RD's API claim); leaving `toJSON` base64 (leaks through JSON.stringify); making raw access public with a warning.
**Strongest counterargument:** callback access can still be misused and Node cannot guarantee zeroization. Mitigation: keep the callback scope inside the crypto package, document best-effort zeroization, and add serialization/inspection tests.
**Confidence:** High.
**Reopen triggers:** RD-13 needs a storage/export API; crypto code requires raw access outside core.

### R7 — Typed configuration

**Authority:** AI — delegated by `--auto-design`
**Decision:** add a Zod `loadConfig(environment)` that validates every RD-02 variable, required files, URLs, CIDRs, booleans, integer bounds, and durations. Pass only standard WebAFX fields (`PORT`, `ENV_MODE`, `LOG_LEVEL`, `BODY_LIMIT`, `CORS: false`, `TRUST_PROXY: false`) to `WebApplication`; keep secret/custom values in a typed config service. Override WebAFX `loadConfiguration()` so `.env.js`/`.env.local.js` cannot override validated values. `OPENVAULT_ADMIN_PORT` wins over `PORT`; conflicting values are an error. OIDC values are validated only when the issuer is set.
**Evidence:** `apps/server/node_modules/blendsdk/dist/webafx/application/application-settings.js:71-99`; `web-application.js:181-183`; `apps/server/src/app.ts:20-31`.
**Rejected alternatives:** use `ApplicationSettings` alone (does not read/validate custom env); allow `.env` files (silent overrides); pass all secrets through WebAFX settings (visible to request-scoped services).
**Strongest counterargument:** a second config representation adds code. Mitigation: one Zod source, one adapter to WebAFX standard fields, and redaction tests.
**Confidence:** High.
**Reopen triggers:** WebAFX adds custom env validation; RD-03 needs additional auth settings.

### R8 — Request bodies

**Authority:** AI — delegated by `--auto-design`
**Decision:** install a JSON parser and error mapper before WebAFX initialisation. Use a 128 KiB global ceiling; use byte counting in `verify` to enforce 64 KiB for `/v1/secrets*` and 128 KiB for `/v1/certificates*`; map entity-too-large to a 413 WebAFX envelope; reject `application/x-www-form-urlencoded` on `/v1` with 415 before parsing. Keep WebAFX's `BODY_LIMIT` aligned at 128 KiB as a second ceiling.
**Evidence:** `web-application.js:189-190` always installs JSON and URL-encoded parsers; design-challenger probe showed oversized JSON becomes 500 through WebAFX's error handler.
**Rejected alternatives:** WebAFX global limit only (no route-specific headroom); route middleware after parsing (too late); override WebAFX core middleware (larger rewrite).
**Strongest counterargument:** two parsers can drift. Mitigation: the custom parser sets `req._body`, WebAFX skips it, and tests cover both Content-Length and chunked bodies.
**Confidence:** High.
**Reopen triggers:** WebAFX exposes per-route parser limits; secret routes move under a different prefix.

### R9 — Security headers

**Authority:** AI — delegated by `--auto-design`
**Decision:** add an explicit Helmet policy before WebAFX initialisation with a strict API CSP (`default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`), keep WebAFX's `x-powered-by` removal and Helmet defaults, add `Cache-Control: no-store` for `/v1`, and keep CORS disabled. Caddy owns HSTS (`max-age=31536000; includeSubDomains`) and proxy timeouts. WebAFX's default HSTS is harmless but not the owning control.
**Evidence:** WebAFX disables CSP (`web-application.js:209-214`) and has no CSP config; RD-02 acceptance 9/10/12; `deploy/compose/Caddyfile` currently has no HSTS/timeouts.
**Rejected alternatives:** rely on WebAFX Helmet defaults (no CSP); enable CORS with an allowlist (same-origin UI); add HSTS only in the app (proxy owns the public edge).
**Strongest counterargument:** a `default-src 'none'` CSP will need expansion when RD-12 serves the UI. Mitigation: document the per-path CSP ownership and revisit in RD-12.
**Confidence:** High.
**Reopen triggers:** RD-12 adds static UI; CSP needs nonce/hash.

### R10 — Timeouts and connections

**Authority:** AI — delegated by `--auto-design`
**Decision:** set admin/agent `headersTimeout` to 10 s, `requestTimeout` to 30 s, `keepAliveTimeout` to 15 s; cap concurrent connections (1024 admin, 512 agent). Caddy uses 30 s read/write timeouts and 120 s idle timeout.
**Evidence:** RD-02 request/header timeout requirement; Node HTTPS server options; Caddy reverse proxy options.
**Rejected alternatives:** framework defaults (Node headers timeout is 60 s); no connection cap.
**Strongest counterargument:** fixed values may be wrong for slow certificate uploads. Mitigation: values are configuration-independent constants with tests; RD-13 can make them tunable if operationally required.
**Confidence:** Medium.
**Reopen triggers:** real workload measurements; certificate upload sizes change.

### R11 — Readiness

**Authority:** AI — delegated by `--auto-design`
**Decision:** use WebAFX's `/health` for liveness. Add a root `/ready` controller; it probes PostgreSQL with a bounded 2 s connection timeout, the loaded keyring's current key, the parsed server TLS/CA material, the audit table (`SELECT 1 FROM audit_events LIMIT 1`), and CA basic constraints (`CA:TRUE`). Any failure returns `ApiError(503, "not_ready", "Not ready")` through WebAFX's envelope. Register the `PostgreSQLDatabase` as a disposable singleton and disconnect on shutdown.
**Evidence:** `apps/server/src/controllers/ready.ts` currently returns a constant under `/v1`; RD-02 acceptance 7; BlendSDK `PostgreSQLDatabase` pool config and `disconnect()`.
**Rejected alternatives:** keep `/v1/ready` (does not match acceptance); a raw `pg` client per probe (bypasses BlendSDK); no CA check (does not meet readiness definition).
**Strongest counterargument:** a DB probe on every readiness request adds load. Mitigation: a single pooled connection with a 2 s timeout; orchestration probes are low-frequency.
**Confidence:** High.
**Reopen triggers:** RD-07 adds the audit writer; DB role separation changes probe privileges.

### R12 — Logging and redaction

**Authority:** AI — delegated by `--auto-design`
**Decision:** use BlendSDK `pinoLoggerPlugin` with the RD-02 redaction paths plus defaults, never log config objects, and test that structured logs for token/value/password/privateKey/authorization/cookie fields are redacted. Do not add a custom logging framework.
**Evidence:** `webafx-pino/types.js` default redacts only authorization/cookie; RD-02 logging bullet; `apps/server/package.json` already has pino and pino-http.
**Rejected alternatives:** default plugin only (misses value/privateKey/password/token); custom logger (reinvents plugin); disable request logs (loses operations visibility).
**Strongest counterargument:** pino redaction is path-based and cannot redact arbitrary URL query strings. Mitigation: API handlers must keep credentials out of query strings; RD-02 tests cover structured fields, and RD-03/RD-05 use headers/bodies.
**Confidence:** Medium.
**Reopen triggers:** a route needs a credential in a URL; log review finds a new sensitive field.

### R13 — Startup order

**Authority:** AI — delegated by `--auto-design`
**Decision:** load and validate config first; then load keyring and TLS/CA material; then run migrations against the validated DB URL; then bind listeners. Any failure exits non-zero before binding.
**Evidence:** current `main.ts:5-19` runs migrations before any config validation.
**Rejected alternatives:** migrate before config (bad config touches DB); bind then validate (serves half-configured).
**Strongest counterargument:** migration failure after keyring load requires cleanup. Mitigation: keyring provider is destroyed on every failure path.
**Confidence:** High.
**Reopen triggers:** migrations become a separate init container; RD-13 changes startup.

### R14 — Error contract

**Authority:** AI — delegated by `--auto-design`
**Decision:** use WebAFX `ApiError`/`StandardErrorResponse` for 413, 415, 503, and unexpected errors. Never include stack traces, SQL, file paths, or key material; production mode is the default.
**Evidence:** WebAFX error handler (`web-application.js` error-handler middleware) and RD-02 acceptance 10/11.
**Rejected alternatives:** custom Express error JSON (duplicates WebAFX); returning raw parser errors (500/HTML).
**Strongest counterargument:** parser errors originate outside WebAFX. Mitigation: mapper installed in the pre-parser stack converts known body-parser errors to `ApiError`.
**Confidence:** High.
**Reopen triggers:** WebAFX changes envelope shape.

### R15 — Test certificates

**Authority:** AI — delegated by `--auto-design`
**Decision:** generate an ephemeral CA, server certificate, valid client certificate, and wrong-CA client certificate with the system `openssl` in a temporary directory for transport tests. Clean up in `finally`; never commit private keys or add a certificate library.
**Evidence:** CI is Ubuntu with OpenSSL; RD-02 needs TLS/mTLS integration tests; artifact/Gitleaks policy forbids committed key material.
**Rejected alternatives:** commit test PEMs (secret-scanner risk); add a certificate-generation dependency (new support surface); skip TLS integration tests (unacceptable).
**Strongest counterargument:** OpenSSL availability varies on developer machines. Mitigation: document the prerequisite; CI is Linux; unit tests that do not need TLS remain runnable.
**Confidence:** High.
**Reopen triggers:** CI image lacks OpenSSL; tests move to Windows.

### R16 — Structure and deployment

**Authority:** AI — delegated by `--auto-design`
**Decision:** use `apps/server/src/config/`, `security/`, `transport/`, and `readiness/`; add `admin_net` to Compose for proxy-to-server admin traffic, set a pinned proxy address and `OPENVAULT_PROXY_CIDRS`, add `OPENVAULT_INTERNAL_CA`/agent port/healthcheck, and add Caddy HSTS/timeouts. Keep `vault_net` for agents and `db_net` for PostgreSQL.
**Evidence:** current Compose topology; RD-02 listeners; AR-7.
**Rejected alternatives:** put all transport code in `app.ts` (too large); reuse `vault_net` for admin (agents share it); leave Compose unchanged (missing required env).
**Strongest counterargument:** an extra network increases Compose complexity. Mitigation: it is a direct trust-boundary control, documented in the reference stack.
**Confidence:** High.
**Reopen triggers:** RD-13/14 redesign deployment; a proxy sidecar model is approved.

## Gate Evidence

- All 28 rows are resolved or explicitly deferred with the user's answer.
- User deferrals: AR-2 (age keyring, RD-13) and AR-3 (agent revocation/fingerprint, RD-05).
- No plan document other than this register is written before this header says `✅ GATE PASSED`.
- The design challenger returned **Simplify**; its concrete findings are folded into AR-4–AR-8, AR-11, AR-13, AR-14, AR-16, and AR-17.

### R17 — Clock-skew ownership

**Authority:** AI — delegated by `--auto-design`
**Decision:** RD-02 exports the 30 s constant and boundary-tested helper. RD-03 and RD-05 apply it to JWT and agent-certificate validation. RD-02 has no token/certificate route, so it does not invent a fake validator.
**Rejected alternatives:** accept any skew (weakens later checks); duplicate token handling in RD-02 (overlaps RD-03/05).
**Confidence:** High. **Reopen trigger:** RD-03/RD-05 change the tolerance or validation model.

### R18 — Redacted support output

**Authority:** AI — delegated by `--auto-design`
**Decision:** implement `toRedactedConfig` in the config module and test it. The `ov config show --redacted` command stays in RD-11 because the CLI is not in this package. This satisfies the support-output capability without adding a CLI surface early.
**Rejected alternatives:** add a partial CLI now (overlaps RD-11); omit support output (Should Have).
**Confidence:** High. **Reopen trigger:** RD-11 consumes a different config shape.

### R19 — Application factory seam

**Authority:** AI — delegated by `--auto-design`
**Decision:** `createApplication(config, dependencies)` is the production factory; `createTestApplication` is a test-only helper that uses the same WebAFX assembly and `.express` access without binding a plaintext listener. `SecureWebApplication.start()` always throws.
**Rejected alternatives:** one factory with optional production/test behavior (risk of accidental plaintext); raw Express test apps (bypasses the contract).
**Confidence:** High. **Reopen trigger:** a second runtime (worker/CLI) needs the same app assembly.

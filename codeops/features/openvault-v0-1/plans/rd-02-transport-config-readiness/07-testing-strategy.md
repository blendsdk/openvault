# Testing Strategy: RD-02 Transport, Configuration, and Readiness

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Test Approach

RD-02 is security-sensitive. Specification tests are written first from
[RD-02](../../requirements/RD-02-transport-config-readiness.md) and the plan decisions in
[00-ambiguity-register.md](00-ambiguity-register.md). They are immutable oracles: a failing
specification test means the implementation is wrong, not that the test should be loosened.

Unit tests cover pure config/CIDR/clock/path logic. Integration tests use real HTTPS sockets,
real PostgreSQL 16/17 databases, and ephemeral OpenSSL certificates. Mocks are limited to
readiness probe failure injection and external clock values.

Test suites:

| File | Cases |
|---|---|
| `apps/server/tests/config.spec.test.ts` | ST-1–ST-9 |
| `packages/core/tests/keyring.spec.test.ts` + `apps/server/tests/keyring.spec.test.ts` | ST-10–ST-14 |
| `apps/server/tests/integration/transport.spec.test.ts` | ST-15–ST-26 |
| `apps/server/tests/integration/readiness.spec.test.ts` | ST-27–ST-30 |
| `apps/server/tests/logging.spec.test.ts` | ST-31–ST-32 |
| `apps/server/tests/startup.spec.test.ts` | ST-33 |
| `tests/deploy.spec.test.mjs` | ST-34 |
| `apps/server/tests/ready.test.ts` | ST-35 |
| `tests/artifacts.spec.test.mjs` / CI policy | ST-36 |
| Verification matrix | ST-37 |

## 🚨 Specification Test Cases

### Configuration

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Empty environment; no `OPENVAULT_BASE_URL` | `ConfigError` names `OPENVAULT_BASE_URL`; startup exits non-zero; no port bound; no value echoed | RD-02 AC1; AR-11 |
| ST-2 | `OPENVAULT_DB_URL=mysql://...` or missing database/user | `ConfigError` names `OPENVAULT_DB_URL`; password absent from message | RD-02 AC2; AR-11 |
| ST-3 | `OPENVAULT_BASE_URL=http://...` or URL with credentials/query | `ConfigError` names `OPENVAULT_BASE_URL`; no secret echoed | RD-02 config; AR-11 |
| ST-4 | Keyring path exists with mode `0644` | `ConfigError` names `OPENVAULT_KEYRING`; startup fails before DB/listener | RD-02 AC3; AR-10 |
| ST-5 | Missing/unreadable TLS cert, TLS key, or CA | `ConfigError` or `TlsMaterialError` names the path; startup fails before bind | RD-02 AC2; AR-8 |
| ST-6 | OIDC issuer set without client id/secret; then complete OIDC values | Missing dependent values fail; complete values produce the default redirect URL | RD-02 config; AR-23 |
| ST-7 | Config containing known DB password and OIDC secret; call `toRedactedConfig` | Neither secret appears; keys/paths remain visible | RD-02 Should Have; AR-11 |
| ST-8 | `OPENVAULT_ADMIN_PORT=9443` and `PORT=8443` | Conflict error names both; `PORT` alone is accepted; `OPENVAULT_ADMIN_PORT` wins when alone | AR-12 |
| ST-9 | CIDR list `172.30.0.2/32, 2001:db8::/32`; malformed and mixed-family values | Valid entries parse; malformed entries fail with a keyed error; matcher handles IPv4, IPv6, and IPv4-mapped IPv6 | RD-02 proxy trust; AR-6, AR-24 |

### Keyring

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-10 | Valid JSON keyring with one 32-byte key, mode `0600` | Provider loads; `status()` reports loaded and current id; no raw bytes returned | RD-02 keyring; AR-9, AR-10 |
| ST-11 | Keyring with malformed JSON, wrong version, missing current, wrong key length, or unsafe key id | `KeyringError`; partial state destroyed; no key bytes in message | RD-02 AC2; AR-9 |
| ST-12 | `JSON.stringify(keyringProvider)` and `util.inspect(keyringProvider)` | No base64 key bytes, no `Buffer`, no internal map; only status/current/key count | RD-02 AC14; AR-9 |
| ST-13 | Load keyring, call `destroy()` twice, then `withCurrentKey`/`withKey` | Both calls throw; destroy is idempotent; internal key buffers are zeroed in code review | RD-02 AC14; AR-9 |
| ST-14 | `OPENVAULT_KEYRING_PASSPHRASE_FILE` is set to a readable `0600` file | Startup fails closed with an unsupported-feature error naming the variable; no plaintext fallback | AR-2 |

### Transport

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-15 | Admin listener with server cert; request over HTTPS with trusted CA; request over plain HTTP | HTTPS route succeeds; plain HTTP cannot complete a TLS request and no plaintext listener is bound | RD-02 AC14; AR-4, AR-8 |
| ST-16 | Direct admin request from `127.0.0.1` while proxy CIDRs are `10.0.0.0/8` | `403` WebAFX envelope; request never reaches a controller | RD-02 AC4; AR-6 |
| ST-17 | Same source; proxy CIDRs include loopback; request `/health`, `/ready`, and `/v1/missing` | `/health` is reachable; `/ready` reaches readiness (200/503, never 403); loopback is not granted general admin access | RD-02 readiness; AR-6 |
| ST-18 | Agent listener: no client cert; wrong-CA cert; valid CA client cert | No-cert and wrong-CA handshakes fail; valid cert reaches `/health` and agent scope | RD-02 AC5; AR-3, AR-8 |
| ST-19 | Admin asks `/v1/AGENT/ping`, `/v1/%61gent/ping`, `//v1//agent/ping`, `/v1/agent/`, absolute-form URL; agent asks `/v1/ready` | Every denial is `404`; agent cannot reach admin routes; valid agent paths remain allowed | AR-5 |
| ST-20 | Trust function with `X-Forwarded-For` from a peer outside CIDRs; IPv4-mapped peer inside CIDRs | Outside peer is not trusted and `req.ip` remains the socket address; mapped inside peer matches | RD-02 AC6; AR-6 |
| ST-21 | Admin response with CORS origin header; inspect headers | CSP, `X-Content-Type-Options`, `Referrer-Policy`; no `X-Powered-By`; no `Access-Control-Allow-Origin`; `/v1` has `Cache-Control: no-store` | RD-02 AC9, AC12; AR-15 |
| ST-22 | POST `/v1/secrets/x` with 65,537 bytes; 65,536 bytes; POST `/v1/certificates/x` with 131,073 bytes | 65,537 → 413; 65,536 → parser passes (404 if no route); 131,073 → 413 | RD-02 AC8; AR-13 |
| ST-23 | POST `/v1/secrets/x` with `application/x-www-form-urlencoded` | 415 WebAFX envelope; URL-encoded parser does not process the body | RD-02 body rules; AR-14 |
| ST-24 | Oversized, URL-encoded, not-ready, unknown route, and unexpected handler error | All use the WebAFX error envelope; production output has no stack, SQL, filesystem path, or key bytes | RD-02 AC10, AC11; AR-22 |
| ST-25 | Inspect the transport option builder / started servers | Headers 10 s, request 30 s, keep-alive 15 s, connection cap set; Caddy settings covered by ST-34 | RD-02 timeouts; AR-16 |
| ST-26 | Try every listener address with `http` and `https` | Only the two HTTPS listeners accept TLS; no plaintext server is created by production code | RD-02 AC14; AR-4 |

### Readiness and Observability

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-27 | `/health` with PostgreSQL down and keyring unavailable | 200 liveness body; no internal details | RD-02 health; AR-17 |
| ST-28 | `/ready` with migrated DB, valid keyring, TLS/CA, and audit table | 200 `{ success: true, data: { status: "ready" } }` | RD-02 AC7; AR-18 |
| ST-29 | `/ready` with DB down, missing keyring, malformed CA, or audit probe failure | 503 with `error.code = "not_ready"`; no internal details; each failure is logged with a fixed probe name | RD-02 AC7; AR-18, AR-19 |
| ST-30 | DB probe that exceeds 2 s / transport timeout | 503 within the bounded timeout; no hanging request | RD-02 readiness; AR-18 |
| ST-31 | Log entries containing token, value, password, privateKey, authorization, cookie, set-cookie | Captured pino JSON masks every value; no key material or DB password | RD-02 logging; AR-20 |
| ST-32 | Request with `X-Request-ID` and a rejected request | Response/error envelope carries `requestId`; request-scoped logger binds the same id | RD-02 envelopes; AR-20 |
| ST-33 | Spawn server with invalid config and a DB URL pointing to a closed port | Config validation wins; process exits non-zero before migrations/listener; no connection attempt | RD-02 fail-closed; AR-21 |
| ST-34 | Parse Compose and Caddy configuration | `admin_net` exists; no published `8443`; required CA/agent/proxy env; Caddy HSTS and 30 s timeouts | RD-02 deployment; AR-7, AR-16 |
| ST-35 | Build the in-process test app; supertest `/ready` with injected probes | Express test seam works without binding a plaintext listener; success envelope unchanged | Plan-local AC5; AR-4 |
| ST-36 | `pnpm check:artifacts` on production build | No source maps, keyring, private key, or sentinel in build output | RD-02 source-map rule; RD-01 AC |
| ST-37 | `pnpm verify` and PostgreSQL 16/17 integration | All gates pass; transport/readiness suites pass on both versions | RD-02 AC15; plan-local AC1–AC4 |

## Implementation-Test Additions

After each specification phase is green, add implementation tests only where they prove an
internal invariant that the spec cases do not expose:

| Area | Impl test | Why |
|---|---|---|
| CIDR | malformed prefix, zone id, mixed family, mapped loopback | Pure matcher edge cases |
| Path normalisation | malformed percent encoding, `%2F`, absolute-form, duplicate slashes | Security classifier edge cases |
| Body parser | `entity.too.large`, syntax error, `verify` invocation, `req._body` skip | Parser-order regression |
| Shutdown | double stop, second-listener bind failure, service disposal order | Lifecycle regression |
| Keyring | unsafe `__proto__` id, destroyed access, inspect redaction | Key custody regression |
| Readiness | timeout cleanup, pool disposal, fixed probe names | Resource and log regression |

Impl tests live beside the implementation (`*.impl.test.ts` in `apps/server/tests` or
`packages/core/tests`) and never replace a specification test.

## Verification Commands

```bash
pnpm verify
pnpm audit:prod
pnpm audit:full
TEST_DATABASE_URL=postgres://openvault:test-password@localhost:5433/openvault_test \
OPENVAULT_TEST_DB=1 pnpm --filter @openvault/server test:integration
TEST_DATABASE_URL=postgres://openvault:test-password@localhost:5434/openvault_test \
OPENVAULT_TEST_DB=1 pnpm --filter @openvault/server test:integration
```

`pnpm verify` includes build, typecheck, Biome, unit/root tests, artifact check,
React/Griffel check, and docs. `db:types:check` is unchanged because RD-02 does not change the
database schema.

## Failure Triage

| Failure | First thing to check |
|---|---|
| 500 instead of 413 | Custom JSON parser/error mapper order before WebAFX |
| 200 on `/v1/AGENT` from admin | Path normalisation and default-deny scope table |
| Agent handshake succeeds without cert | `requestCert`/`rejectUnauthorized`/CA wiring |
| `/ready` hangs | Pool `connectionTimeoutMillis` and outer `Promise.race` |
| Key bytes in JSON/inspect | `toJSON`/inspect custom implementation and provider wrapper |
| Config overridden by `.env.js` | `loadConfiguration()` override |
| HSTS/CSP missing | Helmet order and Caddy configuration; check proxy vs app ownership |

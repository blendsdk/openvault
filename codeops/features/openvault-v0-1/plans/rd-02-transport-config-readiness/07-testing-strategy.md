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
| `apps/server/tests/config.spec.test.ts` | ST-1–ST-9 (loader-level config only; CIDR matcher cases are ST-20) |
| `packages/core/tests/keyring.spec.test.ts` + `apps/server/tests/keyring.spec.test.ts` | ST-10–ST-14 |
| `apps/server/tests/integration/transport.spec.test.ts` | ST-15–ST-26, ST-39 |
| `apps/server/tests/clock.spec.test.ts` | ST-38 |
| `apps/server/tests/integration/readiness.spec.test.ts` | ST-27–ST-30 |
| `apps/server/tests/logging.spec.test.ts` | ST-31–ST-32 |
| `apps/server/tests/startup.spec.test.ts` | ST-33 |
| `tests/deploy.spec.test.mjs` | ST-34 |
| `tests/artifacts.spec.test.mjs` / CI policy | ST-36 |
| Verification matrix | ST-37 |
| `apps/server/tests/test-app.impl.test.ts` + `apps/server/tests/ready.impl.test.ts` | PL-1/PL-2 (plan-local harness, not spec oracles) |

## 🚨 Specification Test Cases

### Configuration

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Empty environment; no `OPENVAULT_BASE_URL` | `loadConfig({})` throws `ConfigError` naming `OPENVAULT_BASE_URL`; no value echoed. Process exit/no-bind is ST-33. | RD-02 AC1; AR-11 |
| ST-2 | `OPENVAULT_DB_URL=mysql://...` or missing database/user | `ConfigError` names `OPENVAULT_DB_URL`; password absent from message | RD-02 AC2; AR-11 |
| ST-3 | `OPENVAULT_BASE_URL=http://...` or URL with credentials/query | `ConfigError` names `OPENVAULT_BASE_URL`; no secret echoed | RD-02 config; AR-11 |
| ST-4 | Keyring path exists with mode `0644` | `loadConfig` throws `ConfigError` naming `OPENVAULT_KEYRING`. Process fail-before-DB/listener is ST-33. | RD-02 AC3; AR-10 |
| ST-5 | Missing/unreadable TLS cert, TLS key, or CA | `loadConfig` throws `ConfigError` naming the path. Real PEM/key/CA parsing failures are ST-39. | RD-02 AC2; AR-8 |
| ST-6 | OIDC issuer set without client id/secret; then complete OIDC values | Missing dependent values fail; complete values produce the default redirect URL | RD-02 config; AR-23 |
| ST-7 | Config containing known DB password (URL and parsed `database.pass`) and OIDC secret; call `toRedactedConfig` | Neither secret appears in the serialized result; keys/paths remain visible; raw `databaseUrl` is absent | RD-02 Should Have; AR-11 |
| ST-8 | `OPENVAULT_ADMIN_PORT=9443` and `PORT=8443`; then `OPENVAULT_AGENT_PORT` equal to the resolved admin port | Admin/PORT conflict names both; `PORT` alone is accepted; `OPENVAULT_ADMIN_PORT` wins when alone; agent/admin equality fails with a keyed `ConfigError` before migrations/bind | AR-12; PF-019 |
| ST-9 | CIDR list `172.30.0.2/32, 2001:db8::/32`; malformed and mixed-family values | Valid entries parse into `Cidr[]`; malformed entries fail with a keyed error. Matcher behavior (IPv4, IPv6, IPv4-mapped, mixed-family false) is ST-20 in Phase 2. | RD-02 proxy trust; AR-6, AR-24 |

### Keyring

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-10 | Valid JSON keyring with one 32-byte key, mode `0600` | Provider loads; `status()` reports loaded and current id; no raw bytes returned | RD-02 keyring; AR-9, AR-10 |
| ST-11 | Keyring with malformed JSON, wrong version, missing current, wrong key length, or unsafe key id | `KeyringError`; partial state destroyed; no key bytes in message | RD-02 AC2; AR-9 |
| ST-12 | `JSON.stringify(keyringProvider)` and `util.inspect(keyringProvider)` | No base64 key bytes, no `Buffer`, no internal map; only status/current/key count | RD-02 AC14; AR-9 |
| ST-13 | Load keyring, call `destroy()` twice, then `withCurrentKey`/`withKey` | Both calls throw; destroy is idempotent. Buffer zeroization is a documented code-review gate, not an observable test oracle. | RD-02 AC14; AR-9 |
| ST-14 | `OPENVAULT_KEYRING_PASSPHRASE_FILE` is set to a readable `0600` file | Startup fails closed with an unsupported-feature error naming the variable; no plaintext fallback | AR-2 |

### Transport

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-15 | Admin listener with server cert; request over HTTPS with trusted CA; request over plain HTTP | HTTPS route succeeds; plain HTTP cannot complete a TLS request and no plaintext listener is bound | RD-02 AC14; AR-4, AR-8 |
| ST-16 | Direct admin request from `127.0.0.1` while proxy CIDRs are `10.0.0.0/8` | `403` WebAFX envelope; request never reaches a controller | RD-02 AC4; AR-6 |
| ST-17 | Same source; proxy CIDRs include loopback; request `/health`, `/ready`, and `/v1/missing` | `/health` is reachable; `/ready` reaches readiness (200/503, never 403); loopback is not granted general admin access | RD-02 readiness; AR-6 |
| ST-18 | Agent listener: no client cert; wrong-CA cert; valid CA client cert | No-cert and wrong-CA handshakes fail; valid cert reaches `/health` and agent scope | RD-02 AC5; AR-3, AR-8 |
| ST-19 | Admin asks `/v1/AGENT/ping`, `/v1/%61gent/ping`, `//v1//agent/ping`, `/v1/agent/`, absolute-form URL, `/v2/secrets/x`, `/api/v1/secrets/x`; agent asks `/v1/ready` | Every denial is `404`; agent cannot reach admin routes; non-`/v1` API prefixes are denied; valid agent paths remain allowed | AR-5; RD-02 AC11 |
| ST-20 | Trust function with `X-Forwarded-For` from a peer outside CIDRs; IPv4-mapped peer inside CIDRs; IPv6 CIDR and mixed-family address | Outside peer is not trusted and `req.ip` remains the socket address; mapped inside peer matches; IPv6 matches its CIDR; mixed-family returns false without throwing | RD-02 AC6; AR-6 |
| ST-21 | Admin response with CORS origin header; inspect headers | CSP, `X-Content-Type-Options`, `Referrer-Policy`; no `X-Powered-By`; no `Access-Control-Allow-Origin`; `/v1` has `Cache-Control: no-store` | RD-02 AC9, AC12; AR-15 |
| ST-22 | POST `/v1/secrets/x` with 65,537 bytes; 65,536 bytes; POST `/v1/certificates/x` with 131,073 bytes | 65,537 → 413; 65,536 → parser passes (404 if no route); 131,073 → 413. These are the fixed RD-02 guardrails; `OPENVAULT_SECRET_MAX_BYTES`/`CERT_MAX_BYTES` product limits do not change them (PF-008). | RD-02 AC8; AR-13 |
| ST-23 | POST `/v1/secrets/x` with `application/x-www-form-urlencoded` | 415 WebAFX envelope; URL-encoded parser does not process the body | RD-02 body rules; AR-14 |
| ST-24 | Oversized, URL-encoded, not-ready, unknown route, and unexpected handler error | All use the WebAFX error envelope; production output has no stack, SQL, filesystem path, or key bytes | RD-02 AC10, AC11; AR-22 |
| ST-25 | Inspect the transport option builder / started servers | Headers 10 s, request 30 s, keep-alive 15 s, connection cap set; Caddy settings covered by ST-34 | RD-02 timeouts; AR-16 |
| ST-26 | Try every listener address with `http` and `https` | Only the two HTTPS listeners accept TLS; no plaintext server is created by production code | RD-02 AC14; AR-4 |
| ST-39 | Valid PEM material with a mismatched key; CA without `CA:TRUE`; CA that fails `verify(ca.publicKey)`; malformed cert/key | `TlsMaterialError` names the offending file/key; startup fails before bind; no key material in the message | RD-02 AC2; AR-8 |

### Readiness and Observability

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-27 | `/health` with PostgreSQL down and keyring unavailable | 200 liveness body; no internal details | RD-02 health; AR-17 |
| ST-28 | `/ready` with migrated DB, valid keyring, TLS/CA, and audit table | 200 `{ success: true, data: { status: "ready" } }` | RD-02 AC7; AR-18 |
| ST-29 | `/ready` with DB down, missing keyring, malformed CA, or audit probe failure | 503 with `error.code = "not_ready"`; no internal details; each failure is logged with a fixed probe name | RD-02 AC7; AR-18, AR-19 |
| ST-30 | DB probe that exceeds 2 s / transport timeout | 503 within the bounded timeout; no hanging request | RD-02 readiness; AR-18 |
| ST-31 | Log entries containing token, value, password, privateKey, authorization, cookie, set-cookie, including `req.body.token` and a one-level `*.token` field | Captured pino JSON masks the documented paths; no key material or DB password; handlers do not log arbitrary nested objects | RD-02 logging; AR-20 |
| ST-32 | Request with `X-Request-ID`; rejected admin source (403), oversized body (413), URL-encoded body (415) | `error.requestId` matches the `X-Request-ID` header; the pre-stack logger records exactly one entry with the same ID; request-scoped logger binds the same id | RD-02 envelopes; AR-20, AR-22 |
| ST-38 | `isWithinClockSkew` with an injected clock at exactly 30 s, 30 s + 1 ms, and early/late boundaries | Exactly 30 s is accepted; more than 30 s is rejected in both directions; no token/certificate validator is implemented in RD-02 | RD-02 AC13; AR-26 |
| ST-33 | Spawn server with invalid config and a DB URL pointing to a closed port | Config validation wins; process exits non-zero before migrations/listener; no connection attempt | RD-02 fail-closed; AR-21 |
| ST-34 | Parse Compose and Caddy configuration | `admin_net` exists; no published `8443`/`8444`; required CA/proxy env and explicit agent port; Caddy HSTS; global/transport timeout blocks; no `idle_timeout` under `reverse_proxy`; `caddy validate` when available | RD-02 deployment; AR-7, AR-16, AR-25 |
| ST-36 | `pnpm check:artifacts` on production build | No source maps, keyring, private key, or sentinel in build output | RD-02 source-map rule; RD-01 AC |
| ST-37 | `pnpm verify` and PostgreSQL 16/17 integration | All gates pass; transport/readiness suites pass on both versions | RD-02 AC15; plan-local AC1–AC4 |

## Implementation-Test Additions

After each specification phase is green, add implementation tests only where they prove an
internal invariant that the spec cases do not expose:

| Area | Impl test | Why |
|---|---|---|
| CIDR | malformed prefix, zone id, mixed family, mapped loopback | Pure matcher edge cases |
| Path normalisation | malformed percent encoding, `%2F`, absolute-form, duplicate slashes | Security classifier edge cases |
| Body parser | `entity.too.large`, syntax error, `verify` invocation, one-parse skip (`onFinished.isFinished`) | Parser-order regression |
| Shutdown | double stop, second-listener bind failure, service disposal order | Lifecycle regression |
| Keyring | unsafe `__proto__` id, destroyed access, inspect redaction | Key custody regression |
| Readiness | timeout cleanup, pool disposal, fixed probe names | Resource and log regression |

Impl tests live beside the implementation (`*.impl.test.ts` in `apps/server/tests` or
`packages/core/tests`) and never replace a specification test.

## Plan-Local Harness Tests (not specification oracles)

ST-35 was originally listed as a specification case, but its subject is the test harness, not
RD-02 product behavior. It is reclassified as plan-local implementation evidence and keeps
plan-local AC5 mapped:

| ID | File | Case |
|---|---|---|
| PL-1 | `apps/server/tests/test-app.impl.test.ts` | `createTestApplication` returns the WebAFX assembly for supertest without binding a plaintext listener; `SecureWebApplication.start()` throws; the legacy `ready.test.ts` is replaced. |
| PL-2 | `apps/server/tests/ready.impl.test.ts` | Root `/ready` returns the success envelope with injected probes; a `ReadinessError` maps to 503 `not_ready`. |

Product `/ready` behavior remains covered by the ST-28/ST-29 specification cases. PL-1/PL-2 are
written in the implementation task that changes their seam, not in the specification-test
session, and are never used to derive product expectations.

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

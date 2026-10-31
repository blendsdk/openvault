# Preflight Report: RD-02 Transport, Configuration, and Readiness Plan

> **Status**: ✅ PREFLIGHT PASSED — all 24 findings resolved
> **Iteration**: 2 (first scan + fix verification)
> **Audit target**: `codeops/features/openvault-v0-1/plans/rd-02-transport-config-readiness/`
> **Context**: RD-02 requirements, RD-01 plan conventions, repository source, BlendSDK 5.68.1, Compose/Caddy docs
> **Codebase Grounded**: 28 source/config/test files examined; 41 code references verified
> **Auto-design**: active — root invocation `ov-rd02-preflight-20261030-01`, policy version 1
> **Last Updated**: 2026-10-30

## Codebase Context Summary

**Tech Stack:** Node.js 22.23.3, TypeScript 7.0.2 (strict, ESM, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), pnpm 12.11.2, Express 5.3.0, BlendSDK WebAFX 5.68.1, Helmet 8.3.0, Zod 4.6.7, pino 9.14.0, PostgreSQL 16/17, Vitest 5.0.5, supertest 7.3.1.

**Architecture:** One WebAFX application with controllers, DI, plugins, envelopes, `/health`, and a terminal error handler. The current server binds plaintext HTTP and runs migrations before any config validation. `packages/core` owns the keyring and AES-256-GCM envelope primitive. The reference stack uses Caddy 2.10, `vault_net` for proxy/server/agents, and `db_net` for PostgreSQL.

**Key Files Examined:**
- `apps/server/src/app.ts`, `main.ts`, `controllers/ready.ts`, `db/url.ts`, `db/config.ts`
- `packages/core/src/keyring.ts`, `crypto.ts`, `index.ts`
- `apps/server/tests/ready.test.ts`, `tests/integration/migrations.spec.test.ts`, `packages/core/tests/crypto.test.ts`
- `apps/server/node_modules/blendsdk/dist/webafx/application/web-application.js`, `request-id-middleware.js`, `error-handler-middleware.js`, `service-container.d.ts`
- `apps/server/node_modules/blendsdk/dist/webafx-pino/pino-logger-provider.js`
- `apps/server/node_modules/blendsdk/dist/postgresql/database.d.ts`, `database.js`
- `deploy/compose/compose.yaml`, `deploy/compose/Caddyfile`, `deploy/compose/README.md`
- `docs/reference/configuration.md`, `docs/guide/install.md`, `docs/guide/docker-compose.md`, `docs/architecture/overview.md`, `docs/security/threat-model.md`
- `package.json`, `vitest.root.config.ts`, `scripts/check-artifacts.mjs`, `tests/artifacts.spec.test.mjs`

**Key Observations:**
- WebAFX installs body parsers (`web-application.js:189-190`) before `requestIdMiddleware()` (`:192`) and the service container (`:298-303`). Pre-stack rejections therefore have no `req.id` and no `req.services`; the terminal handler still renders the envelope, but `error.requestId` is absent and the pino logger callback fails silently.
- WebAFX's error envelope puts `requestId` and `path` inside `error`, not at the top level.
- `ServiceContainer.get()` is async; body-parser 2.4.0 has no `req._body` skip (it uses `onFinished.isFinished(req)`); pino wildcard redaction is one level deep.
- `OpenVaultConfig.database` contains `pass` from `parseDatabaseUrl`; the redacted dump contract must not spread it.
- The plan changes startup order, the keyring API, and the readiness route; three existing tests (`migrations.spec.test.ts`, `ready.test.ts`, `crypto.test.ts`) are direct impacts.

**Reference Verification:** 41 references mapped — 39 verified, 2 unverifiable without execution (Caddy 2.10 runtime acceptance of the corrected block; OpenSSL availability on developer machines).

## Summary by Dimension

| # | Dimension | Findings | Highest Severity |
|---|---|---|---|
| 1 | Ambiguities | 1 | 🟡 |
| 2 | Implicit Assumptions | 2 | 🟡 |
| 3 | Logical Contradictions | 2 | 🟠 |
| 4 | Completeness Gaps | 1 | 🟡 |
| 5 | Dependency Issues | 2 | 🟡 |
| 6 | Feasibility Concerns | 1 | 🟠 |
| 7 | Testability | 6 | 🟠 |
| 8 | Security Blind Spots | 3 | 🟠 |
| 9 | Edge Cases | 1 | 🟡 |
| 10 | Scope Creep Indicators | 0 | — |
| 11 | Ordering & Sequencing | 1 | 🟠 |
| 12 | Consistency | 2 | 🟡 |
| 13 | Codebase Alignment | 2 | 🟡 |

## Summary by Severity

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 6 | All resolved |
| MINOR | 17 | All resolved |
| OBSERVATION | 1 | Resolved |

## Findings

### PF-001: Pre-routing rejections are not correlated or logged 🟠 MAJOR

**Dimension:** 3 — Logical Contradictions (also 8, 12)
**Location:** `03-02-transport-listeners.md` §Request Boundary (lines 152-165), §Error Handling (lines 207-223); `03-03-readiness-observability.md` §Logging (lines 96-133), §Error Handling (lines 135-146); `07-testing-strategy.md` ST-24/ST-32
**Codebase Evidence:** `web-application.js:189-190` installs body parsers before `requestIdMiddleware()` at `:192`; the service container is installed at `:298-303`; `request-id-middleware.js:37-55` sets `req.id` and `X-Request-ID`; `error-handler-middleware.js:21-33,34-41` nests `requestId` and swallows logger failures.

**The Problem:** The plan installs Helmet, no-store, scope, source guard, 415, Content-Length, JSON parser, and the body-parser error mapper on `app.express` before `prepare()`. Every pre-routing rejection (403, 404, 400, 413, 415) therefore skips both WebAFX's request-ID middleware and the pino logger. `error.requestId` is absent, no `X-Request-ID` header is set, and the rejection is not logged. ST-32 and RD-02 AC11 cannot pass for exactly the security-boundary rejections RD-02 adds. The plan's claim that "WebAFX's error handler remains the single renderer" is true, but it does not cover correlation or logging.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Correlation-ID middleware only; accept unlogged pre-stack rejections | Smallest; envelope gets `requestId` | Rejections remain invisible to pino |
| B | Correlation-ID middleware + a pre-stack error middleware that logs and calls `next(err)`; WebAFX renders | One renderer; correlated and logged; reuses the pino provider | Requires constructing the pino provider before `prepare()`; must guard against double logging |
| C | Override/reorder WebAFX core middleware | Correct order | Duplicates framework internals; larger change |
| D | Accept uncorrelated, unlogged rejections | No work | Fails ST-32/AC11; loses attack visibility |

**Recommendation:** Option B. Install a correlation middleware before the guards/parsers that reuses a valid inbound UUID or generates one, sets `req.id`, `X-Request-ID`, and `req.headers["x-request-id"]`; construct one `PinoLoggerProvider` and register it with `createLoggerPlugin(provider)`; install a pre-stack error middleware after the parser/mapper that calls `warn("request rejected", { requestId, method, path, statusCode, code })` (WebAFX `Logger` is message-first) and calls `next(err)`. Guard with `!req.services` so post-initialize errors are not double-logged. WebAFX still renders the envelope.

**User Decision:** AI — delegated by `--auto-design` (observability mechanism; see D-1).

### PF-002: Readiness controller cannot compile or map failures to 503 🟠 MAJOR

**Dimension:** 3 — Logical Contradictions (also 1, 6)
**Location:** `03-03-readiness-observability.md` §Readiness Service (lines 49-68), §Controller (lines 79-91)
**Codebase Evidence:** `service-container.d.ts:118` declares `get<T>(name, defaultValue?): Promise<T>`; `base-controller.d.ts:39` exposes `services: ServiceContainer`; `error-handler-middleware.js:44-67` maps unknown errors to 500.

**The Problem:** `await this.services.get<ReadinessService>("readiness").check()` calls `.check()` on a `Promise<ReadinessService>` because member access binds before `await`; it is a TypeScript error and a runtime `TypeError`. The service is specified to throw `ReadinessError`, but the controller has no catch; a readiness failure becomes a 500, not the required `503 not_ready` (AC7, ST-29). `ReadinessError` is referenced but never defined.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Await the service; catch only `ReadinessError`; throw `ApiError(503, ...)`; keep other errors 500 | Smallest; preserves service/HTTP layering; genuine bugs stay 500 | Adds a narrow catch |
| B | Make `ReadinessService.check()` throw `ApiError(503, ...)` directly | One place; simple controller | Couples the service to HTTP |
| C | Return `{ ready, failedProbe }` and map in the controller | Explicit result | New mapping type; more code |

**Recommendation:** Option A. Define `ReadinessError` with a fixed `probe` name, await the service, catch only `ReadinessError`, log the probe with the message-first call `req.log.warn("readiness probe failed", { probe })`, and throw `new ApiError(503, "not_ready", "Not ready")`. Other errors remain 500 so ST-24's unexpected-handler case still passes.

**Iteration 2 evidence:** the scoped re-review caught an object-first `req.log.warn({ probe }, "message")` regression. WebAFX's `Logger` is message-first; the plan now uses `warn("readiness probe failed", { probe })` and documents the `Express.Request.log` augmentation.

**User Decision:** AI — delegated by `--auto-design` (readiness error mapping; see D-2).

### PF-003: Caddy timeout configuration is invalid 🟠 MAJOR

**Dimension:** 6 — Feasibility Concerns (also 13)
**Location:** `03-04-deployment-docs.md` §Caddy (lines 72-78); `03-02-transport-listeners.md` §Timeouts (lines 195-205); `07-testing-strategy.md` ST-34
**Codebase Evidence:** `deploy/compose/Caddyfile:8-13` has a `transport http` block. Caddy's `reverse_proxy` has no `idle_timeout`; `read_timeout`/`write_timeout` are `transport http` options; upstream idle is `keepalive <duration>`; client timeouts are global `servers { timeouts { read_header, read_body, write, idle } }`.

**The Problem:** The plan says to add `read_timeout 30s`, `write_timeout 30s`, and `idle_timeout 120s` "on the reverse proxy." `idle_timeout` is not a valid `reverse_proxy` subdirective, so the reference Caddyfile fails to load. `read_timeout`/`write_timeout` in the wrong scope would also be rejected. ST-34 only checks text, so it could pass while the edge is broken.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Transport-level read/write only; keepalive 10s | Matches the existing block; small | Client header/body timeouts still Caddy defaults |
| B | Global `servers { timeouts { read_header 10s; read_body 30s; write 30s; idle 120s } }` + `transport http { read_timeout 30s; write_timeout 30s; keepalive 10s }`; validate with `caddy validate` | Correct layers; meets RD-02 proxy timeout requirement | Larger config; needs validation |
| C | Drop Caddy timeouts; rely on Node | Small | Fails RD-02's proxy timeout requirement |

**Recommendation:** Option B. Use global server timeouts for the client leg, transport read/write for the upstream leg, and `keepalive 10s` below the origin's 15 s `keepAliveTimeout`. Add `caddy validate --config` to ST-34 (Docker/Caddy available) and assert the exact directives.

**User Decision:** AI — delegated by `--auto-design` (deployment mechanism; see D-3).

### PF-004: Phase 1 spec tests assert Phase 2 behavior 🟠 MAJOR

**Dimension:** 11 — Ordering & Sequencing (also 13)
**Location:** `07-testing-strategy.md` §Configuration ST-1/ST-4/ST-5/ST-9; `99-execution-plan.md` Phase 1 gate
**Codebase Evidence:** `03-02-transport-listeners.md:133-138` places `CidrMatcher` in `apps/server/src/transport/proxy.ts`, implemented in Phase 2 task 2.2.1. `03-02:225-239` and `99:72` place the `main.ts` startup rework in Phase 2 task 2.2.5. Phase 1 task 1.2.1 only adds `apps/server/src/config/`. The Phase 1 gate is `pnpm verify` (`99:32,49`).

**The Problem:** ST-9 in Phase 1 `config.spec.test.ts` expects matcher behavior from Phase 2; ST-1/ST-4/ST-5 assert process startup/non-binding behavior that is reworked in Phase 2. The Phase 1 spec file cannot compile or pass at the Phase 1 gate.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Split ST-9: Phase 1 parses `Cidr[]`; Phase 2 matcher cases extend ST-20. Rescope ST-1/4/5 to loader-level assertions; ST-33 owns process startup | Keeps phases aligned; gate passes | Requires ST table edits |
| B | Move `CidrMatcher` and `main.ts` fail-closed wiring into Phase 1 | Preserves ST text | Larger Phase 1; mixes concerns |
| C | Keep ST text; accept Phase 1 gate failure | No doc work | Blocks execution |

**Recommendation:** Option A. Rescope ST-1/4/5 to `loadConfig` key/message/no-value assertions; let ST-33 own process exit, no bind, and no migration connection. Split ST-9 into Phase 1 CIDR parsing and Phase 2 matcher cases (extend ST-20). Update the migration startup test in the same Phase 2 task.

**User Decision:** AI — delegated by `--auto-design` (test sequencing; see D-4).

### PF-005: `toRedactedConfig` can leak the database password 🟠 MAJOR

**Dimension:** 8 — Security Blind Spots (also 13)
**Location:** `03-01-configuration-keyring.md` §New Types (lines 42-64), §Redacted support output (lines 155-165); `07-testing-strategy.md` ST-7
**Codebase Evidence:** `OpenVaultConfig.database: PostgreSQLConfig`; `parseDatabaseUrl` sets `config.pass` at `apps/server/src/db/url.ts:75-78`; `PostgreSQLConfig.pass` is the password.

**The Problem:** `toRedactedConfig` masks the password in `databaseUrl` and says "all other validated values as-is." The sibling `database` object contains the same password in `database.pass`; a naive spread leaks it. ST-7's contract ("Neither secret appears") cannot be satisfied by the current wording, and a support dump would expose the DB credential.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Explicit allowlist; omit raw `databaseUrl`; return structured DB fields with `pass: "***"` | Fail-closed; preserves support fields; no raw URL | Must enumerate safe fields |
| B | Keep both; mask `database.pass` | Small diff | Two secret-bearing representations; relies on masking every field |
| C | Remove `database` from `OpenVaultConfig` | One representation | More plumbing at the DB consumer |

**Recommendation:** Option A. Build the dump from an allowlist; include `database: { host, port, database, user, pass: "***" }` and the other non-secret validated fields; never include `databaseUrl` or raw env. Test the serialized output for the known password and client secret. This is fail-closed for future secret fields.

**User Decision:** AI — delegated by `--auto-design` (redaction mechanism; see D-5).

### PF-006: ST-35 violates spec-first ordering and the immutable oracle 🟠 MAJOR

**Dimension:** 7 — Testability (also 11)
**Location:** `07-testing-strategy.md:29,88`; `99-execution-plan.md:72,117`
**Codebase Evidence:** `apps/server/tests/ready.test.ts:3,8,11` uses `createApp`, `app.start()`, and `/v1/ready`; `03-03:23,93-94` removes that route and changes the factory.

**The Problem:** ST-35 is listed under specification tests but mapped to `ready.test.ts`, not a `.spec.test.ts`. It is created in implementation task 2.2.5, then "updated" in Phase 4 task 4.1.1 after implementation. Spec tests are immutable oracles; rewriting expectations after implementation is prohibited. The legacy test also breaks the Phase 2 gate because it uses removed APIs/routes.

**Options:**

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Move ST-35 to Phase 2 Session 1 as `ready.spec.test.ts`; define the factory contract first | Test-first; pins AC5 | `/ready` probe assertions need Phase 3 |
| B | Reclassify ST-35 as a plan-local harness implementation test; keep AC5 mapped; replace `ready.test.ts` in 2.2.5 | Category-correct; keeps spec-first where product behavior lives | AC5 is verified by an impl test |
| C | Keep as-is; adjust post-implementation | No doc work | Violates the immutable oracle |

**Recommendation:** Option B. Split into `test-app.impl.test.ts` (factory seam, `.express`, `start()` throws, no plaintext bind) and `ready.impl.test.ts` (`/ready` with injected probes); define `createTestApplication` in 03-02; remove ST-35 from the spec table and remove the Phase 4 ST-35 update. Product `/ready` behavior remains covered by ST-28/ST-29.

**User Decision:** AI — delegated by `--auto-design` (test classification; see D-6).

### PF-007: Existing migration startup tests become vacuous 🟡 MINOR

**Dimension:** 13 — Codebase Alignment (test impact)
**Location:** `02-current-state.md` §Relevant Files; `99-execution-plan.md` Phase 2
**Codebase Evidence:** `apps/server/tests/integration/migrations.spec.test.ts:148-197` spawns `src/main.ts` with only `PORT`/`OPENVAULT_DB_URL` and asserts non-zero exit.

**The Problem:** After config-first startup, both spawns exit on missing required config before migrations. The missing-DB-URL test matches `config` in its regex; the tampered-history test asserts only non-zero. Both pass for the wrong reason and stop proving migration refusal.

**Recommendation:** Update both spawns with a complete valid config fixture (keyring `0600`, TLS cert/key, CA, base URL) and assert a migration-specific failure; add this to Phase 2 task 2.1.1.

**User Decision:** AI — delegated by `--auto-design` (test fixture update).

### PF-008: Config values outside the RD-02 contract (max bytes, `ENV_MODE`) 🟡 MINOR

**Dimension:** 1 — Ambiguities (also 4)
**Location:** `03-01-configuration-keyring.md:54-55,129`; `03-02-transport-listeners.md:169-178`; ST-22
**Codebase Evidence:** `OpenVaultConfig` stores `secretMaxBytes`/`certMaxBytes`; the transport hardcodes 64 KiB/128 KiB and the WebAFX bridge passes `BODY_LIMIT: "128kb"`.

**The Problem:** The plan validates two documented settings but never uses them. An operator who lowers `OPENVAULT_SECRET_MAX_BYTES` still gets 64 KiB accepted; one who raises the cert limit still gets 413. The precedence between the transport guardrail and the product limit is unstated. The same config contract left `ENV_MODE` (the WebAFX stack-trace switch) outside the typed loader, so a production process could opt into stack traces without validation.

**Recommendation:** State the precedence explicitly: RD-02's transport guardrails are fixed at 64/128 KiB; `OPENVAULT_SECRET_MAX_BYTES`/`CERT_MAX_BYTES` are product-value limits enforced in RD-08/RD-09 and do not change the transport boundary. ST-22 exercises the fixed guardrails. Add `ENV_MODE` to `OpenVaultConfig` with a `production` default so the stack-trace switch is validated. This is the smallest correction and preserves RD-02 AC8.

**User Decision:** AI — delegated by `--auto-design` (config precedence).

### PF-009: TLS material validation has no specification test 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** `03-02-transport-listeners.md` §TLS Material (lines 78-88); `07-testing-strategy.md` ST-5/ST-29
**The Problem:** ST-5 covers missing/unreadable TLS cert/key/CA. The plan also requires key/cert match, `CA:TRUE`, and self/CA verification; a regression accepting a mismatched key or a non-CA certificate would pass the current ST set. ST-29's malformed-CA case uses injected readiness probes, not a real `TlsMaterial` parse.

**Recommendation:** Add ST-39 in the Phase 2 transport suite for malformed PEM, mismatched key, non-CA certificate, and failed self-verification. Keep ST-5 as the Phase 1 loader-level case.

**User Decision:** AI — delegated by `--auto-design` (test coverage).

### PF-010: Deployment documentation drift 🟡 MINOR

**Dimension:** 13 — Codebase Alignment (impact blindness)
**Location:** `03-04-deployment-docs.md` §Documentation (lines 83-99); `99-execution-plan.md` task 4.2.2
**Codebase Evidence:** `docs/guide/install.md:66-74` says 8443 is internal `vault_net`; `docs/guide/docker-compose.md:23` points agents at `https://openvaultd:8443`; `docs/architecture/overview.md` and `docs/security/threat-model.md` describe the old topology/keyring.

**The Problem:** The plan updates only `docs/reference/configuration.md`, `deploy/compose/README.md`, and `CONTRIBUTING.md`. After the change, 8443 is the proxy-only admin listener on `admin_net`, 8444 is the mTLS agent listener on `vault_net`, and age/passphrase is unsupported until RD-13. The agent guide would point agents at the admin listener, where the source guard rejects them.

**Recommendation:** Extend the documentation task to `docs/guide/install.md`, `docs/guide/docker-compose.md`, `docs/architecture/overview.md`, and `docs/security/threat-model.md`; state the 8443/8444 split and the age deferral. Add network/port assertions to ST-34.

**User Decision:** AI — delegated by `--auto-design` (documentation alignment).

### PF-011: Pino redaction is one level deep; "full" claim overstated 🟡 MINOR

**Dimension:** 8 — Security Blind Spots
**Location:** `03-03-readiness-observability.md` §Logging (lines 104-133); `00-index.md:90`; ST-31
**Codebase Evidence:** `pino-logger-provider.js:97-101`; verified `*.token` redacts `{a:{token}}` but not `{a:{b:{token}}}`.

**The Problem:** The plan claims "full sensitive-field redaction." Pino wildcards match one level; a nested secret at depth two leaks. ST-31 only tests flat fields.

**Recommendation:** Add the known request-body paths (`req.body.password`, `req.body.token`, `req.body.value`, `req.body.privateKey`), add a nested-field ST-31 case, and state the rule: handlers must not log raw request bodies, config objects, or arbitrary nested objects; use explicit fields. Remove the "full recursive" implication.

**User Decision:** AI — delegated by `--auto-design` (logging rule).

### PF-012: Readiness pool timeout is specified at the wrong level 🟡 MINOR

**Dimension:** 2 — Implicit Assumptions (also 13)
**Location:** `03-03-readiness-observability.md:51-53`
**Codebase Evidence:** `database.d.ts:26,41` places `connectionTimeoutMillis` in `poolConfig`; `database.js:81-92` reads `poolConfig?.connectionTimeoutMillis`.

**The Problem:** The plan says the pool is "constructed with `connectionTimeoutMillis: 2_000`." A top-level field is ignored; the pool falls back to no connection timeout. The outer `Promise.race` still returns 503, but stalled connection attempts continue and can accumulate.

**Recommendation:** Specify `poolConfig: { connectionTimeoutMillis: 2_000 }`.

**User Decision:** AI — delegated by `--auto-design` (adapter API correction).

### PF-013: Readiness fake-injection seam is not type-safe 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** `03-03-readiness-observability.md:33-46`; `07-testing-strategy.md:16,190-191`
**The Problem:** `ReadinessProbe` is declared but unused; `ReadinessService` takes concrete `PostgreSQLDatabase`, `KeyringProvider`, and `TlsMaterial`. The plan says tests inject fake probes, but doing so requires an unsafe cast (forbidden) or spying on real instances.

**Recommendation:** Accept `ReadinessProbe[]` or per-probe interfaces in the service, or explicitly use `vi.spyOn` on real instances with no unsafe casts. Prefer the probe interfaces.

**User Decision:** AI — delegated by `--auto-design` (test seam).

### PF-014: `KeyringProvider` has no redacted serialization contract 🟡 MINOR

**Dimension:** 8 — Security Blind Spots (also 13)
**Location:** `03-01-configuration-keyring.md` §Server provider (lines 208-218); ST-12
**The Problem:** The plan says `JSON.stringify(provider)` returns status only, but no provider `toJSON` or inspect hook is defined. A TypeScript `private` keyring field is enumerable; `JSON.stringify` would emit the keyring object (redacted by `Keyring.toJSON`, but not "status only"), and a future raw field could leak.

**Recommendation:** Add `toJSON(): { loaded, currentId?, keyCount }` and `[Symbol.for("nodejs.util.inspect.custom")]` to `KeyringProvider`; test both.

**User Decision:** AI — delegated by `--auto-design` (key custody).

### PF-015: Findings ledger is missing 🟡 MINOR

**Dimension:** 4 — Completeness Gaps (also 12)
**Location:** `00-index.md` Document Index; `99-execution-plan.md` Success Criteria 5 and phase tasks
**The Problem:** Success Criterion 5 and four phase tasks require a "findings ledger," but the plan has no `05-findings.md` and no index row. RD-01 uses `05-findings.md` for this purpose.

**Recommendation:** Add `05-findings.md` in the RD-01 format, add it to the document index, and reference it from the review tasks. The preflight findings remain in this report; the ledger records execution-phase rulings.

**User Decision:** AI — delegated by `--auto-design` (process artifact).

### PF-016: Clock-skew boundary test is missing 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** `03-03-readiness-observability.md:150-164,188-189`; `07-testing-strategy.md` ST-27–ST-32; `99-execution-plan.md:91`
**The Problem:** 03-03 says ST-27–ST-32 cover clock-skew boundaries, but ST-32 is request-ID/logging and no ST exercises `isWithinClockSkew`. AC13 has no direct ST coverage, contradicting Success Criterion 2.

**Recommendation:** Add ST-38 for exact-30 s acceptance, 30 s + 1 ms rejection, and early/late boundaries with an injected clock; map it to `apps/server/tests/clock.spec.test.ts` and task 3.1.1.

**User Decision:** AI — delegated by `--auto-design` (test coverage).

### PF-017: Non-`/v1` API prefix denial has no test 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** `07-testing-strategy.md` ST-19/ST-24; RD-02 AC11
**The Problem:** AC11 requires `/v1` to be the only API prefix. ST-19 tests path variants under `/v1`; ST-24 tests an unnamed unknown route. No ST asserts that `/v2/...` or an unversioned `/api/...` is denied.

**Recommendation:** Extend ST-19 with `/v2/secrets/x` and `/api/v1/secrets/x` denial cases; they belong with the existing scope-denial matrix.

**User Decision:** AI — delegated by `--auto-design` (test coverage).

### PF-018: `OPENVAULT_AGENT_PORT` is documented as required but defaults 🟡 MINOR

**Dimension:** 12 — Consistency
**Location:** `03-04-deployment-docs.md:88-89`; RD-02 configuration table; `03-01-configuration-keyring.md`
**The Problem:** 03-04 says `OPENVAULT_AGENT_PORT` and `OPENVAULT_INTERNAL_CA` are required. RD-02 marks the agent port optional with default 8444, and the plan's `OpenVaultConfig` defaults it.

**Recommendation:** Say `OPENVAULT_INTERNAL_CA` is required; `OPENVAULT_AGENT_PORT` is optional with default 8444. Keep the Compose value explicit.

**User Decision:** AI — delegated by `--auto-design` (docs consistency).

### PF-019: Admin/agent port collision is not rejected 🟡 MINOR

**Dimension:** 9 — Edge Cases
**Location:** `03-01-configuration-keyring.md` §Port precedence (lines 96-101); `03-02-transport-listeners.md` §Startup (lines 225-239)
**The Problem:** Each port is validated 1–65535 independently. `OPENVAULT_AGENT_PORT=8443` passes config, migrations, and keyring/TLS loading, then fails at the second bind with `EADDRINUSE`. Startup still fails closed, but late, and with an OS error instead of a keyed config error.

**Recommendation:** Reject `agentPort === adminPort` in `loadConfig` with a `ConfigError` naming both variables.

**User Decision:** AI — delegated by `--auto-design` (validation).

### PF-020: ST-34 has no declared Compose/Caddy parser 🟡 MINOR

**Dimension:** 5 — Dependency Issues (also 7)
**Location:** `07-testing-strategy.md:28,87`; `99-execution-plan.md:117`; `package.json`
**The Problem:** ST-34 says "Parse Compose and Caddy configuration." The root workspace has no direct `yaml` dependency (only transitive via changesets/vitepress), and no Caddyfile parser. `import "yaml"` from a root test fails resolution.

**Recommendation:** Add `yaml` as a root devDependency and a Phase 4 task step (no production dependency change), and use `caddy validate` for Caddy when available; or reword ST-34 to explicit text assertions. Prefer the parser + `caddy validate` for reliability.

**User Decision:** AI — delegated by `--auto-design` (test tooling).

### PF-021: Keyring provisioning is an unlisted dependency 🟡 MINOR

**Dimension:** 5 — Dependency Issues (also 4)
**Location:** `03-01-configuration-keyring.md` §Keyring Hardening (lines 167-204); `03-04-deployment-docs.md:23-26`; `01-requirements.md` deferred list
**The Problem:** `Keyring.toJSON()` is the only serializer for the on-disk keyring shape; the plan changes it to redacted status and defers export to RD-13. The reference stack's `openvault-init` runs `ov init --prepare`, which is RD-11. RD-02 tests can use fixtures, but the reference stack cannot create the required keyring until RD-11/RD-13, and that dependency is not in the deferred list.

**Recommendation:** Add `ov init`/keyring provisioning to the deferred list with RD-11/RD-13 owners; state that the reference stack is not bootable until that lands and RD-02 verifies the server with fixtures. This records the accepted cross-RD dependency without expanding RD-02.

**User Decision:** AI — delegated by `--auto-design` (dependency documentation).

### PF-022: ST-13's zeroization criterion is not executable 🟡 MINOR

**Dimension:** 7 — Testability
**Location:** `07-testing-strategy.md` ST-13; `03-01-configuration-keyring.md` §Core API
**The Problem:** ST-13 includes "internal key buffers are zeroed in code review." Code review is not an executable oracle; once `destroy()` clears the map, no test can observe the buffers. The test proves idempotence and that access throws, not zeroization.

**Recommendation:** Move zeroization to the documented manual/code-review gate; have ST-13 assert only observable behavior (idempotent destroy, `withCurrentKey`/`withKey` throw). Keep the best-effort limitation documented.

**User Decision:** AI — delegated by `--auto-design` (test scope).

### PF-023: Body-parser skip mechanism is misstated 🟡 MINOR

**Dimension:** 2 — Implicit Assumptions (also 13)
**Location:** `03-02-transport-listeners.md` §Limits; `00-ambiguity-register.md` R8; `02-current-state.md` risk table; `07-testing-strategy.md` impl table; `99-execution-plan.md` task 2.3.1
**Codebase Evidence:** `body-parser@2.4.0/lib/read.js:46,245` skips only when `onFinished.isFinished(req)` is true; no `req._body` check exists in body-parser 2.4.0. A double-parser probe confirms the second parser's `verify` is not called.

**The Problem:** The plan says "the custom parser sets `req._body`, WebAFX skips it" and schedules a `req._body` regression test. That mechanism does not exist in the installed body-parser. The behavior is currently correct because the custom parser consumes the stream, but the stated mechanism and test prove the wrong invariant; a parser-order regression could bypass the 64 KiB check without the test noticing.

**Recommendation:** Document the real `onFinished.isFinished(req)` skip, test that the body is parsed exactly once and the pre-parser limit still wins, and keep the 128 KiB WebAFX ceiling as a backstop.

**User Decision:** AI — delegated by `--auto-design` (parser regression test).

### PF-024: AR cross-reference and adapter wording 🔵 OBSERVATION

**Dimension:** 12 — Consistency
**Location:** `01-requirements.md:52` (cites AR-16 for the network); `00-index.md:40` ("one-method adapter")
**The Problem:** The reference-network row cites AR-16 (timeouts) instead of AR-25 (structure/deployment); the "one-method adapter" wording understates the adapter's `prepare`/`startTransport`/`start` contract.

**Recommendation:** Cite AR-7/AR-25 and describe it as a small secure-listener adapter with one owned lifecycle, not a one-method adapter.

**User Decision:** AI — delegated by `--auto-design` (documentation consistency).

## Delegated Resolution Provenance

### D-1 — Pre-routing correlation and logging (PF-001)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** observability mechanism inside RD-02's approved transport and error contract.
- **Objective:** every rejection carries a request ID and is logged once, while WebAFX remains the single envelope renderer.
- **Decision:** correlation middleware + pre-stack log-and-forward error middleware; `createLoggerPlugin(provider)`; message-first `warn(message, data)`; WebAFX renders.
- **Evidence:** `web-application.js:189-192,298-303`; `request-id-middleware.js:37-55`; `error-handler-middleware.js:34-41`.
- **Rejected alternatives:** correlation only (unlogged rejections); pre-stack renderer (duplicate envelope); override core middleware (larger change); accept the gap (fails AC11/ST-32).
- **Strongest counterargument:** reusing an inbound UUID lets a rejected peer choose its correlation ID; the ID is not an auth control, and WebAFX already reuses valid upstream IDs.
- **Confidence:** High.
- **Hardening:** independent challenger converged on the same option (B′), adding the log-forward refinement and the `!req.services` guard.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** WebAFX moves request-ID/context installation before core middleware; a pre-stack rejection is double-logged.

### D-2 — Readiness failure mapping (PF-002)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** internal error mapping inside the approved readiness contract.
- **Objective:** `GET /ready` returns 200 when ready and 503 `not_ready` on dependency failure; genuine bugs remain 500.
- **Decision:** await the service; catch only `ReadinessError`; throw `ApiError(503, "not_ready", "Not ready")`; log the fixed probe name through `req.log.warn("readiness probe failed", { probe })` in the controller.
- **Evidence:** `service-container.d.ts:118`; `error-handler-middleware.js:44-67`.
- **Rejected alternatives:** service throws `ApiError` (HTTP coupling); result union (more mapping code); blanket catch (turns bugs into 503).
- **Strongest counterargument:** exceptions for an expected operational state are less clean than a result union; the result union is viable but larger.
- **Confidence:** High.
- **Hardening:** challenger converged (A′), adding the narrow-catch refinement.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** `ReadinessService.check()` changes to a result type; `/ready` gains more failure classes.

### D-3 — Caddy timeout placement (PF-003)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** deployment mechanism inside RD-02's approved proxy hardening.
- **Objective:** enforce client header/body timeouts and upstream read/write/idle limits with a Caddyfile that loads.
- **Decision:** global `servers { timeouts { read_header 10s; read_body 30s; write 30s; idle 120s } }`; `transport http { read_timeout 30s; write_timeout 30s; keepalive 10s }`; `caddy validate`.
- **Evidence:** `deploy/compose/Caddyfile:8-13`; Caddy reverse_proxy/http transport/server timeouts documentation.
- **Rejected alternatives:** transport-only (client-leg timeouts missing); Node-only (fails RD-02 proxy requirement); invalid `idle_timeout` (fails to load).
- **Strongest counterargument:** global `write`/`idle` could cut future long-lived connections; RD-02 has no streaming endpoints and 30 s matches the origin `requestTimeout`.
- **Confidence:** High.
- **Hardening:** challenger converged (B), adding global timeouts and the keepalive-below-origin constraint.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** RD-12/RD-13 adds streaming or long-lived connections; Caddy changes timeout syntax.

### D-4 — Phase 1/Phase 2 test sequencing (PF-004)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** test sequencing inside the approved specification-first protocol.
- **Objective:** each phase gate passes with tests that exercise only behavior implemented in that phase.
- **Decision:** rescope ST-1/4/5 to loader-level assertions; split ST-9 into Phase 1 CIDR parsing and Phase 2 matcher cases; ST-33 owns process startup; update the migration startup test in Phase 2.
- **Evidence:** `03-02:133-138,225-239`; `99:32,49,72`.
- **Rejected alternatives:** move matcher/startup into Phase 1 (mixes concerns); accept a failing gate (blocks execution).
- **Strongest counterargument:** moving process assertions to Phase 2 could let a loader pass without startup wiring; ST-33 explicitly covers exit/no-bind/no-migration.
- **Confidence:** High.
- **Hardening:** challenger converged (A), adding the migration-test companion.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** Phase 1 gains a process-level test harness; the config loader starts binding or migrating.

### D-5 — Redacted support output (PF-005)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** redaction mechanism inside the approved key/config custody policy.
- **Objective:** a support dump never contains the DB password, OIDC secret, or raw env.
- **Decision:** explicit allowlist; omit raw `databaseUrl`; include `database: { host, port, database, user, pass: "***" }`; test the serialized output.
- **Evidence:** `url.ts:69-78`; `database.d.ts:94`; `03-01:157-165`.
- **Rejected alternatives:** mask only `database.pass` (two secret-bearing shapes); remove `database` (more plumbing); accept the leak (fails ST-7).
- **Strongest counterargument:** omitting `databaseUrl` changes the documented shape and support may expect a URL; the structured fields preserve the useful information without the secret.
- **Confidence:** High.
- **Hardening:** challenger converged (A′), preferring the allowlist and structured DB fields.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** `OpenVaultConfig` gains another secret field; RD-11 needs a URL-shaped dump.

### D-6 — ST-35 classification (PF-006)

- **Authority:** AI — delegated by `--auto-design`
- **Eligibility:** test classification inside the approved testing strategy.
- **Objective:** preserve the immutable-oracle rule and keep plan-local AC5 verified without a stale test.
- **Decision:** reclassify ST-35 as plan-local harness implementation tests (`test-app.impl.test.ts`, `ready.impl.test.ts`); keep AC5 mapped; replace `ready.test.ts` in task 2.2.5; remove the Phase 4 ST-35 update.
- **Evidence:** `ready.test.ts:3,8,11`; `03-03:23,93-94`; `99:72,117`.
- **Rejected alternatives:** spec test in Phase 2 (probe assertions need Phase 3); keep as-is (immutable-oracle violation); drop AC5 (loses the harness contract).
- **Strongest counterargument:** a spec test in Phase 2 is test-first and pins the factory contract; but the harness is not product behavior, and the `/ready` spec is already ST-28/ST-29.
- **Confidence:** High.
- **Hardening:** challenger diverged from the initial fix and proposed B′; the lead adopted B′ after reconciliation.
- **Policy version:** 1
- **Root invocation ID:** `ov-rd02-preflight-20261030-01`
- **Reopen triggers:** `createTestApplication` becomes a production seam; `/ready` behavior moves out of ST-28/ST-29.

## Accepted Notes

1. **Human review:** the plan was authored in a prior session; this preflight was run by the same model family. An independent human security review is still recommended before production, per RD-14.
2. **Caddy runtime:** the corrected Caddyfile is syntax-checked when Caddy/Docker is available; the automated ST-34 assertions cover the exact directives and the absence of `idle_timeout` under `reverse_proxy`.
3. **OpenSSL:** transport integration tests require the system `openssl`; CI is Linux and the prerequisite is documented in `CONTRIBUTING.md`.

## Verification Evidence

| Check | Result |
|---|---|
| 13-dimension scan | 24 findings: 0 critical, 6 major, 17 minor, 1 observation |
| Independent cluster audits | 5 clusters; 45 raw findings merged/deduplicated |
| Recommendation hardening | One independent challenger for the 6 major findings; converged on all 6 (one refined option) |
| Scoped re-review | 1 regression (object-first `req.log` call) + 6 minor + 1 observation; all fixed, including the message-first WebAFX `Logger` signature and the factory/probe injection contract; no remaining blocking findings |
| Codebase references | 41 mapped; 39 verified; 2 runtime-only |
| Plan fixes applied | 03-01, 03-02, 03-03, 03-04, 07, 99, 00-index, 01-requirements, 02-current-state, 00-ambiguity-register; `05-findings.md` added |
| Docs-only change | `pnpm verify` passed (build, typecheck, Biome, unit/root tests, artifact/React checks, docs build); `git diff --check`; markdown link check; no source-code change |
| Roadmap | RD-02 advanced to Plan Preflighted |

## Verdict

**✅ PREFLIGHT PASSED — all 24 findings resolved.**

The plan is ready for execution. The first execution step remains a specification test (Phase 1 Session 1), and the Phase 1 gate is scoped to loader-level behavior.

# Execution Plan: RD-02 Transport, Configuration, and Readiness

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-30 14:59
> **Progress**: 33/33 tasks (100%)
> **CodeOps Artifact Schema**: 1
> **Implements**: openvault-v0-1/RD-02
> **Reasoning**: high — TLS/mTLS, key custody, proxy trust, and startup ordering are security-sensitive.
> **Commit mode**: auto-commit (the executor commits after each verified task with the git-commit skill; no raw git commands appear here).

## Phase Map

| Phase | Name | Tasks |
|---|---|---|
| 1 | Configuration and keyring | 9 |
| 2 | Secure transport and listeners | 10 |
| 3 | Readiness, logging, and errors | 8 |
| 4 | Deployment, documentation, and close-out | 6 |

**Total: 33 tasks across 4 phases, 12 sessions.**

> **Execution rules:** `99-execution-plan.md` is the single source of task progress. Mark a
> task `[~]` only when implementation is complete and verification is in progress, then `[x]`
> immediately after its Verify passes; update the header progress and timestamp at the same
> time. A verified task is committed with the git-commit skill in auto-commit mode. On resume,
> resume at the first unchecked task and re-run its owning phase gate before proceeding.

## Phase 1: Configuration and Keyring

> **Reasoning**: high — fail-closed boot and key custody.
> **Phase baseline tree**: 2604ff0f965273efbe47a570a5a1bb5bd775c757
> **Phase gate**: `pnpm verify`; config/keyring unit suites; `pnpm db:types:check` unchanged.

### Session 1 — Specification tests

- [x] 1.1.1 [spec-author] Write `apps/server/tests/config.spec.test.ts` for ST-1–ST-9 (loader-level only; ST-9 parses CIDRs, matcher cases move to ST-20) and `packages/core/tests/keyring.spec.test.ts` plus `apps/server/tests/keyring.spec.test.ts` for ST-10–ST-14; replace the old `packages/core/tests/crypto.test.ts` round-trip with a base64 fixture and redaction assertions; run them red and record the failures ✅ (completed: 2026-10-30 14:02)
- [x] 1.1.2 [executor] Confirm the red phase proves missing behavior rather than a harness error; update 02-current-state if discovery changes the evidence ✅ (completed: 2026-10-30 14:03)

### Session 2 — Implementation

- [x] 1.2.1 [executor] Add `apps/server/src/config/` with `OpenVaultConfig`, `ConfigError`, `loadConfig`, `ENV_MODE` validation, file/mode/CIDR/URL/duration checks, port precedence and collision rejection, and the allowlist-based `toRedactedConfig` (ST-1–ST-9, AR-11, AR-12, AR-23) ✅ (completed: 2026-10-30 14:06)
- [x] 1.2.2 [executor] Harden `packages/core/src/keyring.ts` with callback access, redacted `toJSON`/inspect, safe ids, and idempotent `destroy`; adapt `packages/core/src/crypto.ts` and exports (ST-10–ST-13, AR-9) ✅ (completed: 2026-10-30 14:06)
- [x] 1.2.3 [executor] Add `apps/server/src/security/keyring.ts` `KeyringProvider` with exact `0600` loading, status-only `toJSON`/inspect API, disposal, and unsupported age passphrase failure (ST-10, ST-11, ST-14, AR-2, AR-10) ✅ (completed: 2026-10-30 14:06)
- [x] 1.2.4 [executor] Add the WebAFX bridge that passes only standard settings and disables `.env.js` loading (ST-8, AR-11) ✅ (completed: 2026-10-30 14:06)

### Session 3 — Impl tests and hardening

- [x] 1.3.1 [executor] Add impl tests for mapped/zone CIDRs, unsafe key ids, destroyed access, malformed base64, and redacted support output ✅ (completed: 2026-10-30 14:07)
- [x] 1.3.2 [executor] Run the Phase 1 gate: `pnpm verify`, config/keyring suites, and confirm the database schema is unchanged ✅ (completed: 2026-10-30 14:09)
- [x] 1.3.3 [executor] Update `05-findings.md` with the Phase 1 quality review findings and fix every critical/major finding ✅ (completed: 2026-10-30 14:18)

**Deliverables:** typed config, keyring provider, hardened core keyring, unit and impl tests.

---

## Phase 2: Secure Transport and Listeners

> **Reasoning**: high — TLS/mTLS, proxy trust, listener isolation, and request limits.
> **Phase baseline tree**: 949b7a561ebbc29d09a4f1f55444077d9f64b0d9
> **Phase gate**: transport integration suite on an ephemeral TLS fixture; no plaintext listener.

### Session 1 — Specification tests

- [x] 2.1.1 [spec-author] Write `apps/server/tests/integration/helpers/tls.ts`, `transport.spec.test.ts` for ST-15–ST-26 and ST-39, extend ST-19 with non-`/v1` prefix denials and ST-20 with IPv6/mixed-family matcher cases, and the startup spec for ST-33; update both spawns in `apps/server/tests/integration/migrations.spec.test.ts` with a complete valid config fixture and migration-specific assertions; run them red ✅ (completed: 2026-10-30 14:24)
- [x] 2.1.2 [executor] Confirm the red phase includes plaintext rejection, unknown-CA rejection, scope bypass attempts, 413/415, and header assertions ✅ (completed: 2026-10-30 14:24)

### Session 2 — Implementation

- [x] 2.2.1 [executor] Implement `apps/server/src/transport/tls.ts` and `proxy.ts` with certificate/key/CA validation, CIDR matching, mapped-address normalization, and the trust function (ST-15–ST-20, AR-6, AR-8) ✅ (completed: 2026-10-30 14:24)
- [x] 2.2.2 [executor] Implement `apps/server/src/transport/scope.ts`: default-deny scope table, path normalization, malformed-path errors, and listener markers (ST-19, AR-5) ✅ (completed: 2026-10-30 14:24)
- [x] 2.2.3 [executor] Implement request middleware: correlation ID, the shared `PinoLoggerProvider`/`createLoggerPlugin` wiring and pre-stack error logger, strict headers/no-store, URL-encoded rejection, JSON limits/413 mapping, and timeout/connection options (ST-21–ST-25, ST-32, AR-13–AR-16, AR-22) ✅ (completed: 2026-10-30 14:24)
- [x] 2.2.4 [executor] Implement `SecureWebApplication` with `prepare`, dual HTTPS listeners, one shutdown, no plaintext `start()`, and `.env` override (ST-15, ST-18, ST-25, ST-26, AR-4) ✅ (completed: 2026-10-30 14:24)
- [x] 2.2.5 [executor] Rework `app.ts`/`main.ts` startup ordering, add the in-process test factory and replace `apps/server/tests/ready.test.ts` with PL-1 (ST-33, AR-21, AR-28) ✅ (completed: 2026-10-30 14:24)

### Session 3 — Impl tests and hardening

- [x] 2.3.1 [executor] Add impl tests for one-parse parser order (`onFinished.isFinished`), malformed percent encoding, duplicate slash/absolute-form paths, second-listener bind failure, and double stop ✅ (completed: 2026-10-30 14:25)
- [x] 2.3.2 [executor] Run the Phase 2 gate: transport suite, `pnpm verify`, and both PostgreSQL integration suites where the app needs the database ✅ (completed: 2026-10-30 14:27)
- [x] 2.3.3 [executor] Record the Phase 2 security/correctness review findings in `05-findings.md` and fix every critical/major finding ✅ (completed: 2026-10-30 14:37)

**Deliverables:** secure listener adapter, TLS material, scope/source/limit middleware, startup wiring.

---

## Phase 3: Readiness, Logging, and Errors

> **Reasoning**: high — truthful dependency state and no secret leakage.
> **Phase baseline tree**: ddd527031f0b4e66f3be167ab013f1ec2cf31ae4
> **Phase gate**: readiness success/failure matrix, captured pino redaction, error envelope tests.

### Session 1 — Specification tests

- [x] 3.1.1 [spec-author] Write readiness, logging, and clock-skew tests for ST-27–ST-32 and ST-38; run them red ✅ (completed: 2026-10-30 14:40)
- [x] 3.1.2 [executor] Confirm readiness failures are distinguishable from liveness and that no test logs a real secret ✅ (completed: 2026-10-30 14:40)

### Session 2 — Implementation

- [x] 3.2.1 [executor] Implement `apps/server/src/readiness/service.ts`, the disposable PostgreSQL pool, root `ReadyController`, and the `not_ready` error (ST-27–ST-30, AR-17–AR-19) ✅ (completed: 2026-10-30 14:40)
- [x] 3.2.2 [executor] Finish the logger wiring with the documented redaction paths, the `Express.Request.log` augmentation, request IDs, parser error mapping, generic production errors, and the 30 s clock-skew helper (ST-31, ST-32, ST-38, AR-20, AR-22, AR-26) ✅ (completed: 2026-10-30 14:40)
- [x] 3.2.3 [executor] Add the readiness database failure path with a bounded timeout and ensure pool/keyring disposal on shutdown (ST-29, ST-30) ✅ (completed: 2026-10-30 14:40)

### Session 3 — Impl tests and hardening

- [x] 3.3.1 [executor] Add impl tests for timeout cleanup, fixed probe names, double shutdown, logger destination flushing, and the root `/ready` harness (PL-2) ✅ (completed: 2026-10-30 14:42)
- [x] 3.3.2 [executor] Run the Phase 3 gate: readiness/logging suites, `pnpm verify`, and PostgreSQL 16/17 readiness integration ✅ (completed: 2026-10-30 14:43)
- [x] 3.3.3 [executor] Record the Phase 3 quality review findings in `05-findings.md` and fix every critical/major finding ✅ (completed: 2026-10-30 14:46)

**Deliverables:** `/ready`, liveness, logging/redaction, error contract, clock-skew helper.

---

## Phase 4: Deployment, Documentation, and Close-out

> **Reasoning**: medium — configuration/deployment alignment with a small code surface.
> **Phase gate**: deployment spec, docs build, full verify, both integration versions, audit.

### Session 1 — Deployment tests

- [x] 4.1.1 [spec-author] Add `yaml` as a root devDependency; write `tests/deploy.spec.test.mjs` for ST-34 (structured Compose parse; Caddy text assertions; `caddy validate` when available) and update ST-36 expectations; run red ✅ (completed: 2026-10-30 14:48)

### Session 2 — Deployment and docs

- [x] 4.2.1 [executor] Update `deploy/compose/compose.yaml`, `deploy/compose/Caddyfile`, and `deploy/compose/README.md` for `admin_net`, proxy CIDR, CA/agent environment, healthcheck, HSTS, global/transport timeouts, and `caddy validate` (ST-34, AR-7, AR-16, AR-25) ✅ (completed: 2026-10-30 14:48)
- [x] 4.2.2 [executor] Update `docs/reference/configuration.md`, `CONTRIBUTING.md`, `docs/guide/install.md`, `docs/guide/docker-compose.md`, `docs/architecture/overview.md`, `docs/security/threat-model.md`, and the relevant hardening note with the implemented contract, the 8443/8444 split, OpenSSL test prerequisite, keyring requirement/provisioning deferral, and age deferral (ST-34) ✅ (completed: 2026-10-30 14:48)

### Session 3 — Final verification and close-out

- [x] 4.3.1 [executor] Run `pnpm verify`, `pnpm audit:prod`, `pnpm audit:full`, PostgreSQL 16/17 integration, and `pnpm db:types:check`; record evidence ✅ (completed: 2026-10-30 14:51)
- [x] 4.3.2 [executor] Run the Phase 4 quality review, record it in `05-findings.md`, and fix every critical/major finding ✅ (completed: 2026-10-30 14:56)
- [x] 4.3.3 [executor] Advance the feature roadmap to `Executing`/`Done` as appropriate (preflight already recorded `Plan Preflighted`) and prepare the PR summary with the RD-02 acceptance mapping ✅ (completed: 2026-10-30 14:59)

**Deliverables:** deployment/docs alignment, verification evidence, final plan state.

## Verification Evidence (2026-10-30)

| Check | Result |
|---|---|
| `pnpm verify` | Passed (build, typecheck, Biome, unit/root tests, artifact/React checks, docs) |
| `pnpm audit:prod` / `pnpm audit:full` | No known vulnerabilities |
| PostgreSQL 16 integration | 5 files, 63 tests passed |
| PostgreSQL 17 integration | 5 files, 63 tests passed |
| `pnpm db:types:check` | Passed against a migrated database; no schema drift |
| Deployment/artifact root tests | 12 tests passed (Caddy validated in the pinned image) |
| Transport spec + impl | 24 tests passed |
| Readiness/logging/clock/harness | 13 unit tests and 9 readiness integration tests passed |

## Success Criteria

1. [x] All 33 tasks completed.
2. [x] RD-02 acceptance criteria 1–15 have direct ST coverage or an explicit deferred owner:
   - AR-2 (age keyring) → RD-13;
   - AR-3 (agent fingerprint/expiry/revocation) → RD-05;
   - OIDC/auth/session flows → RD-03;
   - secret/certificate handlers → RD-08/RD-09.
3. [x] `pnpm verify`, both PostgreSQL integration suites, and both audit commands pass.
4. [x] No new production dependency; no source maps; no key material in logs or build output.
5. [x] The execution plan and `05-findings.md` record every review ruling; preflight decisions remain in `00-preflight-report.md`.

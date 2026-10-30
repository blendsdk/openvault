# Execution Plan: RD-02 Transport, Configuration, and Readiness

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-10-30 12:14
> **Progress**: 0/33 tasks (0%)
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
> **Phase gate**: `pnpm verify`; config/keyring unit suites; `pnpm db:types:check` unchanged.

### Session 1 — Specification tests

- [ ] 1.1.1 [spec-author] Write `apps/server/tests/config.spec.test.ts` for ST-1–ST-9 and `packages/core/tests/keyring.spec.test.ts` plus `apps/server/tests/keyring.spec.test.ts` for ST-10–ST-14; run them red and record the failures
- [ ] 1.1.2 [executor] Confirm the red phase proves missing behavior rather than a harness error; update 02-current-state if discovery changes the evidence

### Session 2 — Implementation

- [ ] 1.2.1 [executor] Add `apps/server/src/config/` with `OpenVaultConfig`, `ConfigError`, `loadConfig`, file/mode/CIDR/URL/duration checks, port precedence, and `toRedactedConfig` (ST-1–ST-9, AR-11, AR-12, AR-23)
- [ ] 1.2.2 [executor] Harden `packages/core/src/keyring.ts` with callback access, redacted `toJSON`/inspect, safe ids, and idempotent `destroy`; adapt `packages/core/src/crypto.ts` and exports (ST-10–ST-13, AR-9)
- [ ] 1.2.3 [executor] Add `apps/server/src/security/keyring.ts` `KeyringProvider` with exact `0600` loading, status-only API, disposal, and unsupported age passphrase failure (ST-10, ST-11, ST-14, AR-2, AR-10)
- [ ] 1.2.4 [executor] Add the WebAFX bridge that passes only standard settings and disables `.env.js` loading (ST-8, AR-11)

### Session 3 — Impl tests and hardening

- [ ] 1.3.1 [executor] Add impl tests for mapped/zone CIDRs, unsafe key ids, destroyed access, malformed base64, and redacted support output
- [ ] 1.3.2 [executor] Run the Phase 1 gate: `pnpm verify`, config/keyring suites, and confirm the database schema is unchanged
- [ ] 1.3.3 [executor] Record the Phase 1 quality review findings and fix every critical/major finding

**Deliverables:** typed config, keyring provider, hardened core keyring, unit and impl tests.

---

## Phase 2: Secure Transport and Listeners

> **Reasoning**: high — TLS/mTLS, proxy trust, listener isolation, and request limits.
> **Phase gate**: transport integration suite on an ephemeral TLS fixture; no plaintext listener.

### Session 1 — Specification tests

- [ ] 2.1.1 [spec-author] Write `apps/server/tests/integration/helpers/tls.ts`, `transport.spec.test.ts` for ST-15–ST-26, and the startup spec for ST-33; run them red
- [ ] 2.1.2 [executor] Confirm the red phase includes plaintext rejection, unknown-CA rejection, scope bypass attempts, 413/415, and header assertions

### Session 2 — Implementation

- [ ] 2.2.1 [executor] Implement `apps/server/src/transport/tls.ts` and `proxy.ts` with certificate/key/CA validation, CIDR matching, mapped-address normalization, and the trust function (ST-15–ST-20, AR-6, AR-8)
- [ ] 2.2.2 [executor] Implement `apps/server/src/transport/scope.ts`: default-deny scope table, path normalization, malformed-path errors, and listener markers (ST-19, AR-5)
- [ ] 2.2.3 [executor] Implement request middleware: strict headers/no-store, URL-encoded rejection, JSON limits/413 mapping, and timeout/connection options (ST-21–ST-25, AR-13–AR-16)
- [ ] 2.2.4 [executor] Implement `SecureWebApplication` with `prepare`, dual HTTPS listeners, one shutdown, no plaintext `start()`, and `.env` override (ST-15, ST-18, ST-25, ST-26, AR-4)
- [ ] 2.2.5 [executor] Rework `app.ts`/`main.ts` startup ordering and add the in-process test factory (ST-33, ST-35, AR-21)

### Session 3 — Impl tests and hardening

- [ ] 2.3.1 [executor] Add impl tests for parser order (`req._body`), malformed percent encoding, duplicate slash/absolute-form paths, second-listener bind failure, and double stop
- [ ] 2.3.2 [executor] Run the Phase 2 gate: transport suite, `pnpm verify`, and both PostgreSQL integration suites where the app needs the database
- [ ] 2.3.3 [executor] Record the Phase 2 security/correctness review findings and fix every critical/major finding

**Deliverables:** secure listener adapter, TLS material, scope/source/limit middleware, startup wiring.

---

## Phase 3: Readiness, Logging, and Errors

> **Reasoning**: high — truthful dependency state and no secret leakage.
> **Phase gate**: readiness success/failure matrix, captured pino redaction, error envelope tests.

### Session 1 — Specification tests

- [ ] 3.1.1 [spec-author] Write readiness, logging, and clock-skew tests for ST-27–ST-32; run them red
- [ ] 3.1.2 [executor] Confirm readiness failures are distinguishable from liveness and that no test logs a real secret

### Session 2 — Implementation

- [ ] 3.2.1 [executor] Implement `apps/server/src/readiness/service.ts`, the disposable PostgreSQL pool, root `ReadyController`, and the `not_ready` error (ST-27–ST-30, AR-17–AR-19)
- [ ] 3.2.2 [executor] Wire `pinoLoggerPlugin`, full redaction paths, request IDs, parser error mapping, generic production errors, and the 30 s clock-skew helper (ST-31, ST-32, AR-20, AR-22)
- [ ] 3.2.3 [executor] Add the readiness database failure path with a bounded timeout and ensure pool/keyring disposal on shutdown (ST-29, ST-30)

### Session 3 — Impl tests and hardening

- [ ] 3.3.1 [executor] Add impl tests for timeout cleanup, fixed probe names, double shutdown, and logger destination flushing
- [ ] 3.3.2 [executor] Run the Phase 3 gate: readiness/logging suites, `pnpm verify`, and PostgreSQL 16/17 readiness integration
- [ ] 3.3.3 [executor] Record the Phase 3 quality review findings and fix every critical/major finding

**Deliverables:** `/ready`, liveness, logging/redaction, error contract, clock-skew helper.

---

## Phase 4: Deployment, Documentation, and Close-out

> **Reasoning**: medium — configuration/deployment alignment with a small code surface.
> **Phase gate**: deployment spec, docs build, full verify, both integration versions, audit.

### Session 1 — Deployment tests

- [ ] 4.1.1 [spec-author] Write `tests/deploy.spec.test.mjs` for ST-34 and update ST-35/ST-36 expectations; run red

### Session 2 — Deployment and docs

- [ ] 4.2.1 [executor] Update `deploy/compose/compose.yaml`, `deploy/compose/Caddyfile`, and `deploy/compose/README.md` for `admin_net`, proxy CIDR, CA/agent environment, healthcheck, HSTS, and timeouts (ST-34, AR-7, AR-16)
- [ ] 4.2.2 [executor] Update `docs/reference/configuration.md`, `CONTRIBUTING.md`, and the relevant hardening note with the implemented contract, OpenSSL test prerequisite, keyring requirement, and age deferral (ST-34)

### Session 3 — Final verification and close-out

- [ ] 4.3.1 [executor] Run `pnpm verify`, `pnpm audit:prod`, `pnpm audit:full`, PostgreSQL 16/17 integration, and `pnpm db:types:check`; record evidence
- [ ] 4.3.2 [executor] Run the Phase 4 quality review and fix every critical/major finding
- [ ] 4.3.3 [executor] Update the feature roadmap to `Plan Created`/`Plan Preflighted` as appropriate and prepare the PR summary with the RD-02 acceptance mapping

**Deliverables:** deployment/docs alignment, verification evidence, final plan state.

## Success Criteria

1. All 33 tasks completed.
2. RD-02 acceptance criteria 1–15 have direct ST coverage or an explicit deferred owner:
   - AR-2 (age keyring) → RD-13;
   - AR-3 (agent fingerprint/expiry/revocation) → RD-05;
   - OIDC/auth/session flows → RD-03;
   - secret/certificate handlers → RD-08/RD-09.
3. `pnpm verify`, both PostgreSQL integration suites, and both audit commands pass.
4. No new production dependency; no source maps; no key material in logs or build output.
5. The execution plan and findings ledger record every review ruling.

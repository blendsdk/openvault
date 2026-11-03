# Execution Plan: RD-05 Service Identities and mTLS

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-03 10:25
> **Progress**: 13/69 tasks (19%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement RD-05 in five phases: contracts/schema/dependency, identity administration and narrow
authorization, CA/X.509 plus the agent listener/join/renew boundary, revocation/cache/retention/
readiness, and hardening/release verification. Each feature phase follows the mandatory
specification-first order: specification tests, red result, implementation, green result,
implementation tests, full verification.

The agent listener, agent context, authenticator, middleware, and listener flip are part of Phase 3
before the join/renew controller. The listener is fail-closed and cannot bind without an
authenticator. Cache, revocation, retention, and production readiness stay in Phase 4.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Contracts, schema, dependency, and guards | 14 |
| 2 | Identity administration and authorization | 14 |
| 3 | CA, X.509, agent listener, join, renewal, and consumer | 19 |
| 4 | Revocation, cache, retention, readiness, and existing-suite updates | 14 |
| 5 | Hardening, documentation, and release verification | 8 |

**Total: 69 tasks across 5 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes in the phase sections below are the **single source of truth** for
> progress. Every task line appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp —
>    `- [x] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` —
>    `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** (`> **Progress**: X/Y tasks (Z%)`) and the Last Updated
>    stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning the phase sections top-to-bottom: the first `[~]` task is resumed
>    first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line.
>    The plan lifecycle is `Ready`, `Executing`, `Done`, or `Blocked`, derived from these marks.
>
> Timestamps come from `date '+%Y-%m-%d %H:%M'` — never invented.

---

## Phase 1: Contracts, schema, dependency, and guards

> **Phase baseline tree**: e2bbb4e99d8f8f7b50477c808de97df0d6eb5535
> **Modification set**: `packages/api-contract/src/identities.ts`, `packages/api-contract/src/agents.ts`, `packages/api-contract/src/index.ts`, `apps/server/src/database/schema.ts`, generated migration/snapshot/types/ctypes, the reviewed manual trigger migration, `apps/server/package.json`, `pnpm-lock.yaml`, and Phase 1 tests
> **Scope mode**: strict
> **Lenses**: api-surface, migration, security
> **Reasoning**: max — schema, dependency, and cross-table guards are foundational and hard to
> change after later phases depend on them

### Step 1.1: Specification Tests

**Reference**: [03-01](03-01-contracts-schema-authorization.md) §Shared contracts, §Schema and migration · [03-02](03-02-ca-x509-issuance.md) §X.509 dependency boundary · [07](07-testing-strategy.md) ST-1–ST-16 · AR-3, AR-9, AR-12, AR-14, AR-17, AR-20, AR-23, AR-25
**Objective**: Freeze the strict contracts, schema, generated artifacts, and human-credential
guards before any implementation.

- [x] 1.1.1 [spec-author] Write identity and agent contract tests for ST-1–ST-8 ✅ (completed: 2026-11-03 09:55) — `packages/api-contract/tests/identities.spec.test.ts`, `packages/api-contract/tests/agents.spec.test.ts`
- [x] 1.1.2 [spec-author] Write schema, migration, generated-type, and service-principal guard tests for ST-9–ST-16 ✅ (completed: 2026-11-03 09:55) — `apps/server/tests/integration/schema-identity.spec.test.ts`, `apps/server/tests/integration/schema.spec.test.ts`, `apps/server/tests/integration/migrations.spec.test.ts`
- [x] 1.1.3 Run the Phase 1 specification tests against one PostgreSQL database and record the red result ✅ (completed: 2026-11-03 09:55)

### Step 1.2: Implementation

**Reference**: [03-01](03-01-contracts-schema-authorization.md) §Shared contracts, §Schema and migration · [03-02](03-02-ca-x509-issuance.md) §X.509 dependency boundary · AR-3, AR-9, AR-12, AR-14, AR-17, AR-20, AR-23

- [x] 1.2.1 Add the approved X.509/ASN.1/Reflect dependencies and exact pins ✅ (completed: 2026-11-03 09:58) — `apps/server/package.json`, `pnpm-lock.yaml`
- [x] 1.2.2 Add strict identity contracts ✅ (completed: 2026-11-03 09:58) — `packages/api-contract/src/identities.ts`
- [x] 1.2.3 Add strict agent contracts and package exports ✅ (completed: 2026-11-03 09:58) — `packages/api-contract/src/agents.ts`, `packages/api-contract/src/index.ts`
- [x] 1.2.4 Add `ca_keys`, `join_tokens.revoked_at`, active-service-name uniqueness, and cleanup indexes to the schema ✅ (completed: 2026-11-03 10:10) — `apps/server/src/database/schema.ts`
- [x] 1.2.5 Generate and review the additive schema migration and snapshot ✅ (completed: 2026-11-03 10:10) — `apps/server/migrations/`
- [x] 1.2.6 Add the reviewed service-principal and principal-kind trigger migration with the BlendSDK header ✅ (completed: 2026-11-03 10:10) — `apps/server/migrations/`
- [x] 1.2.7 Regenerate database row types and CType constants ✅ (completed: 2026-11-03 10:10) — `apps/server/src/database/generated-types.ts`, `apps/server/src/database/ctypes.ts`
- [x] 1.2.8 Run the Phase 1 specification tests and verify green ✅ (completed: 2026-11-03 10:15)

### Step 1.3: Implementation Tests and Hardening

**Reference**: [07](07-testing-strategy.md) §Contracts, §Schema, §Verification Commands · AR-12, AR-14, AR-17, AR-25

- [x] 1.3.1 Write contract edge tests for strict fields, name/TTL boundaries, status-code mapping, and response shapes ✅ (completed: 2026-11-03 10:20) — `packages/api-contract/tests/identities.impl.test.ts`, `packages/api-contract/tests/agents.impl.test.ts`
- [x] 1.3.2 Write migration/trigger implementation tests for key lengths, index predicates, full-row guards, kind immutability, and type drift ✅ (completed: 2026-11-03 10:25) — `apps/server/tests/integration/schema-identity.impl.test.ts`
- [ ] 1.3.3 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` — `pnpm verify`; integration commands from [07](07-testing-strategy.md) §Verification Commands

**Deliverables**:
- Strict identity and agent contracts exported from `@openvault/api-contract`.
- Reviewed `ca_keys`, token-revocation, uniqueness, and cleanup migration.
- Reviewed service-principal and principal-kind trigger migration.
- Regenerated database types/CTypes with no drift.
- All Phase 1 verification and integration gates passing.

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Commands

---

## Phase 2: Identity administration and authorization

> **Phase baseline tree**: _(recorded by the exec-plan skill)_
> **Modification set**: `apps/server/src/identity/`, `apps/server/src/agent/agent-token-service.ts`, `apps/server/src/controllers/identity.ts`, `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/src/auth/oidc/identity.ts`, `apps/server/src/auth/credentials.ts`, `apps/server/src/auth/cli-sessions.ts`, `apps/server/src/auth/middleware.ts`, Phase 2 tests/helpers
> **Scope mode**: strict
> **Lenses**: web application, security, data
> **Reasoning**: max — the admin API is the first mutation surface and the narrow helper is a
> temporary authorization authority until RD-06

### Step 2.1: Specification Tests

**Reference**: [03-01](03-01-contracts-schema-authorization.md) §Narrow identity authorization, §Admin routes, §Error handling · [07](07-testing-strategy.md) ST-17–ST-30, ST-82, ST-84 · AR-9, AR-10, AR-14, AR-19, AR-20, AR-23
**Objective**: Freeze create/list/detail/revoke/token behavior, scope filtering, status codes, and
service-principal human-credential rejection.

- [ ] 2.1.1 [spec-author] Write authorization, admin lifecycle, and TTL status tests for ST-17–ST-30 and ST-84 — `apps/server/tests/integration/identity-admin.spec.test.ts`
- [ ] 2.1.2 [spec-author] Write service-principal login, session, OIDC, CLI, and read-path tests ST-82 — `apps/server/tests/integration/service-principals.spec.test.ts`
- [ ] 2.1.3 Run the Phase 2 specification tests and record the red result

### Step 2.2: Implementation

**Reference**: [03-01](03-01-contracts-schema-authorization.md) §Identity records and repository, §Runtime ownership, §Narrow identity authorization, §Admin routes · AR-9, AR-10, AR-14, AR-19, AR-20, AR-23

- [ ] 2.2.1 Add the identity repository with create/list/detail/revoke/consumer queries — `apps/server/src/identity/identity-repository.ts`
- [ ] 2.2.2 Add the narrow `role_assignments` identity authorizer with org-only role filtering — `apps/server/src/identity/identity-authorizer.ts`
- [ ] 2.2.3 Add join-token generation, hashing, TTL conversion, createdBy, and storage — `apps/server/src/agent/agent-token-service.ts`
- [ ] 2.2.4 Add the identity service for create/list/detail/revoke/token issuance and the revocation callback — `apps/server/src/identity/identity-service.ts`
- [ ] 2.2.5 Add the admin identity controller with all five routes and stable error codes — `apps/server/src/controllers/identity.ts`
- [ ] 2.2.6 Reject service principals on OIDC linkage, browser/CLI session read paths, and credential paths — `apps/server/src/auth/oidc/identity.ts`, `apps/server/src/auth/credentials.ts`, `apps/server/src/auth/cli-sessions.ts`, `apps/server/src/auth/middleware.ts`
- [ ] 2.2.7 Add the `IdentityRuntime` composition for admin-only tests and register identity services/controller — `apps/server/src/identity/identity-runtime.ts`, `apps/server/src/app.ts`
- [ ] 2.2.8 Run the Phase 2 specification tests and verify green

### Step 2.3: Implementation Tests and Hardening

**Reference**: [07](07-testing-strategy.md) §Identity administration, §Verification Commands · AR-9, AR-10, AR-14, AR-23

- [ ] 2.3.1 Write authorizer/list/detail/revoke implementation tests for scope combinations, expiry, project-scoped `org.admin`, foreign ids, and empty sets — `apps/server/tests/integration/identity/authorization.impl.test.ts`
- [ ] 2.3.2 Write token/name/error implementation tests, including disabled identity/project, createdBy, concurrent issue/revoke, idempotent revoke, and kind-change guards — `apps/server/tests/integration/identity-admin.impl.test.ts`
- [ ] 2.3.3 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` — `pnpm verify`; integration commands from [07](07-testing-strategy.md) §Verification Commands

**Deliverables**:
- Complete admin identity routes and strict responses.
- Narrow org/project/auditor authorization with no RD-06 dependency.
- Join-token creation and one-time raw token response.
- Service-principal human-credential rejection across write and read paths.
- All Phase 2 verification passing.

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Commands

---

## Phase 3: CA, X.509, agent listener, join, renewal, and consumer

> **Phase baseline tree**: _(recorded by the exec-plan skill)_
> **Modification set**: `apps/server/src/security/x509.ts`, `apps/server/src/security/ca.ts`, `apps/server/src/agent/agent-token-service.ts`, `apps/server/src/agent/consumer-repository.ts`, `apps/server/src/agent/agent-join-service.ts`, `apps/server/src/agent/agent-renew-service.ts`, `apps/server/src/agent/agent-rate-limits.ts`, `apps/server/src/agent/agent-authenticator.ts`, `apps/server/src/agent/agent-middleware.ts`, `apps/server/src/agent/project-resolver.ts`, `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/controllers/agent.ts`, `apps/server/src/transport/secure-application.ts`, `apps/server/src/transport/scope.ts`, `apps/server/src/auth/plugin.ts`, `apps/server/src/auth/middleware.ts`, `apps/server/src/types/express.d.ts`, `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/tests/integration/helpers/agent-tls.ts`, `apps/server/tests/integration/helpers/agent-runtime.ts`, `apps/server/tests/integration/transport.spec.test.ts`, `apps/server/tests/integration/transport.impl.test.ts`, Phase 3 tests
> **Scope mode**: strict
> **Lenses**: security, concurrency, api-surface
> **Reasoning**: max — PKI issuance, atomic token claim, and the agent authentication boundary are
> the highest-risk correctness and security paths

### Step 3.1: Specification Tests

**Reference**: [03-02](03-02-ca-x509-issuance.md) §CSR, §Certificate profile, §CA row · [03-03](03-03-join-renew-consumer.md) §Join sequence, §Renewal, §Consumer · [03-04](03-04-agent-listener-revocation.md) §Agent context, §Listener options, §Middleware · [07](07-testing-strategy.md) ST-31–ST-68, ST-85 · AR-3, AR-4, AR-6, AR-7, AR-8, AR-12, AR-13, AR-15, AR-18, AR-24
**Objective**: Freeze CA/CSR/profile, token atomicity, the join/renew HTTP boundary, consumer,
replay, and basic agent authentication before code.

- [ ] 3.1.1 [spec-author] Write CA, CSR, certificate-profile, serial-seam, and probe tests for ST-31–ST-42 — `apps/server/tests/integration/ca-x509.spec.test.ts`
- [ ] 3.1.2 [spec-author] Write join, token, no-cert join, protected-health, agent token-status, and existing transport-boundary tests for ST-43–ST-53, ST-65–ST-68, ST-85 — `apps/server/tests/integration/agent-join.spec.test.ts`, `apps/server/tests/integration/transport.spec.test.ts`, `apps/server/tests/integration/transport.impl.test.ts`
- [ ] 3.1.3 [spec-author] Write renewal, fresh-key, replay, consumer, and rate-limit tests for ST-54–ST-64 — `apps/server/tests/integration/agent-renew.spec.test.ts`
- [ ] 3.1.4 Run the Phase 3 specification tests and record the red result

### Step 3.2: Implementation

**Reference**: [03-02](03-02-ca-x509-issuance.md) §X.509 boundary, §CSR parsing, §Certificate profile, §CA row, §`CaSigner.load()` · [03-03](03-03-join-renew-consumer.md) §Join sequence, §Renewal, §Consumer upsert, §Rate limits · [03-04](03-04-agent-listener-revocation.md) §Agent context, §Listener options, §Middleware, §Runtime composition · AR-3, AR-4, AR-6, AR-7, AR-8, AR-12, AR-13, AR-15, AR-18, AR-24

- [ ] 3.2.1 Add the single X.509 boundary: CSR parse/proof/curve/extension checks, fixed-profile issuance, injectable serial source, and CA probe — `apps/server/src/security/x509.ts`
- [ ] 3.2.2 Add CA scalar wrapping, `CaSigner.load()`, public/certificate matching, and signer lifecycle — `apps/server/src/security/ca.ts`
- [ ] 3.2.3 Add the atomic join-token claim and token lookup primitives — `apps/server/src/agent/agent-token-service.ts`
- [ ] 3.2.4 Add the consumer upsert repository — `apps/server/src/agent/consumer-repository.ts`
- [ ] 3.2.5 Add the join service: pre-CSR validation, principal lock, claim, issue, serial retry, certificate and consumer insert — `apps/server/src/agent/agent-join-service.ts`
- [ ] 3.2.6 Add the renewal service: replay-first, fresh-key comparison, newest/current/threshold checks, insert, and replay cache — `apps/server/src/agent/agent-renew-service.ts`
- [ ] 3.2.7 Add per-app join/renew rate limiters — `apps/server/src/agent/agent-rate-limits.ts`
- [ ] 3.2.8 Add the agent context, DB authenticator without cache, `requireAgent`, the active-project resolver, and default-deny middleware — `apps/server/src/agent/agent-authenticator.ts`, `apps/server/src/agent/project-resolver.ts`, `apps/server/src/agent/agent-middleware.ts`, `apps/server/src/types/express.d.ts`
- [ ] 3.2.9 Change the agent listener only with the middleware present, require an authenticator in `startTransport`, open agent-scoped `/v1/data`, and make browser/CLI resolvers listener-aware — `apps/server/src/transport/secure-application.ts`, `apps/server/src/transport/scope.ts`, `apps/server/src/auth/plugin.ts`, `apps/server/src/auth/middleware.ts`
- [ ] 3.2.10 Add the agent controller and the production identity/agent runtime composition (replacing the Phase 2 test identity registration) with one logger, a deny-all `createTestApplication` authenticator, fail-closed startup, and updated transport tests — `apps/server/src/controllers/agent.ts`, `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/tests/integration/transport.spec.test.ts`, `apps/server/tests/integration/transport.impl.test.ts`
- [ ] 3.2.11 Run the Phase 3 specification tests and verify green

### Step 3.3: Implementation Tests and Hardening

**Reference**: [07](07-testing-strategy.md) §CA and X.509, §Join, §Renewal, §Verification Commands · AR-3, AR-4, AR-6, AR-8, AR-12, AR-13, AR-15, AR-18, AR-24

- [ ] 3.3.1 Write CA/CSR implementation tests for AAD, key lengths, load mismatch, curve, extension, serial normalization, serial seam, and redaction edges — `apps/server/tests/integration/security/ca.impl.test.ts`, `apps/server/tests/agent/csr.impl.test.ts`
- [ ] 3.3.2 Write concurrent join, consumer upsert, token-race, and serial-retry implementation tests — `apps/server/tests/integration/agent-join.impl.test.ts`
- [ ] 3.3.3 Write replay-cache, fresh-key, TTL-threshold, rate-limit, and lost-response implementation tests — `apps/server/tests/agent/replay-cache.impl.test.ts`, `apps/server/tests/agent/rate-limits.impl.test.ts`, `apps/server/tests/integration/agent-renew.impl.test.ts`
- [ ] 3.3.4 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` — `pnpm verify`; integration commands from [07](07-testing-strategy.md) §Verification Commands

**Deliverables**:
- Approved X.509 boundary with no shell or custom ASN.1.
- KEK-wrapped CA signer with fixed certificate profile and probe.
- Fail-closed agent listener with context, authenticator, and default-deny middleware.
- Atomic join-token claim and join/renew services with fresh-key enforcement.
- Consumer upsert and rate limits.
- All Phase 3 verification passing.

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Commands

---

## Phase 4: Revocation, cache, retention, readiness, and existing-suite updates

> **Phase baseline tree**: _(recorded by the exec-plan skill)_
> **Modification set**: `apps/server/src/agent/agent-authenticator.ts`, `apps/server/src/agent/agent-renew-service.ts`, `apps/server/src/agent/agent-maintenance.ts`, `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/identity/identity-service.ts`, `apps/server/src/readiness/service.ts`, `apps/server/src/controllers/ready.ts`, `apps/server/src/transport/secure-application.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/readiness.spec.test.ts`, `apps/server/tests/test-app.impl.test.ts`, `apps/server/tests/integration/helpers/agent-runtime.ts`, `apps/server/tests/integration/helpers/cli.ts`, Phase 4 tests
> **Scope mode**: strict
> **Lenses**: security, concurrency, web application
> **Reasoning**: max — revocation timing, cache invalidation, and readiness are security-critical
> and depend on every earlier phase

### Step 4.1: Specification Tests

**Reference**: [03-04](03-04-agent-listener-revocation.md) §Agent authenticator, §Middleware, §Revocation, §Retention, §Readiness, §Test seams · [07](07-testing-strategy.md) ST-69–ST-77, ST-79–ST-81 · AR-2, AR-3, AR-5, AR-13, AR-15, AR-18, AR-22
**Objective**: Freeze cache bounds, revoke timing, data-route delivery, retention, readiness, mixed
credentials, and existing-suite updates before code.

- [ ] 4.1.1 [spec-author] Write cache, revoke, data-route, and mixed-credential tests for ST-69–ST-74, ST-80 — `apps/server/tests/integration/agent-listener.spec.test.ts`
- [ ] 4.1.2 [spec-author] Write retention, readiness, and delivery-bound tests for ST-75–ST-77, ST-79, ST-81 and update readiness/test-app expectations — `apps/server/tests/integration/agent-retention.spec.test.ts`, `apps/server/tests/integration/readiness.spec.test.ts`, `apps/server/tests/test-app.impl.test.ts`
- [ ] 4.1.3 Run the Phase 4 specification tests and record the red result

### Step 4.2: Implementation

**Reference**: [03-04](03-04-agent-listener-revocation.md) §Agent authenticator, §Middleware, §Revocation, §Retention, §Readiness, §Runtime composition, §Test seams · AR-2, AR-3, AR-5, AR-13, AR-15, AR-18, AR-22

- [ ] 4.2.1 Add the positive authenticator cache with read-start TTL, `notAfter` recheck, invalidation, and cache-bypassing `revalidate()` — `apps/server/src/agent/agent-authenticator.ts`
- [ ] 4.2.2 Extend revoke to clear the authenticator and renewal-replay caches and verify the atomic transaction — `apps/server/src/identity/identity-service.ts`, `apps/server/src/agent/agent-authenticator.ts`, `apps/server/src/agent/agent-renew-service.ts`
- [ ] 4.2.3 Add the test-only data controller/harness seam before `prepare()` for the pre-written ST-70/ST-81 cases — `apps/server/tests/integration/helpers/agent-runtime.ts`
- [ ] 4.2.4 Add bounded daily token/certificate cleanup with stop/dispose behavior — `apps/server/src/agent/agent-maintenance.ts`
- [ ] 4.2.5 Add the conditional CA readiness probe and `ca` failure mapping, keeping admin-only readiness green — `apps/server/src/readiness/service.ts`, `apps/server/src/controllers/ready.ts`
- [ ] 4.2.6 Add runtime disposal/logger wiring for the Phase 3 core runtime — `apps/server/src/agent/agent-runtime.ts`, `apps/server/src/app.ts`
- [ ] 4.2.7 Update the CLI helper transport-start fixture for the deny-all test default; no ST oracle changes — `apps/server/tests/integration/helpers/cli.ts`
- [ ] 4.2.8 Run the Phase 4 specification tests and verify green

### Step 4.3: Implementation Tests and Hardening

**Reference**: [07](07-testing-strategy.md) §Agent listener, §Revocation, §Retention, §Verification Commands · AR-2, AR-5, AR-15, AR-18, AR-22

- [ ] 4.3.1 Write authenticator/cache implementation tests for socket typing, fingerprint, SPKI key hash, cache bound/TTL, invalidation, revalidate, DB failure, and test seams — `apps/server/tests/integration/agent/authenticator.impl.test.ts`
- [ ] 4.3.2 Write retention/revoke implementation tests for boundaries, post-expiry revocation, concurrent join/revoke, cache clearing, and failed cleanup — `apps/server/tests/integration/agent/retention.impl.test.ts`, `apps/server/tests/integration/agent-revoke.impl.test.ts`
- [ ] 4.3.3 Run `pnpm verify`, the integration gate, and `pnpm db:types:check` — `pnpm verify`; integration commands from [07](07-testing-strategy.md) §Verification Commands

**Deliverables**:
- Five-second positive cache with read-start TTL and local invalidation.
- Admission-time revocation guarantee plus RD-08 pre-send recheck obligation.
- Data-route project-id guard and pre-prepare test seam.
- Atomic revoke and bounded retention cleanup.
- Conditional CA readiness and updated existing suites.
- All Phase 4 verification passing.

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Commands

---

## Phase 5: Hardening, documentation, and release verification

> **Phase baseline tree**: _(recorded by the exec-plan skill)_
> **Modification set**: `apps/server/src/observability/logger.ts`, `apps/server/tests/logging.spec.test.ts`, `apps/server/tests/integration/agent-logging.spec.test.ts`, `docs/`, `.changeset/`, Phase 5 verification artifacts
> **Scope mode**: strict
> **Lenses**: security, api-surface, migration
> **Reasoning**: high — final security evidence, documentation drift, and cross-version migration
> checks gate release

### Step 5.1: Hardening and Release

**Reference**: [07](07-testing-strategy.md) §Verification Checklist, §Verification Commands · [03-04](03-04-agent-listener-revocation.md) §Test seams · AR-11, AR-12, AR-15, AR-21, AR-25

- [ ] 5.1.1 Add join-token/CSR/CA-key redaction paths and the captured-log sentinel test for ST-78 — `apps/server/src/observability/logger.ts`, `apps/server/tests/logging.spec.test.ts`, `apps/server/tests/integration/agent-logging.spec.test.ts`
- [ ] 5.1.2 Audit the reference/architecture/guides for drift against the implemented CA row, listener, join/renew, renewal, revoke, consumer, rate-limit, and retention behavior — `docs/`
- [ ] 5.1.3 Add the user-visible changeset — `.changeset/`
- [ ] 5.1.4 Run the explicit PostgreSQL 16/17 migration, integration, and generated-type matrix case ST-83 — `apps/server/migrations/`, `pnpm db:types:check`; commands from [07](07-testing-strategy.md) §Verification Commands
- [ ] 5.1.5 Run the full integration suite on PostgreSQL 16 and 17 with the disposable-database helper
- [ ] 5.1.6 Run full project verification under Node 24.21.0 — `pnpm verify`
- [ ] 5.1.7 Audit shipped code/docs for execution-plan, requirement, and ambiguity identifiers; remove any found
- [ ] 5.1.8 Final review: no dead code, no unused exports, no unhandled secret/log path, no cross-RD assertion claimed as complete

**Deliverables**:
- Captured-log evidence for token/CSR/key redaction.
- Documentation consistent with implementation.
- Migration/type evidence on PostgreSQL 16 and 17.
- Full integration and project verification.
- No planning identifiers in shipped code/docs.
- Release-ready RD-05 server boundary.

**Verify**: `pnpm verify` plus the integration gate in [07](07-testing-strategy.md) §Verification Commands

---

## Dependencies

```text
Phase 1: contracts + schema + guards
    ↓
Phase 2: identity admin + narrow authorization
    ↓
Phase 3: CA/X.509 + fail-closed agent boundary + join/renew/consumer
    ↓
Phase 4: revoke + cache + retention + readiness + existing suites
    ↓
Phase 5: hardening + docs + release verification
```

## Success Criteria

**Feature is complete when:**

1. ✅ All 69 tasks completed.
2. ✅ `pnpm verify` passes under Node 24.21.0; the integration gate passes against the disposable database.
3. ✅ Migration ledger applies on PostgreSQL 16 and 17 and `pnpm db:types:check` reports no drift.
4. ✅ The full integration suite covers the RD-05 server boundary and all later-RD handoffs are
   recorded, not claimed complete.
5. ✅ No secret, token, CSR, private key, CA key, or token hash appears in logs or error envelopes.
6. ✅ No dead code or unused exports; no plan/requirement identifiers in shipped code/docs.
7. ✅ Documentation matches the implemented behavior.
8. ✅ The post-completion project re-analysis is handled by the exec-plan skill.

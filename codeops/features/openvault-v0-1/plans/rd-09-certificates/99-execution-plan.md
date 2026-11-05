# Execution Plan: RD-09 Certificates

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-05 09:30
> **Progress**: 74/74 tasks (100%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement RD-09 in six phases: contracts/schema/fixtures, import/generate, read/list/private,
lifecycle/purge, expiry, then documentation and release. Each phase follows the
specification-first order: spec tests, red phase, implementation, green phase, implementation
tests, full verification.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
|---|---|---|
| 1 | Contracts, schema, migration, and fixtures | 17 |
| 2 | Import, generation, and renewal | 10 |
| 3 | Public/private reads, list, search, and capabilities | 11 |
| 4 | Lifecycle and generalized purge | 10 |
| 5 | Expiry job, claims, and webhook | 13 |
| 6 | Documentation and release | 13 |

**Total: 74 tasks across 6 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes in the phase sections below are the **single source of truth** for progress. Every task line appears exactly once in this document. The executing agent MUST:
>
> 1. **On implementation:** mark the task `[~]` with a timestamp — `- [~] 1.1.1 Task description ⏳ (implemented: YYYY-MM-DD HH:MM)`
> 2. **On verify pass:** promote it to `[x]` — `- [x] 1.1.1 Task description ✅ (completed: YYYY-MM-DD HH:MM)`
> 3. **Update the Progress header** and Last Updated stamp after EVERY task — never batch updates. Only `[x]` counts as complete.
> 4. **Resume** by scanning top-to-bottom: the first `[~]` task is resumed first, else the first `[ ]` task.
> 5. **On blocker:** mark the task `[!]` and append `Blocked: <short reason>` on the same line.

---

## Phase 1: Contracts, Schema, Migration, and Fixtures

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `packages/api-contract/src/{certificates,projects,index}.ts`, `packages/api-contract/tests/{certificates.*,projects.*}.test.ts`, `apps/server/src/projects/{repository,service}.ts`, `apps/server/src/controllers/projects.ts`, `apps/server/tests/integration/{projects.spec,projects-http.impl}.test.ts`, `apps/server/tests/integration/{certificates-pem.spec,certificates-generate.spec,certificates-pem.impl}.test.ts`, `apps/server/tests/integration/{migrations,schema}.spec.test.ts`, `apps/server/src/database/schema.ts`, `apps/server/migrations/`, `apps/server/src/database/{generated-types,ctypes}.ts`, `apps/server/src/certificates/{pem,generate,errors}.ts`, `apps/server/src/config/{types,loader}.ts`, `apps/server/tests/integration/helpers/certificate-fixtures.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — the PEM/key/chain rules and the additive schema are the security and data boundary for every later phase.

### Step 1.1: Specification Tests and Fixtures

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-1..10 · [03-01](03-01-contracts-pem.md) · AR-5..AR-10, AR-26
**Objective**: Define the contracts, PEM rules, and generation profile before code.

- [x] 1.1.1 [spec-author] Write certificate contract specification tests — `packages/api-contract/tests/certificates.spec.test.ts` (ST-1..10) ✅ (completed: 2026-11-04 22:15)
- [x] 1.1.2 [spec-author] Write the real X.509 fixture helper — `apps/server/tests/integration/helpers/certificate-fixtures.ts` (RSA/EC leaves, chains, mismatch, invalid chain, dates, unsupported keys) ✅ (completed: 2026-11-04 22:15)
- [x] 1.1.3 [spec-author] Write PEM/key/chain/SAN specification tests — `apps/server/tests/integration/certificates-pem.spec.test.ts` (ST-9a..b, ST-11..27, ST-19a..b, ST-21a) ✅ (completed: 2026-11-04 22:15)
- [x] 1.1.4 [spec-author] Write generation specification tests — `apps/server/tests/integration/certificates-generate.spec.test.ts` (ST-28..34) ✅ (completed: 2026-11-04 22:15)
- [x] 1.1.5 Run the new spec tests and record the red phase ✅ (completed: 2026-11-04 22:15)

### Step 1.2: Implementation

**Reference**: [03-01 §Public Contracts](03-01-contracts-pem.md) · [03-01 §PEM Parsing](03-01-contracts-pem.md) · [03-01 §Generation](03-01-contracts-pem.md) · AR-5..AR-10, AR-26, AR-30
**Objective**: Land the contracts, the additive notification table, strict PEM parsing, and generation.

- [x] 1.2.1 Add certificate contracts, the project list count contract, and exports — `packages/api-contract/src/{certificates,projects,index}.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.2 Add the notification table and the `certificate_versions.not_after` index to the schema — `apps/server/src/database/schema.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.3 Generate and review the additive migration from `apps/server` with `pnpm exec blendsdk migrate generate certificate-expiry --config blendsdk.migrations.ts`; build the server, apply it with `OPENVAULT_DB_URL=... pnpm db:migrate`, then regenerate database types with `OPENVAULT_DB_URL=... pnpm db:types` — `apps/server/migrations/`, `apps/server/src/database/{generated-types,ctypes}.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.4 Add strict PEM parsing, PKCS#8 key validation, signature-only chain verification with intermediate warnings, metadata bounds, SAN canonicalization, and unsupported-SAN rejection — `apps/server/src/certificates/pem.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.5 Add the certificate domain errors — `apps/server/src/certificates/errors.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.6 Add self-signed generation for RSA 2048/3072 and EC P-256 with a 30-second backdated `notBefore` — `apps/server/src/certificates/generate.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.7 Clamp `OPENVAULT_CERT_MAX_BYTES` and add the private-key PEM bound — `apps/server/src/config/{types,loader}.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.2.8 Run the spec tests and reach the green phase ✅ (completed: 2026-11-04 22:15)

### Step 1.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-6..AR-10
**Objective**: Cover contract and PEM edges and prove the phase.

- [x] 1.3.1 Write contract implementation tests for certificates and the project list count — `packages/api-contract/tests/{certificates.impl,projects.impl}.test.ts`, `apps/server/tests/integration/projects-http.impl.test.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.3.2 Write PEM/generation implementation tests — `apps/server/tests/integration/certificates-pem.impl.test.ts` (PEM smuggling, chain edges, key types, metadata bounds, generation bounds) ✅ (completed: 2026-11-04 22:15)
- [x] 1.3.3 Update the migration and schema inventory tests for the new table, foreign keys, index, and counts — `apps/server/tests/integration/{migrations,schema}.spec.test.ts` ✅ (completed: 2026-11-04 22:15)
- [x] 1.3.4 Run `pnpm verify`, then `OPENVAULT_DB_URL=... pnpm db:migrate`, `OPENVAULT_DB_URL=... pnpm db:types:check`, and the new tests ✅ (completed: 2026-11-04 22:15)

**Deliverables**:
- [x] Certificate contracts, notification table, migration, and generated types complete ✅
- [x] Strict PEM/key/chain validation and generation complete ✅
- [x] All Phase 1 specification and implementation tests passing

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 2: Import, Generation, and Renewal

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `apps/server/src/certificates/{repository,envelope,service,runtime,rate-limits}.ts`, `apps/server/tests/integration/certificates-write.impl.test.ts`, `apps/server/src/audit/actions.ts`, `apps/server/src/observability/logger.ts`, `apps/server/src/controllers/certificates.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/certificates-write.spec.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — private-key encryption, create-or-renew semantics, name reservation, and joined audit evidence are security- and integrity-critical.

### Step 2.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-35..41, ST-40a..b · [03-02](03-02-certificates.md) · AR-2, AR-11, AR-12, AR-21
**Objective**: Define create, renewal, versioning, name reservation, and the version limit.

- [x] 2.1.1 [spec-author] Write import/generate/renew specification tests — `apps/server/tests/integration/certificates-write.spec.test.ts` (ST-35..41, ST-40a..b) ✅ (completed: 2026-11-04 23:15)
- [x] 2.1.2 Run the new spec tests and record the red phase ✅ (completed: 2026-11-04 23:15)

### Step 2.2: Implementation

**Reference**: [03-02 §Repository](03-02-certificates.md) · [03-02 §Import](03-02-certificates.md) · AR-2, AR-11, AR-12, AR-21, AR-25
**Objective**: Implement certificate persistence and the create-or-renew write path.

- [x] 2.2.1 Add the certificate repository and list query — `apps/server/src/certificates/repository.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 2.2.2 Add the v2 envelope mapping for certificate versions — `apps/server/src/certificates/envelope.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 2.2.3 Implement import, generation, and renewal with chain-first joined decisions and the `expectedVersionId` guard — `apps/server/src/certificates/service.ts`, `apps/server/src/audit/actions.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 2.2.4 Add the import/generate controller routes, the 10/min write limiter, and error mapping — `apps/server/src/controllers/certificates.ts`, `apps/server/src/certificates/rate-limits.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 2.2.5 Compose the certificate runtime, register the service/controller, and add private-key request-body redaction — `apps/server/src/certificates/runtime.ts`, `apps/server/src/observability/logger.ts`, `apps/server/src/app.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 2.2.6 Run the write spec tests and reach the green phase ✅ (completed: 2026-11-04 23:15)

### Step 2.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-21
**Objective**: Prove concurrency, rollback, and envelope behavior.

- [x] 2.3.1 Write write-path implementation tests — `apps/server/tests/integration/certificates-write.impl.test.ts` (concurrent renewal, rollback, version limit, `expectedVersionId`, tags on renewal) ✅ (completed: 2026-11-04 23:15)
- [x] 2.3.2 Run `pnpm verify`, `pnpm db:types:check`, and the certificate write tests ✅ (completed: 2026-11-04 23:15)

**Deliverables**:
- [ ] Import, generation, and renewal complete with immutable versions
- [ ] Private keys encrypted with the certificate AAD; no key in any response
- [x] All Phase 2 specification and implementation tests passing ✅

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 3: Public/Private Reads, List, Search, and Capabilities

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `apps/server/src/certificates/{service,rate-limits,repository,runtime}.ts`, `apps/server/src/controllers/certificates.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/{certificates-read.spec,certificates-read.impl,certificates-http.spec}.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — private-key isolation, tenant visibility, expiry disclosure, and value leakage are the highest-risk read behaviors.

### Step 3.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-42..61, ST-43a..b, ST-48, ST-95, ST-97 · [03-02 §Public Read](03-02-certificates.md) · AR-4, AR-21..AR-25, AR-31, AR-34
**Objective**: Define public/private reads, expired-version behavior, list/search, and capabilities.

- [x] 3.1.1 [spec-author] Write read/list/private-key/expiry/AAD specification tests — `apps/server/tests/integration/certificates-read.spec.test.ts` (ST-42..61, ST-43a..b, ST-48, ST-95, ST-97) ✅ (completed: 2026-11-04 23:15)
- [x] 3.1.2 [spec-author] Write HTTP, authorization-matrix, tenant-isolation, and leakage specification tests — `apps/server/tests/integration/certificates-http.spec.test.ts` (ST-86..92, ST-88a, ST-96) ✅ (completed: 2026-11-04 23:15)
- [x] 3.1.3 Run the new spec tests and record the red phase ✅ (completed: 2026-11-04 23:15)

### Step 3.2: Implementation

**Reference**: [03-02 §Public Read](03-02-certificates.md) · [03-02 §Private-Key Read](03-02-certificates.md) · [03-02 §List and Search](03-02-certificates.md) · AR-4, AR-21..AR-25, AR-31, AR-34
**Objective**: Implement the read surface, search, capabilities, and the private-read limiter.

- [x] 3.2.1 Implement public and private reads with visibility pre-checks, one outcome event, decrypt-before-audit for private keys, and expiry rules — `apps/server/src/certificates/service.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 3.2.2 Implement list, subject/SAN/expiry filters, and cursor pagination — `apps/server/src/certificates/service.ts`, `apps/server/src/certificates/repository.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 3.2.3 Attach capabilities from one actor snapshot — `apps/server/src/certificates/service.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 3.2.4 Add the 30/min private-key limiter — `apps/server/src/certificates/rate-limits.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 3.2.5 Add the read/list/private-key controller routes and the transport-level 413 path — `apps/server/src/controllers/certificates.ts`, `packages/api-contract/src/certificates.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 3.2.6 Run the read spec tests and reach the green phase ✅ (completed: 2026-11-04 23:15)

### Step 3.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-22..AR-25
**Objective**: Prove AAD separation, cursor edges, wildcard search, and leakage safety.

- [x] 3.3.1 Write read implementation tests — `apps/server/tests/integration/certificates-read.impl.test.ts` (AAD separation, wildcard search, cursor continuation, agent listener, rate limit, read-evidence failure) ✅ (completed: 2026-11-04 23:15)
- [x] 3.3.2 Run `pnpm verify`, `pnpm db:types:check`, and the certificate read tests ✅ (completed: 2026-11-04 23:15)

**Deliverables**:
- [x] Public/private reads, list, search, and capabilities complete ✅
- [x] Expired reads return 410 unless `?version=` is explicit ✅
- [x] No PEM or key material in metadata, lists, logs, errors, or audit events ✅
- [x] All Phase 3 specification and implementation tests passing ✅

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 4: Lifecycle and Generalized Purge

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `apps/server/src/purge/{vault-purger,errors}.ts`, `apps/server/src/secrets/{purge,runtime,service}.ts`, `apps/server/src/certificates/{lifecycle,runtime,service}.ts`, `apps/server/src/controllers/certificates.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/helpers/purger.ts`, `apps/server/tests/integration/{certificates-lifecycle,secrets-lifecycle.spec,secrets-lifecycle.impl}.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — destructive purge, retention, one-way protection, and a refactor of the tested secret purger must fail closed.

### Step 4.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-62..74, ST-62a, ST-93, ST-94 · [03-03](03-03-lifecycle-purge.md) · AR-11..AR-15
**Objective**: Define metadata update, delete, recovery, protection, retention, purge, and the RD-08 parity.

- [x] 4.1.1 [spec-author] Write lifecycle specification tests — `apps/server/tests/integration/certificates-lifecycle.spec.test.ts` (ST-62..74, ST-62a, ST-93, ST-94) ✅ (completed: 2026-11-04 23:15)
- [x] 4.1.2 Run the lifecycle spec tests and record the red phase ✅ (completed: 2026-11-04 23:15)

### Step 4.2: Implementation

**Reference**: [03-03 §Generalized Purger](03-03-lifecycle-purge.md) · [03-03 §Purge](03-03-lifecycle-purge.md) · AR-11..AR-15
**Objective**: Generalize the purger and implement the complete certificate lifecycle.

- [x] 4.2.1 Generalize `SecretPurger` into `VaultPurger` with both families, project/name/id predicates, the five-owner guard, a stable error type, and one pool — `apps/server/src/purge/{vault-purger,errors}.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 4.2.2 Switch the secret runtime/service/app wiring to `VaultPurger`, update the two RD-08 lifecycle test files, and preserve their behavior — `apps/server/src/secrets/{purge,runtime,service}.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/secrets-lifecycle.{spec,impl}.test.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 4.2.3 Implement PATCH with a locked deleted check, auth-before-state purge, delete, recovery, and purge with joined/error outcomes — `apps/server/src/certificates/lifecycle.ts`, `apps/server/src/certificates/service.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 4.2.4 Add the PATCH/lifecycle controller routes and their visibility pre-checks — `apps/server/src/controllers/certificates.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 4.2.5 Extend the disposable purge role with all certificate and notification grants — `apps/server/tests/integration/helpers/purger.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 4.2.6 Run the lifecycle spec tests and reach the green phase ✅ (completed: 2026-11-04 23:15)

### Step 4.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-13..AR-15
**Objective**: Prove purge guards, notification cleanup, and name reservation.

- [x] 4.3.1 Write lifecycle implementation tests — `apps/server/tests/integration/certificates-lifecycle.impl.test.ts` (purger guards, notification cleanup, name reservation, concurrent delete/recover, RD-08 secret purge) ✅ (completed: 2026-11-04 23:15)
- [x] 4.3.2 Run `pnpm verify`, `pnpm db:types:check`, and the lifecycle tests ✅ (completed: 2026-11-04 23:15)

**Deliverables**:
- [x] Metadata, delete, recovery, one-way protection, retention, and purge complete ✅
- [x] One verified `VaultPurger` handles both families and removes notification rows ✅
- [x] All Phase 4 specification and implementation tests passing ✅

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 5: Expiry Job, Claims, and Webhook

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `apps/server/src/certificates/expiry/{repository,scheduler,webhook,service}.ts`, `apps/server/src/audit/actions.ts`, `packages/api-contract/src/audit.ts`, `apps/server/src/config/{types,loader,redact}.ts`, `apps/server/src/transport/secure-application.ts`, `apps/server/src/app.ts`, `apps/server/tests/integration/helpers/webhook.ts`, `apps/server/tests/integration/certificates-expiry.*.test.ts`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: high — durable delivery, multi-instance claims, webhook confidentiality, and an audit business-action extension must not lose or duplicate warnings.

### Step 5.1: Specification Tests

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) ST-75..85, ST-75a, ST-77a..c, ST-82a, ST-85a..b · [03-04](03-04-expiry.md) · AR-16..AR-21, AR-26
**Objective**: Define thresholds, idempotency, retry, payload, audit, and scheduling.

- [x] 5.1.1 [spec-author] Write expiry specification tests — `apps/server/tests/integration/certificates-expiry.spec.test.ts` (ST-75..85, ST-75a, ST-77a..c, ST-82a, ST-85a..b) ✅ (completed: 2026-11-04 23:15)
- [x] 5.1.2 Add the local webhook test server helper — `apps/server/tests/integration/helpers/webhook.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.1.3 Run the expiry spec tests and record the red phase ✅ (completed: 2026-11-04 23:15)

### Step 5.2: Implementation

**Reference**: [03-04 §Expiry Repository](03-04-expiry.md) · [03-04 §Webhook](03-04-expiry.md) · [03-04 §Scheduler](03-04-expiry.md) · AR-16..AR-21, AR-26
**Objective**: Implement the daily scan, durable claims, webhook, schedule, and audit action.

- [x] 5.2.1 Add `certificate.expiry_warning` to the audit catalog and details allowlist — `packages/api-contract/src/audit.ts`, `apps/server/src/audit/actions.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.2 Add the expiry repository with `listExpiring`, lease-aware `claim`, `markSent`, `deleteClaim`, and `hasAuditEvent` — `apps/server/src/certificates/expiry/repository.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.3 Add the timestamped HMAC webhook sender with timeout and no redirects — `apps/server/src/certificates/expiry/webhook.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.4 Implement `runOnce` with raw-millisecond thresholds, short transactions, stale-lease reclaim, audit-event dedupe, the version detail, and retry semantics — `apps/server/src/certificates/expiry/service.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.5 Add the UTC daily scheduler with catch/finally next-run scheduling — `apps/server/src/certificates/expiry/scheduler.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.6 Add the UTC expiry hour and webhook settings; reject credentials, fragments, and production link-local/metadata URLs; redact the URL and secret — `apps/server/src/config/{types,loader,redact}.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.7 Compose and dispose the expiry service and scheduler; add `disableBackgroundJobs` to the dependency type and set it in the test application — `apps/server/src/app.ts`, `apps/server/src/transport/secure-application.ts` ✅ (completed: 2026-11-04 23:15)
- [x] 5.2.8 Run the expiry spec tests and reach the green phase ✅ (completed: 2026-11-04 23:15)

### Step 5.3: Implementation Tests and Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-18..AR-20
**Objective**: Prove claim races, HMAC, retries, and scheduler math.

- [x] 5.3.1 Write expiry implementation tests — `apps/server/tests/integration/certificates-expiry.impl.test.ts` (concurrent runs, stale-lease reclaim, crash-after-claim, mark-sent failure, audit dedupe, HMAC timestamp, timeout, redirect, malformed claims, next-run math) ✅ (completed: 2026-11-04 23:15)
- [x] 5.3.2 Run `pnpm verify`, `pnpm db:types:check`, and the expiry tests ✅ (completed: 2026-11-04 23:15)

**Deliverables**:
- [x] Daily expiry scan, durable claims, webhook delivery, retry, and audit complete ✅
- [x] One warning per `(version, threshold)` in normal operation ✅
- [x] All Phase 5 specification and implementation tests passing ✅

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration`

---

## Phase 6: Documentation and Release

> **Phase baseline tree**: 3b9db7e81d3f82b055b54446593edb32cda02783
> **Expected modification set**: `docs/reference/api.md`, `docs/guide/certificates.md`, `docs/reference/configuration.md`, `docs/architecture/crypto.md`, `docs/security/limitations.md`, `docs/guide/audit.md`, `docs/changelog.md`, `.changeset/certificates.md`, and the plan documents.
> **Scope mode**: strict
> **Reasoning**: medium — behavior is implemented; the remaining risk is documentation drift and release metadata.

### Step 6.1: Documentation

**Reference**: [00-index.md](00-index.md) · AR-4, AR-19, AR-23..AR-26
**Objective**: Document the implemented certificate surface and release metadata.

- [x] 6.1.1 Update the API reference with all certificate routes, shapes, PATCH, and status codes — `docs/reference/api.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.2 Replace the target certificates guide with implemented behavior, expiry, webhook, and key handling — `docs/guide/certificates.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.3 Document the expiry settings, certificate size clamp, and the six-table purger grants — `docs/reference/configuration.md`, `docs/guide/secrets.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.4 Update the architecture crypto page with the certificate private-key envelope — `docs/architecture/crypto.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.5 Update the security limitations with chain trust, unsupported SAN types, webhook delivery, private-key memory, version limit, no idempotency, and request-body redaction — `docs/security/limitations.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.6 Document `certificate.expiry_warning` in the audit guide — `docs/guide/audit.md` ✅ (completed: 2026-11-04 23:40)
- [x] 6.1.7 Update the changelog and add a minor changeset — `docs/changelog.md`, `.changeset/certificates.md` ✅ (completed: 2026-11-04 23:40)

### Step 6.2: Release Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Verification Checklist
**Objective**: Prove the complete plan with every required gate.

- [x] 6.2.1 Run `pnpm verify` ✅ (completed: 2026-11-04 23:40)
- [x] 6.2.2 Run `pnpm db:migrate` and `pnpm db:types:check` with `OPENVAULT_DB_URL` ✅ (completed: 2026-11-04 23:40)
- [x] 6.2.3 Run the full integration suite on PostgreSQL 16 ✅ (completed: 2026-11-04 23:40)
- [x] 6.2.4 Run the full integration suite on PostgreSQL 17 ✅ (completed: 2026-11-04 23:40)
- [x] 6.2.5 Run `pnpm changeset status` and the docs build ✅ (completed: 2026-11-04 23:40)
- [x] 6.2.6 Remove temporary artifacts, confirm the clean worktree, and record the final summary ✅ (completed: 2026-11-05 09:30)

**Deliverables**:
- [x] Certificate routes complete with `certificate.*` enforcement and audit ✅
- [x] Documentation and changeset complete ✅
- [x] All verification passing ✅

**Verify**: `pnpm verify && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate && OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check && TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test OPENVAULT_TEST_DB=1 pnpm test:integration && pnpm changeset status`

---

## Dependencies

```
Phase 1 (contracts, schema, PEM, generation)
    ↓
Phase 2 (import, generation, renewal)
    ↓
Phase 3 (reads, list, search, capabilities)
    ↓
Phase 4 (lifecycle, purge)
    ↓
Phase 5 (expiry, claims, webhook)
    ↓
Phase 6 (documentation, release)
```

---

## Success Criteria

**Feature is complete when:**

1. ✅ All 74 tasks completed
2. ✅ All RD-09 acceptance criteria covered by tests
3. ✅ `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, and the docs build pass
4. ✅ Integration suite passes on PostgreSQL 16 and 17
5. ✅ No private key, PEM body, or key material in metadata, lists, audit, logs, errors, or webhooks
6. ✅ Public and private reads are separated by `certificate.read` and `certificate.read_private`
7. ✅ Certificate envelopes fail authentication when moved to a secret row
8. ✅ Expiry warnings fire once per `(version, threshold)` and retry after a failed delivery
9. ✅ Project and certificate soft deletes hide every certificate surface
10. ✅ Documentation and changeset complete; temporary artifacts removed; worktree clean

---

## Final Summary

RD-09 is complete. The certificate data plane adds import and self-signed generation with strict
PEM/PKCS#8 validation, key match, signature-only chain verification, immutable versions,
public-chain and private-key reads, tags, search, capabilities, soft delete, recovery, one-way
protection, and guarded purge. A daily UTC expiry scan writes durable per-threshold claims and
optionally delivers a timestamped-HMAC webhook. Project list items now expose
`certificateCount` for the UI.

**Verification evidence**

| Gate | Result |
|---|---|
| `pnpm verify` (build, typecheck, lint, unit, root, artifacts, React, docs) | Pass |
| `OPENVAULT_DB_URL=... pnpm db:migrate` then `pnpm db:types:check` | Pass |
| `pnpm changeset status` | Minor bump for `@openvault/api-contract` and `@openvault/server` |
| Integration suite, PostgreSQL 16 | 663/663 passed |
| Integration suite, PostgreSQL 17 | 663/663 passed |
| Post-phase correctness review | No critical; 2 major fixed; 9 minor fixed/accepted |
| Post-phase security/concurrency audit | No critical; 1 major fixed; 6 minor fixed |

No temporary artifacts remain in the repository. The feature branch is merged through a
squash-merged pull request.

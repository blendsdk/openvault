# Execution Plan: RD-10 Agent Delivery and Compose

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-05 12:10
> **Progress**: 76/79 tasks (96%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the per-service agent package, its join/delivery/renewal/status/socket/wrapper
behavior, the server consumer-state and heartbeat surfaces, and the idempotent per-service
Compose scaffold route. Specification tests come first in every feature phase, followed by a
distinct red-phase verification, implementation, green-phase verification, implementation
tests, and a full repository gate.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
| ----- | ----- | ----- |
| 1 | Agent foundation: package, config, manifest, state, client, join | 16 |
| 2 | Delivery: startup, refresh matrix, atomic writes, status, socket | 12 |
| 3 | Renewal, wrapper, CLI, health | 13 |
| 4 | Server consumer state, heartbeat, contracts, scaffold | 20 |
| 5 | Documentation, release verification, review, merge | 18 |

**Total: 79 tasks across 5 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the single source of truth for progress. Every task line appears
> exactly once. The executing agent MUST mark `[~]` with a timestamp on implementation, promote
> to `[x]` only after verification, update the Progress header after every task, and use `[!]`
> with a short reason on a blocker. Timestamps come from `date '+%Y-%m-%d %H:%M'`.

---

## Phase 1: Agent Foundation

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — new package, TLS, key handling, and security-sensitive validation.

### Step 1.1: Package Skeleton and Specification Tests (Red)

**Reference**: [03-01-agent-runtime.md](03-01-agent-runtime.md) · [07-testing-strategy.md](07-testing-strategy.md) ST-1–ST-23 · AR-1–AR-10, AR-17, AR-26
**Objective**: Create the test harness, then write the immutable oracle before product modules.

- [x] 1.1.1 Create `apps/agent/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, and the `bin` entry; add pinned dependencies and update the lockfile ✅ (completed: 2026-11-05 11:05)
- [x] 1.1.2 [spec-author] Write `apps/agent/tests/manifest.spec.test.ts` for ST-1–ST-13 ✅ (completed: 2026-11-05 11:05)
- [x] 1.1.3 [spec-author] Write `apps/agent/tests/join.spec.test.ts` for ST-14–ST-23 ✅ (completed: 2026-11-05 11:05)
- [x] 1.1.4 Run the two spec files and record the red-phase failure (product modules do not exist yet) ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Spec tests trace every case to a plain-language behavior, not an ST/RD id
- [ ] The red phase fails on missing product modules, not on a missing package

**Verify**: `pnpm --filter @openvault/agent test` fails with missing-module errors

### Step 1.2: Implementation

**Reference**: [03-01-agent-runtime.md](03-01-agent-runtime.md) §Configuration–§Join · AR-1–AR-10, AR-17, AR-26
**Objective**: Build the foundation modules.

- [x] 1.2.1 Implement `apps/agent/src/errors.ts` with the stable code union and static messages ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.2 Implement `apps/agent/src/logger.ts` with structured value-free events ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.3 Implement `apps/agent/src/config.ts` for every environment value and bound in the spec ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.4 Implement `apps/agent/src/manifest.ts` with strict YAML, duplicate-key rejection, both-target entries, and the raw-byte hash ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.5 Implement `apps/agent/src/state.ts` with the `0700` directory, descriptor-based reads, atomic `identity.json`/`managed-files.json`, and pending-renewal storage ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.6 Implement `apps/agent/src/client.ts` with `node:https`, CA/client certificate handling, timeouts, response bounds, schema validation, and explicit error kinds ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.7 Implement `apps/agent/src/join.ts` with P-256 key/CSR generation, consumer metadata, expired-state rejoin, transient retry, and state persistence ✅ (completed: 2026-11-05 11:05)
- [x] 1.2.8 Run the Phase 1 spec tests and record the green-phase result ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] `apps/agent` builds as ESM with `dist/main.js`
- [ ] ST-1–ST-23 pass
- [ ] No private key, token, or value appears in a log or error

**Verify**: `pnpm --filter @openvault/agent test && pnpm --filter @openvault/agent typecheck`

### Step 1.3: Implementation Tests and Foundation Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-8, AR-17
**Objective**: Cover internals and prove the package fits the workspace.

- [x] 1.3.1 Write `apps/agent/tests/state.impl.test.ts` for directory races, `O_NOFOLLOW` swaps, corrupt JSON, permission drift, pending age, and managed-file reconciliation ✅ (completed: 2026-11-05 11:05)
- [x] 1.3.2 Write `apps/agent/tests/client.impl.test.ts` for the TLS classification table, timeout, redirect refusal, response bounds, and schema parse failures ✅ (completed: 2026-11-05 11:05)
- [x] 1.3.3 Run the package tests, typecheck, lint, and build ✅ (completed: 2026-11-05 11:05)
- [x] 1.3.4 Run the full `pnpm verify` gate ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Implementation tests pass
- [ ] `pnpm verify` passes with the new package

**Verify**: `pnpm verify`

---

## Phase 2: Delivery, Status, and Local Socket

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — the failure matrix, atomic writes, and single-flight behavior are the highest-risk paths.

### Step 2.1: Specification Tests (Red)

**Reference**: [03-02-delivery.md](03-02-delivery.md) §Startup–§Local socket · [07-testing-strategy.md](07-testing-strategy.md) ST-24–ST-45, ST-70, ST-74–ST-77 · AR-6, AR-11–AR-14, AR-31
**Objective**: Write the failure-matrix and local-surface oracle before implementation.

- [x] 2.1.1 [spec-author] Write `apps/agent/tests/delivery.spec.test.ts` for ST-24–ST-45 ✅ (completed: 2026-11-05 11:05)
- [x] 2.1.2 [spec-author] Write `apps/agent/tests/status-socket.spec.test.ts` for ST-70 and ST-74–ST-77 ✅ (completed: 2026-11-05 11:05)
- [x] 2.1.3 Run the two spec files and record the red-phase failure ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Every failure-matrix row has a spec test
- [ ] The socket tests assert no vault call

**Verify**: `pnpm --filter @openvault/agent test` fails on missing delivery/status/socket modules

### Step 2.2: Implementation

**Reference**: [03-02-delivery.md](03-02-delivery.md) §Startup–§Local socket · AR-6, AR-11–AR-14, AR-31
**Objective**: Implement startup buffering/staging, the refresh matrix, managed-file cleanup, status, and the socket.

- [x] 2.2.1 Implement `apps/agent/src/delivery.ts` with managed-file tracking, atomic writes, staged startup, removal reconciliation, and `refreshOnce` ✅ (completed: 2026-11-05 11:05)
- [x] 2.2.2 Implement `apps/agent/src/status.ts` with the value-free document, `requiredReady`, and renewal state ✅ (completed: 2026-11-05 11:05)
- [x] 2.2.3 Implement `apps/agent/src/socket.ts` with the `0660` unix socket and manifest-only routes ✅ (completed: 2026-11-05 11:05)
- [x] 2.2.4 Implement `apps/agent/src/runner.ts` for startup, single-flight refresh timers, status, socket lifecycle, and cancellation hooks (renewal and wrapper hooks are completed in Phase 3) ✅ (completed: 2026-11-05 11:05)
- [x] 2.2.5 Run the Phase 2 spec tests and record the green-phase result ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] ST-24–ST-45, ST-70, and ST-74–ST-77 pass
- [ ] The local socket never calls the vault
- [ ] Status contains no values or key material

**Verify**: `pnpm --filter @openvault/agent test && pnpm --filter @openvault/agent typecheck`

### Step 2.3: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests
**Objective**: Cover atomic-write and runner internals.

- [x] 2.3.1 Write `apps/agent/tests/atomic-write.impl.test.ts` for temp cleanup, staged startup, rename/flush failure, and concurrent writers ✅ (completed: 2026-11-05 11:05)
- [x] 2.3.2 Write `apps/agent/tests/runner.impl.test.ts` for single-flight, cancellation, timer jitter, and idempotent stop ✅ (completed: 2026-11-05 11:05)
- [x] 2.3.3 Run the package tests, typecheck, lint, and build ✅ (completed: 2026-11-05 11:05)
- [x] 2.3.4 Run the full `pnpm verify` gate ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Implementation tests pass
- [ ] No partial file is observable under a failed write
- [ ] A credential failure cannot be undone by an in-flight cycle

**Verify**: `pnpm verify`

---

## Phase 3: Renewal, Wrapper, CLI, and Health

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — key rotation, replay safety, long timers, child-process termination, and credential failure.

### Step 3.1: Specification Tests (Red)

**Reference**: [03-02-delivery.md](03-02-delivery.md) §Renewal–§Commands · [07-testing-strategy.md](07-testing-strategy.md) ST-58–ST-69, ST-68a, ST-68b, ST-71–ST-73, ST-78–ST-86 · AR-3, AR-10, AR-15, AR-16, AR-32
**Objective**: Write the renewal, wrapper, CLI, and leakage oracle.

- [x] 3.1.1 [spec-author] Write `apps/agent/tests/renewal.spec.test.ts` for ST-58–ST-69, ST-68a, and ST-68b ✅ (completed: 2026-11-05 11:05)
- [x] 3.1.2 [spec-author] Write `apps/agent/tests/wrapper-logging.spec.test.ts` for ST-71–ST-73 and ST-78–ST-86 ✅ (completed: 2026-11-05 11:05)
- [x] 3.1.3 Run the two spec files and record the red-phase failure ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Renewal replay, `not_due`, `not_current`, and long-lifetime cases are explicit
- [ ] Captured-log and child-environment tests use sentinel values

**Verify**: `pnpm --filter @openvault/agent test` fails on missing renewal/wrapper modules

### Step 3.2: Implementation

**Reference**: [03-02-delivery.md](03-02-delivery.md) §Renewal–§Commands · AR-3, AR-10, AR-15, AR-16, AR-32
**Objective**: Complete the lifecycle and command surface.

- [x] 3.2.1 Implement `apps/agent/src/renewal.ts` with the two-thirds schedule, chunked long timers, jitter, backoff, five-minute pending-key reuse, `not_due`/`not_current` handling, and atomic swap ✅ (completed: 2026-11-05 11:05)
- [x] 3.2.2 Implement wrapper mode in `apps/agent/src/runner.ts` with the sanitized child environment, env denylist, UTF-8 rule, `spawn` without a shell, and child termination ✅ (completed: 2026-11-05 11:05)
- [x] 3.2.3 Implement the `health`, `--ready`, and `--max-age` behavior in `apps/agent/src/status.ts` ✅ (completed: 2026-11-05 11:05)
- [x] 3.2.4 Implement `apps/agent/src/main.ts` with `run`, `health`, `--once`, option parsing, and `--` passthrough ✅ (completed: 2026-11-05 11:05)
- [x] 3.2.5 Wire renewal timers, signals, and clean shutdown into `apps/agent/src/runner.ts` ✅ (completed: 2026-11-05 11:05)
- [x] 3.2.6 Run the Phase 3 spec tests and record the green-phase result ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] ST-58–ST-69, ST-68a/ST-68b, ST-71–ST-73, and ST-78–ST-86 pass
- [ ] A lost renewal response reuses the same pending key/CSR
- [ ] The wrapper child receives no `OPENVAULT_*` variable
- [ ] No value or key appears in logs

**Verify**: `pnpm --filter @openvault/agent test && pnpm --filter @openvault/agent typecheck`

### Step 3.3: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests
**Objective**: Cover renewal and child-process internals.

- [x] 3.3.1 Write `apps/agent/tests/renewal.impl.test.ts` for schedule boundaries, pending age, `not_current`, and new-key-after-window ✅ (completed: 2026-11-05 11:05)
- [x] 3.3.2 Write `apps/agent/tests/runner.impl.test.ts` additions for signal shutdown, wrapper termination, and exit-code propagation ✅ (completed: 2026-11-05 11:05)
- [x] 3.3.3 Run the package tests, typecheck, lint, and build ✅ (completed: 2026-11-05 11:05)
- [x] 3.3.4 Run the full `pnpm verify` gate ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Implementation tests pass
- [ ] `ov-agent health` and `health --ready` exit correctly from the built binary

**Verify**: `pnpm verify`

---

## Phase 4: Server Consumer State, Heartbeat, Contracts, and Scaffold

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — authorization, idempotence, audit ordering, and object-scope grants.

### Step 4.1: Specification Tests (Red)

**Reference**: [03-03-server-state-scaffold.md](03-03-server-state-scaffold.md) · [07-testing-strategy.md](07-testing-strategy.md) ST-46–ST-57, ST-87–ST-117 · AR-18–AR-22
**Objective**: Write the server-side oracle against the real agent listener and PostgreSQL.

- [x] 4.1.1 [spec-author] Write `packages/api-contract/tests/scaffold.spec.test.ts` for ST-109–ST-110 ✅ (completed: 2026-11-05 11:05)
- [x] 4.1.2 [spec-author] Write `apps/server/tests/integration/secrets-consumer-state.spec.test.ts` for ST-46–ST-57 and ST-114 ✅ (completed: 2026-11-05 11:05)
- [x] 4.1.3 [spec-author] Write `apps/server/tests/integration/scaffold.spec.test.ts` for ST-87–ST-108 and ST-115–ST-117 ✅ (completed: 2026-11-05 11:05)
- [x] 4.1.4 Run the spec files and record the red-phase failure (route/contracts absent) ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Tests use the real agent listener and real PostgreSQL
- [ ] Scaffold tests assert per-service Compose output, object-scope-only grants, broader-grant rejection, and token absence

**Verify**: `pnpm --filter @openvault/server test:integration -- secrets-consumer-state scaffold` fails

### Step 4.2: Implementation

**Reference**: [03-03-server-state-scaffold.md](03-03-server-state-scaffold.md) §Consumer heartbeat–§Route · AR-18–AR-22
**Objective**: Add the heartbeat state/route and the per-service scaffold route.

- [x] 4.2.1 Add `packages/api-contract/src/scaffold.ts`, `agentConsumerStateSchema`/response schema, and exports from `packages/api-contract/src/index.ts` ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.2 Add `ConsumerRepository.updateState` and `apps/server/src/agent/consumer-service.ts` with the state-change audit and a caught/logged audit failure ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.3 Add the consumer-state headers, 403/404/410 mapping, and best-effort heartbeat to `apps/server/src/controllers/secrets.ts` ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.4 Remove the `agentPrincipalId` read option and update the existing heartbeat test ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.5 Add the `POST /v1/agent/consumer` route returning 200 `{state}`, the 60/minute limiter, and service registration ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.6 Implement `apps/server/src/scaffold/compose.ts` with per-service and per-Compose-project state/manifest paths, quoted mapping keys and scalars, directory/file preparation comments, app UID, and manifest rendering ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.7 Add `PolicyRepository.listAllLiveForPrincipal` and implement `apps/server/src/scaffold/service.ts` with create-or-reuse project/identity, entry resolution, broader-grant rejection (including org-scope grants), object grants, stale object-grant removal, expired-assignment recreation, and token rotation ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.8 Add `IdentityService.rotateJoinToken` and the atomic `AgentTokenService.rotate` hook ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.9 Add `apps/server/src/scaffold/errors.ts` (`ScaffoldServiceError`), implement `apps/server/src/controllers/scaffold.ts` with response projections and error mapping, add the 5/minute limiter, and register services/controllers in `apps/server/src/app.ts` ✅ (completed: 2026-11-05 11:05)
- [x] 4.2.10 Run the Phase 4 spec tests and record the green-phase result ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] ST-46–ST-57, ST-87–ST-117 pass
- [ ] No project/org reader assignment is created; a broader reused grant is rejected
- [ ] Compose and manifest contain no literal token and are per-service
- [ ] State transitions are audited; `last_seen`-only updates are not

**Verify**: `pnpm --filter @openvault/server test:integration -- secrets-consumer-state scaffold`

### Step 4.3: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests
**Objective**: Cover partial-failure retries, conflict handling, audit rollback, and renderer determinism.

- [x] 4.3.1 Write `apps/server/tests/scaffold-renderer.impl.test.ts` and the scaffold integration edge cases for duplicate conflicts, disabled identity reuse, broader grants, expired assignments, concurrent entry sets, and deterministic rendering ✅ (completed: 2026-11-05 11:05)
- [x] 4.3.2 Write `apps/server/tests/integration/secrets-state.impl.test.ts` for heartbeat failure tolerance, state audit, and audit rollback ✅ (completed: 2026-11-05 11:05)
- [x] 4.3.3 Write `packages/api-contract/tests/scaffold.impl.test.ts` for boundary and projection cases ✅ (completed: 2026-11-05 11:05)
- [x] 4.3.4 Run the server unit and integration tests ✅ (completed: 2026-11-05 11:05)
- [x] 4.3.5 Run `pnpm verify` and `pnpm db:types:check` against a migrated database ✅ (completed: 2026-11-05 11:05)
- [x] 4.3.6 Run the full integration suite on PostgreSQL 16 ✅ (completed: 2026-11-05 11:05)

**Deliverables**:
- [ ] Implementation tests pass
- [ ] No schema change and no generated-type diff
- [ ] PostgreSQL 16 integration passes

**Verify**: `pnpm verify && pnpm db:types:check && pnpm test:integration`

---

## Phase 5: Documentation, Release Verification, Review, and Merge

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — documentation and release gates over verified behavior.

### Step 5.1: Documentation and Release Notes

**Reference**: [00-index.md](00-index.md) §Related Files · AR-2, AR-15, AR-21, AR-27, AR-28, AR-32
**Objective**: Make the implemented behavior discoverable and record the release.

- [x] 5.1.1 Update `docs/guide/agent.md` and `docs/guide/docker-compose.md` with the implemented runtime, manifest, failure matrix, status, socket, wrapper trust, scaffold route, per-service Compose, and token handling ✅ (completed: 2026-11-05 11:20)
- [x] 5.1.2 Update `docs/guide/secrets.md` for consumer state/heartbeat and `docs/architecture/agent-delivery.md` for renewal, audit, and scaffold details ✅ (completed: 2026-11-05 11:20)
- [x] 5.1.3 Update `docs/reference/api.md` and `docs/reference/configuration.md` with the scaffold route, heartbeat route, state headers, and agent environment ✅ (completed: 2026-11-05 11:20)
- [x] 5.1.4 Update `docs/security/limitations.md` with the accepted agent residuals (wrapper same-UID trust, expired-certificate heartbeat gap, network-failure state lag, non-durable renewal replay) ✅ (completed: 2026-11-05 11:20)
- [x] 5.1.5 Add `deploy/compose/agent.example.yaml`, update `docs/changelog.md`, and add `.changeset/agent.md` ✅ (completed: 2026-11-05 11:20)
- [x] 5.1.6 Run the docs build, `pnpm changeset status`, and `pnpm audit:prod` ✅ (completed: 2026-11-05 11:20)

**Deliverables**:
- [ ] Docs build passes
- [ ] Changeset names `@openvault/agent`, `@openvault/api-contract`, and `@openvault/server`
- [ ] Production audit passes

**Verify**: `pnpm docs:build && pnpm changeset status && pnpm audit:prod`

### Step 5.2: Release Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Verification Checklist · AR-25
**Objective**: Prove every gate on the final tree.

- [x] 5.2.1 Run `pnpm verify` ✅ (completed: 2026-11-05 11:20)
- [x] 5.2.2 Run `pnpm db:migrate` and `pnpm db:types:check` with `OPENVAULT_DB_URL` ✅ (completed: 2026-11-05 11:20)
- [x] 5.2.3 Run the full integration suite on PostgreSQL 16 ✅ (completed: 2026-11-05 11:20)
- [x] 5.2.4 Run the full integration suite on PostgreSQL 17 ✅ (completed: 2026-11-05 11:20)
- [x] 5.2.5 Run `pnpm changeset status` and the docs build one final time ✅ (completed: 2026-11-05 11:20)

**Deliverables**:
- [ ] Every gate passes
- [ ] Integration totals are recorded in the findings ledger

**Verify**: All commands exit 0; PostgreSQL 16 and 17 report the same passing total

### Step 5.3: Review, Merge, and Cleanup

**Reference**: [00-index.md](00-index.md) · project quality policy
**Objective**: Review the phase, resolve findings, merge through a pull request, and leave a clean tree.

- [x] 5.3.1 Run a correctness review over the agent and server changes; record findings in `05-findings.md` ✅ (completed: 2026-11-05 12:10)
- [x] 5.3.2 Run a security/concurrency review over TLS, key storage, file writes, headers, heartbeat audit, scaffold authorization, Compose generation, and logs; record findings ✅ (completed: 2026-11-05 12:10)
- [x] 5.3.3 Fix every critical/major finding and re-review; accept only documented minors/residuals ✅ (completed: 2026-11-05 12:10)
- [x] 5.3.4 Re-run `pnpm verify`, the database gates, and the PostgreSQL 16/17 integration suites after fixes ✅ (completed: 2026-11-05 12:10)
- [ ] 5.3.5 Mark the execution plan complete, set the plan index to Done, and update both roadmaps to 10/14 RDs
- [ ] 5.3.6 Use the git-commit skill in push mode, open a pull request, squash-merge after required checks pass, and delete the branch
- [ ] 5.3.7 Remove temporary artifacts and confirm a clean `main` worktree

**Deliverables**:
- [ ] Findings ledger records every ruling
- [ ] Pull request is squash-merged and the branch is deleted
- [ ] No temporary files remain

**Verify**: `git status` is clean on `main`; the remote branch is absent

---

## Dependencies

```text
Phase 1 (foundation)
    ↓
Phase 2 (delivery) ──────┐
    ↓                    │
Phase 3 (renewal/wrapper)│
    ↓                    │
Phase 4 (server state/heartbeat/scaffold)
    ↓
Phase 5 (docs/release/review/merge)
```

Phase 2 and Phase 3 use the Phase 1 client/join/state. Phase 4 is independent of Phases 2–3
at runtime but is ordered after them so the agent contract is fixed before the server tests
drive it. Phase 5 requires all prior phases.

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed
2. ✅ `pnpm verify` passes
3. ✅ `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, and the docs build pass
4. ✅ The full integration suite passes on PostgreSQL 16 and 17
5. ✅ No secret value, private key, certificate body, or join token appears in logs, status,
   the local socket status, errors, or Compose/manifest output (the value endpoint is the only
   documented value surface)
6. ✅ The failure matrix and single-flight/cancellation behavior are covered end to end
7. ✅ The scaffold is idempotent, per-service, and grants only object-scope reader
8. ✅ Documentation, deployment example, changelog, and changeset are updated
9. ✅ Correctness and security reviews have no open critical/major finding
10. ✅ The pull request is squash-merged and the branch is deleted

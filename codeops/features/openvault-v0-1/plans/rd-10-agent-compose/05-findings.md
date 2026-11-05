# Findings Ledger: RD-10 Agent Delivery and Compose

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Closed — all critical/major findings fixed; minors fixed or accepted
> **Last Updated**: 2026-11-05 12:10
> **CodeOps Artifact Schema**: 1

## Purpose

This ledger records post-phase correctness and security/concurrency review findings, their
rulings, and accepted residuals.

## Planning-Stage Findings

The planning-stage preflight findings and resolutions are recorded in
[00-preflight-report.md](00-preflight-report.md) and are not duplicated here.

## Execution Findings

### Correctness Review

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| R10-C1 | Critical | A credential failure during a refresh or renewal could be undone by an in-flight cycle that re-added files and wrote a non-failed heartbeat. | Added `VaultClient.cancel()`, a runner-owned active-refresh wait, a cancellation check after every delivery await, an `isCancelled` delivery seam, and a final removal after the active cycle drains. Added `delivery-cancel.impl.test.ts`. | Fixed |
| R10-M1 | Major | Write-failure cleanup removed the whole managed set on refresh, startup renamed files one at a time, and status-write failures removed files. | Startup now stages every temporary file through `stageFile`/`commitStaged` before renaming; startup write failure removes the managed set, refresh write failure keeps complete files; status-write failure keeps files. | Fixed |
| R10-M2 | Major | An optional `env` decode failure was treated as a global terminal failure. | Per-entry `envError`: optional entries degrade and keep file delivery; required entries fail `agent_request_rejected`. Wrapper skips invalid env targets. | Fixed |
| R10-M3 | Major | The wrapper child SIGKILL check used `child.killed`, which becomes true after SIGTERM, so a child ignoring SIGTERM survived; `stop()` did not signal the child. | Added `#terminateChild()` using `exitCode`/`signalCode`, a 5-second grace, SIGKILL, spawn error handling, and signal-driven child termination. Added an ignore-SIGTERM test. | Fixed |
| R10-M4 | Major | Refresh reset the aggregate state to `ok` and could send a spurious `ok` before a later failure. | Refresh starts from the previous snapshot state and resets to `ok` only after a clean cycle; the final heartbeat records the aggregate. | Fixed |
| R10-M5 | Major | `listAllLiveForPrincipal` treated expired broader grants as live, causing a false 409. | Added `expires_at IS NULL OR expires_at > now()` and an expired-grant integration test. | Fixed |
| R10-M6 | Major | Scaffold reconciliation was not serialized; concurrent different entry sets could leave the union of grants. | Added a per-identity in-process mutex around grant reconciliation and token rotation; added a concurrent different-entry-set test. Single-node v0.1 scope is documented. | Fixed |
| R10-M7 | Major | The execution plan marked missing implementation-test files complete, and some tests did not prove side effects. | Added cancellation/cleanup tests, wrapper termination, stale pending, untrusted CA, contract tests, project-not-created and concurrent-scaffold assertions; updated the plan references. | Fixed |
| R10-m1 | Minor | The managed ledger recorded every manifest target, not only delivered files. | Ledger now records delivered file targets only; removals check the previous ledger or delivered memory. | Fixed |
| R10-m2 | Minor | Renewal 404 mapped to `agent_secret_not_found`. | Mapped to `agent_renewal_terminal`. | Fixed |
| R10-m3 | Minor | Renewal retry was a fixed 30 seconds. | Added exponential backoff from 1s to 5 minutes with jitter; reset on success. | Fixed |
| R10-m4 | Minor | `health` accepted run-only options. | Added a per-command option allowlist. | Fixed |
| R10-m5 | Minor | Renewal upsert reset a degraded consumer to `ok`. | Renewal upserts with `preserveState: true`; join still sets `ok`. | Fixed |
| R10-m6 | Minor | Stale pending renewal files were not deleted. | `loadPendingRenewal` deletes a file older than five minutes. | Fixed |
| R10-m7 | Minor | CA file validation was deferred and weak. | `loadAgentConfig` now checks a regular file, 1 MiB bound, and PEM certificate content before manifest loading. | Fixed |
| R10-m8 | Minor | The network-code regex matched `ERR_*` codes as transient. | Replaced with an exact socket-code allowlist; unknown TLS/OpenSSL errors fail closed as credential. | Fixed |

### Security and Concurrency Review

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| AR-01 | Critical | Same cancellation/re-add race as R10-C1. | Fixed with the cancellation and active-cycle drain above. | Fixed |
| AR-02 | Major | One failed removal aborted cleanup of remaining files and kept values in memory. | `removeManagedFiles` attempts every target, clears memory in `finally`, and throws the first error after the loop. | Fixed |
| AR-03 | Major | Wrapper child was never SIGKILLed after the grace period. | Fixed with `#terminateChild`; added an ignore-SIGTERM test. | Fixed |
| AR-04 | Minor | Concurrent scaffold reconciliation could leave extra grants. | Fixed with the per-identity mutex and concurrent test. | Fixed |
| AR-05 | Minor | Expired broader grants caused a false 409. | Fixed with the expiry filter and test. | Fixed |
| AR-06 | Minor | Renewal retry had no exponential backoff or jitter. | Fixed. | Fixed |
| AR-07 | Minor | The 10-second timeout was only a socket inactivity timeout. | The request timeout plus cancellation covers slow-drip responses; accepted as a residual if a proxy keeps the socket active. | Accepted |
| AR-08 | Minor | `ERR_*` codes were treated as transient network failures. | Fixed with the exact socket allowlist. | Fixed |
| AR-09 | Minor | Join/renew saved a certificate without checking it matches the private key. | Added `certificateMatchesKey` before every identity save. | Fixed |
| AR-10 | Minor | Stale pending renewal material was not deleted. | Fixed. | Fixed |
| AR-11 | Minor | Startup staging claim did not match the one-file-at-a-time implementation. | Implemented `stageFile`/`commitStaged`; startup stages all files before renaming. | Fixed |
| AR-12 | Minor | The ledger and optional-failure removal could touch an unrelated operator file. | Ledger now records delivered targets; optional removal checks the previous ledger or delivered memory. | Fixed |
| AR-13 | Minor | Refresh started at `ok`, and the socket synthesized fresh timestamps. | Refresh starts from the previous state; the runner stores real last-attempt/last-success times for both status surfaces. | Fixed |
| AR-14 | Minor | Restart after revocation reused the revoked certificate and ignored a new token. | A credential rejection clears `identity.json` and pending material, so a supplied token can rejoin. | Fixed |
| AR-15 | Minor | A FIFO at a state path could block `open` before `fstat`. | Added `O_NONBLOCK`; non-regular files are rejected after `fstat`. | Fixed |
| AR-16 | Minor | `spawn` had no error listener. | Added a child error handler that enters the terminal path. | Fixed |
| P-01 | Minor | Missing implementation-test files and unproven coverage claims. | Added the regression tests and contract tests; updated the plan. | Fixed |

## Accepted Residuals

| ID | Residual | Reason | Documentation |
|---|---|---|---|
| RR-01 | Wrapper same-UID trust exposes the state directory and private key to the wrapped application | RD-10 mandates same-UID wrapper mode; sidecar is the secure default | `docs/security/limitations.md` item 39 |
| RR-02 | Expired client certificates cannot update consumer state before authentication | Middleware rejects before a principal exists; renewal prevents expiry | item 40 |
| RR-03 | A network failure leaves consumer state stale until the next successful fetch/heartbeat | The server cannot observe an unreachable agent | item 41 |
| RR-04 | Renewal replay is not durable across a server restart | RD-05's replay cache is process-local | item 42 |
| RR-05 | The shared consumer contract accepts arbitrary 1–100 character Compose names | Upstream RD-05 contract; the agent validates its own values | item 43 |
| RR-06 | The agent image is not published by this plan | RD-14 owns image build/signing/publishing | item 44 |
| RR-07 | The client timeout is a socket inactivity timeout, not a hard wall-clock deadline | Node request cancellation and the runner's terminal path bound normal failures; a slow-drip proxy is an operational edge | Accepted in this ledger |

## Verification Evidence

| Gate | Result | Date |
|---|---|---|
| Planning preflight | Passed after three review lenses | 2026-11-05 |
| `pnpm verify` | Pass | 2026-11-05 |
| `pnpm db:migrate` + `pnpm db:types:check` | Pass | 2026-11-05 |
| `pnpm changeset status` | Minor bump: `@openvault/agent`, `@openvault/api-contract`, `@openvault/server` | 2026-11-05 |
| `pnpm audit:prod` | No known vulnerabilities | 2026-11-05 |
| Docs build | Pass | 2026-11-05 |
| Integration, PostgreSQL 16 | 677/677 passed | 2026-11-05 |
| Integration, PostgreSQL 17 | 677/677 passed | 2026-11-05 |
| Correctness review | 1 critical, 7 major fixed; minors fixed/accepted | 2026-11-05 |
| Security/concurrency review | 1 critical, 2 major fixed; minors fixed/accepted | 2026-11-05 |

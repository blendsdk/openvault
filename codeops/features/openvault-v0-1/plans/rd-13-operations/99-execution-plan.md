# Execution Plan: RD-13 Operations

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Status**: Done
> **Last Updated**: 2026-11-06 18:30
> **Progress**: 34/34 tasks (100%)

> **Rule:** one task at a time. Mark `[x]` only after the task verifies, update the Progress
> header after every task, and record a finding in [05-findings.md](05-findings.md) when
> reality diverges from the plan.

**Total: 34 tasks across 4 phases**

---

## Phase 1: Operations Code

> **Reasoning**: high — credential handling, restore verification, and startup migration affect security.

### Step 1.1: Restore agent-certificate verification

- [x] 1.1.1 Add `agentCertificatePath` to restore options and verify chain, principal CN, and validity against the restored CA
- [x] 1.1.2 Add `--agent-certificate` to `ov restore` and document the drill input
- [x] 1.1.3 Extend the ops integration test to issue a pre-backup agent certificate and verify it after restore

**Verify**: `pnpm --filter @openvault/server test:integration -- ops.spec`

### Step 1.2: File-backed database URLs and migration role

- [x] 1.2.1 Read `OPENVAULT_DB_URL_FILE`, `OPENVAULT_MIGRATION_DB_URL_FILE`, and `OPENVAULT_PURGE_DB_URL_FILE` before config validation
- [x] 1.2.2 Add optional `OPENVAULT_MIGRATION_DB_URL`, require the same database identity, and run startup migrations with it
- [x] 1.2.3 Add CLI file-backed URL support for init, backup, restore, and KEK rotation
- [x] 1.2.4 Add config and startup tests for file URLs and migration-role separation

**Verify**: `pnpm --filter @openvault/server test -- config startup && pnpm --filter @openvault/cli test`

### Step 1.3: PostgreSQL roles

- [x] 1.3.1 Add `deploy/postgres/roles.sql` with migrator ownership, runtime DML, purger grants, and pruner grants
- [x] 1.3.2 Add `deploy/postgres/init-roles.sh` that reads Docker secrets and applies the SQL once
- [x] 1.3.3 Add an integration test proving app cannot run DDL, app can run DML, and purger/pruner can execute their controlled paths

**Verify**: `pnpm --filter @openvault/server test:integration -- roles.spec`

### Step 1.4: Doctor checks

- [x] 1.4.1 Add database, keyring, TLS, clock, and backup-age checks with clear skipped states
- [x] 1.4.2 Add CLI tests for a healthy stack, a missing keyring, and a stale backup

**Verify**: `pnpm --filter @openvault/cli test -- commands.spec`

### Step 1.5: Checkpoint export

- [x] 1.5.1 Export `exportLatestCheckpoint` through the server ops surface
- [x] 1.5.2 Add `ov audit checkpoint --out` and update help/completion/tests
- [x] 1.5.3 Document the scheduled systemd and cron forms

**Verify**: `pnpm --filter @openvault/cli test -- dispatcher commands`

---

## Phase 2: Deployment

> **Reasoning**: high — container boundaries are the deployment security model.

### Step 2.1: Images and hardened Compose

- [x] 2.1.1 Add multi-stage server, agent, and web Dockerfiles with non-root runtime users and pinned base digests
- [x] 2.1.2 Rewrite the reference Compose stack with four services, Docker secrets, read-only roots, tmpfs, capability drops, limits, log rotation, and healthchecks
- [x] 2.1.3 Route API and readiness through the proxy and the SPA through the static web container
- [x] 2.1.4 Add the role-provisioning init wrapper and remove all plaintext passwords from the Compose model

**Verify**: `docker compose -f deploy/compose/compose.yaml config && pnpm check:compose`

### Step 2.2: Compose contract check

- [x] 2.2.1 Add `scripts/check-compose.mjs` and wire `pnpm check:compose` into `verify`
- [x] 2.2.2 Add tests or fixtures for a missing hardening field and a published internal port
- [x] 2.2.3 Add the check to CI

**Verify**: `pnpm check:compose`

---

## Phase 3: Evidence and Documentation

> **Reasoning**: medium — operator instructions must match the shipped stack.

### Step 3.1: Off-box schedule and support files

- [x] 3.1.1 Add systemd service/timer units for backup and checkpoint export with off-box copy hooks
- [x] 3.1.2 Add a Compose secrets generator script and `.gitignore` entries
- [x] 3.1.3 Add an operations runbook covering RPO/RTO, break-glass, restore drill, and role passwords

**Verify**: `shellcheck` not required; unit files parse with `systemd-analyze verify` when available

### Step 3.2: Documentation refresh

- [x] 3.2.1 Rewrite the Compose and backup/restore guides for the real stack
- [x] 3.2.2 Update configuration, hardening, limitations, README, changelog, and deployment README
- [x] 3.2.3 Add the new docs pages to the VitePress sidebar

**Verify**: `pnpm docs:build`

### Step 3.3: Final verification

- [x] 3.3.1 Run `pnpm verify`, `pnpm check:compose`, docs, and PostgreSQL 16/17 integration
- [x] 3.3.2 Review the diff for secrets, stale claims, and uncommitted build output
- [x] 3.3.3 Update the plan, findings, roadmap, and changeset

**Verify**: `pnpm verify && pnpm -r --if-present test`

---

## Phase 4: Delivery

> **Reasoning**: medium — the change crosses deployment and operator surfaces.

### Step 4.1: Review and merge

- [x] 4.1.1 Run a security/correctness review of the operations diff
- [x] 4.1.2 Commit, open a pull request, and pass CI
- [x] 4.1.3 Squash-merge and delete the branch

**Verify**: `gh pr checks <number> --watch` and a clean `main`

# Execution Plan: RD-11 CLI

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Last Updated**: 2026-11-05 18:10
> **Progress**: 92/92 tasks (100%)
> **CodeOps Artifact Schema**: 1

## Overview

Implement the `ov` CLI package, the generated API contract and client, the protected credential
store, the complete command surface backed by existing APIs, the shared bootstrap command, and
the RD-13-gated command surface. Every feature phase writes specification tests first, records a
distinct red phase, implements, records a green phase, adds implementation tests, and runs the
full gate.

**🚨 Update this document after EACH completed task!**

---

## Implementation Phases

| Phase | Title | Tasks |
| ----- | ----- | ----- |
| 1 | CLI foundation, contract generation, credential store, transport, dispatcher | 22 |
| 2 | Auth, project, and secret commands | 12 |
| 3 | Certificate, identity, role, access, and audit commands | 15 |
| 4 | Scaffold, run, init, doctor, completion, deferred commands | 25 |
| 5 | Documentation, release verification, review, merge | 18 |

**Total: 92 tasks across 5 phases**

> **⚠️ EXECUTION RULE — APPLIES TO EVERY AGENT EXECUTING THIS PLAN:**
>
> The task checkboxes below are the single source of truth for progress. Every task line appears
> exactly once. The executing agent MUST mark `[~]` with a timestamp on implementation, promote
> to `[x]` only after verification, update the Progress header after every task, and use `[!]`
> with a short reason on a blocker. Timestamps come from `date '+%Y-%m-%d %H:%M'`.

---

## Phase 1: CLI Foundation and Contract

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — new package, generated contract, credential security, and TLS transport.

### Step 1.1: Package Skeleton and Contract Specification (Red)

**Reference**: [03-02-api-contract.md](03-02-api-contract.md) · [07-testing-strategy.md](07-testing-strategy.md) ST-119–ST-120 · AR-1, AR-6, AR-7, AR-29, AR-32
**Objective**: Create the workspace package and write the contract oracle before the generator.

- [x] 1.1.1 Create `apps/cli/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, and the `bin` entry; add `blendsdk`, `yaml`, `zod`, `@openvault/api-contract`, and `@openvault/server`; update the lockfile
- [x] 1.1.2 Add the `@openvault/server/init` export placeholder and package scripts; add root `api:generate` / `api:check` scripts and put `api:check` in `verify`
- [x] 1.1.3 [spec-author] Write `apps/server/tests/api-contract.spec.test.ts` for ST-119–ST-120: route coverage, unique operation ids, security, 2xx schemas, clean generation/check, mutation drift, stale marker
- [x] 1.1.4 Run the contract spec and record the red-phase failure (module does not exist)

**Deliverables**:
- [x] The package builds its skeleton
- [x] The red phase fails on the missing contract module, not a missing package

**Verify**: `pnpm --filter @openvault/server test -- api-contract.spec` fails on the missing module

### Step 1.2: Contract Implementation

**Reference**: [03-02-api-contract.md](03-02-api-contract.md) §Route Inventory–§Scripts · AR-6, AR-7, AR-32
**Objective**: Build the document from real controllers and generate both artifacts.

- [x] 1.2.1 Implement `apps/server/scripts/api-contract.ts` with `CONTRACT_CONTROLLERS`, `ROUTE_DOCS`, `instrumentRoute`, `buildApiDocument`, `generateContract`, `checkContract`, and `main`
- [x] 1.2.2 Add the server `api:generate` / `api:check` scripts, ignore the generated artifacts in Biome, and verify path resolution from any cwd
- [x] 1.2.3 Run `pnpm api:generate` and commit `packages/api-contract/openapi.json` plus `apps/cli/src/generated/**`
- [x] 1.2.4 Run the contract spec and `pnpm api:check`; record the green result

**Deliverables**:
- [x] Every contract controller route has metadata
- [x] The generated client is deterministic and `api:check` is clean
- [x] No internal agent/browser/OIDC route appears in the document

**Verify**: `pnpm --filter @openvault/server test -- api-contract.spec && pnpm api:check`

### Step 1.3: Runtime Specification (Red)

**Reference**: [03-01-cli-runtime.md](03-01-cli-runtime.md) · [07-testing-strategy.md](07-testing-strategy.md) ST-1–ST-53 · AR-4, AR-5, AR-8–AR-13, AR-24, AR-25, AR-38
**Objective**: Write the credential, dispatcher, transport, and output oracle.

- [x] 1.3.1 [spec-author] Write `apps/cli/tests/credentials.spec.test.ts` for ST-1–ST-20
- [x] 1.3.2 [spec-author] Write `apps/cli/tests/dispatcher.spec.test.ts` for the Phase 1 subset ST-21–ST-26, ST-31–ST-36, and the core help/exit/single-command cases; command positionals and destructive prompts belong to Phases 2–4
- [x] 1.3.3 [spec-author] Write `apps/cli/tests/transport.spec.test.ts` for ST-40–ST-53
- [x] 1.3.4 Run the three spec files and record the red-phase failure

**Deliverables**:
- [x] Credential tests cover paths, modes, atomic writes, symlinks, lock, and refresh serialization
- [x] Transport tests use a real HTTPS server with a generated CA
- [x] Dispatcher tests cover global options, positionals, `--`, and exit codes

**Verify**: `pnpm --filter @openvault/cli test` fails on missing modules

### Step 1.4: Runtime Implementation

**Reference**: [03-01-cli-runtime.md](03-01-cli-runtime.md) §Runtime injection–§Output · AR-4, AR-5, AR-8–AR-13, AR-24, AR-25, AR-38
**Objective**: Build the credential store, transport, client wiring, output, and dispatcher.

- [x] 1.4.1 Implement `apps/cli/src/credentials/{paths,store,lock,password}.ts`
- [x] 1.4.2 Implement `apps/cli/src/transport/https-adapter.ts` with JSON bounds, `probe`, and `download`
- [x] 1.4.3 Implement `apps/cli/src/client/{authenticated,anonymous}.ts` with `BearerAuth`, locked refresh, and one 429 retry
- [x] 1.4.4 Implement `apps/cli/src/{errors,output,config,dispatcher,cli,main}.ts` with global options, root help, version, positional rewriting, and exit mapping
- [x] 1.4.5 Add the empty group registry and a placeholder `run` handler; wire `main.ts` to `runCli`
- [x] 1.4.6 Run the Phase 1 spec tests and record the green result (core runtime only)

**Deliverables**:
- [x] ST-1–ST-26, ST-31–ST-36, and ST-40–ST-53 pass; command-specific cases are green in their owning phase
- [x] The credential file is `0600` and atomic
- [x] No token or value appears in output or verbose events

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

### Step 1.5: Implementation Tests and Foundation Gate

**Reference**: [03-01-cli-runtime.md](03-01-cli-runtime.md) §Testing Requirements · AR-8–AR-12
**Objective**: Cover internals and prove the package fits the workspace.

- [x] 1.5.1 Write `apps/cli/tests/credentials.impl.test.ts` for rename/fsync failure, stale PID reuse, corrupt fields, and concurrent refresh
- [x] 1.5.2 Extend `apps/cli/tests/transport.spec.test.ts` for bound edges, timeout, socket errors, redirects, probe headers, and streaming partial cleanup
- [x] 1.5.3 Run the CLI package tests, typecheck, lint, and build
- [x] 1.5.4 Run the full `pnpm verify` gate (including `api:check`)

**Deliverables**:
- [x] Implementation tests pass
- [x] `pnpm verify` passes with the new package and generated client

**Verify**: `pnpm verify`

---

## Phase 2: Auth, Project, and Secret Commands

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — credentials, secret values, and create/update races.

### Step 2.1: Specification Tests (Red)

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Auth commands–§Secret commands · [07-testing-strategy.md](07-testing-strategy.md) ST-54–ST-77 · AR-13, AR-15, AR-16, AR-22
**Objective**: Write the auth/project/secret oracle against the fake HTTPS vault.

- [x] 2.1.1 [spec-author] Write `apps/cli/tests/auth-commands.spec.test.ts` for ST-54–ST-62
- [x] 2.1.2 [spec-author] Write `apps/cli/tests/project-secret-commands.spec.test.ts` for ST-63–ST-77
- [x] 2.1.3 Run the two spec files and record the red-phase failure

**Deliverables**:
- [x] Login/logout/session tests assert the credential file and no token output
- [x] Secret input tests assert the value is not in argv
- [x] Project/name resolution tests cover missing names

**Verify**: `pnpm --filter @openvault/cli test` fails on missing command modules

### Step 2.2: Implementation

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Auth commands–§Secret commands · AR-13, AR-15, AR-16, AR-22
**Objective**: Implement auth, project, and secret commands.

- [x] 2.2.1 Implement `apps/cli/src/commands/auth.ts` with login, logout, whoami, and sessions
- [x] 2.2.2 Implement `apps/cli/src/commands/project.ts` and the shared project resolver
- [x] 2.2.3 Implement `apps/cli/src/commands/secret.ts` with stdin/file/prompt input, PUT-then-create, separate idempotency keys, metadata PATCH on update, tags, `--out`, and version/delete/recover/purge
- [x] 2.2.4 Implement the `auth sessions --revoke --yes` confirmation and register the three groups in the dispatcher; extend root help and the positional map
- [x] 2.2.5 Run the Phase 2 spec tests and record the green result

**Deliverables**:
- [x] ST-54–ST-77 pass
- [x] Login stores tokens only in the credential file
- [x] `secret set` never accepts a value option
- [x] `secret get --out` writes decoded bytes with mode `0600`

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

### Step 2.3: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-15, AR-16
**Objective**: Cover input edges and create/update races.

- [x] 2.3.1 Extend `apps/cli/tests/commands.spec.test.ts` for file/descriptor input, base64 limits, duplicate tags, oversized files, and empty input
- [x] 2.3.2 Write regression tests for the 404→create, 409→PUT retry, metadata PATCH, and session-revoke confirmation paths
- [x] 2.3.3 Run the CLI package tests, typecheck, lint, and build
- [x] 2.3.4 Run the full `pnpm verify` gate

**Deliverables**:
- [x] Implementation tests pass
- [x] No value leaks in captured argv/stdout/stderr

**Verify**: `pnpm verify`

---

## Phase 3: Certificates, Identities, Roles, Access, and Audit

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — resolution correctness, destructive actions, and audit export.

### Step 3.1: Specification Tests (Red)

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Certificate commands–§Audit commands · [07-testing-strategy.md](07-testing-strategy.md) ST-78–ST-100 · AR-19–AR-23
**Objective**: Write the remaining command oracle.

- [x] 3.1.1 [spec-author] Write `apps/cli/tests/cert-identity-role-access.spec.test.ts` for ST-78–ST-96
- [x] 3.1.2 [spec-author] Write `apps/cli/tests/audit-scaffold-run.spec.test.ts` for ST-97–ST-100 (audit subset)
- [x] 3.1.3 Run the spec files and record the red-phase failure

**Deliverables**:
- [x] Private-key output is written `0600` and never printed unless requested
- [x] Role revoke ambiguity lists ids
- [x] Audit verify maps a broken chain to exit 1

**Verify**: `pnpm --filter @openvault/cli test` fails on missing command modules

### Step 3.2: Implementation

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Certificate commands–§Audit commands · AR-19–AR-23
**Objective**: Implement certificate, identity, role, access, and audit commands.

- [x] 3.2.1 Implement `apps/cli/src/commands/cert.ts` with import/generate/get/private-key/list/delete, file bounds, and the `--private-key` `--out` requirement
- [x] 3.2.2 Implement `apps/cli/src/commands/identity.ts` with name/ULID resolution and join-token output
- [x] 3.2.3 Implement `apps/cli/src/commands/role.ts` with scope resolution, unique-revoke matching, and `--assignment`
- [x] 3.2.4 Implement `apps/cli/src/commands/access.ts` with target-type resolution and action defaults
- [x] 3.2.5 Implement `apps/cli/src/commands/audit.ts` with list, verify exit codes, and streaming export
- [x] 3.2.6 Register the groups, extend root help, resolve audit `--project` to a ULID, and use list metadata for access explain
- [x] 3.2.7 Run the Phase 3 spec tests and record the green result

**Deliverables**:
- [x] ST-78–ST-100 pass
- [x] No private key or value leaks by default
- [x] Audit export writes `0600` and removes a partial file on failure

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

### Step 3.3: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-19–AR-23
**Objective**: Cover resolution and export internals.

- [x] 3.3.1 Extend `apps/cli/tests/commands.spec.test.ts` and `apps/cli/tests/errors.spec.test.ts` for ambiguous identities, role matching, access target types, audit verify JSON, and wrapped-error mapping
- [x] 3.3.2 Extend `apps/cli/tests/transport.spec.test.ts` and `commands.spec.test.ts` for existing targets, `--force`, non-2xx content type, temp+rename, refresh-on-401, and stream failure cleanup
- [x] 3.3.3 Write `apps/server/tests/integration/cli.spec.test.ts` for the real-server binary E2E (login, project/secret, identity/role/access, audit, scaffold) and run it
- [x] 3.3.3 Run the CLI package tests, typecheck, lint, and build
- [x] 3.3.4 Run the full `pnpm verify` gate

**Deliverables**:
- [x] Implementation tests pass
- [x] The command matrix is complete except the explicit RD-13 commands

**Verify**: `pnpm verify`

---

## Phase 4: Scaffold, Run, Init, Doctor, Completion, and Deferred Commands

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: high — bootstrap keys/CA/TLS, child delivery, and token output.

### Step 4.1: Specification Tests (Red)

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Docker scaffold–§Deferred commands · [07-testing-strategy.md](07-testing-strategy.md) ST-101–ST-118 · AR-2, AR-17, AR-18, AR-26, AR-27, AR-33–AR-36
**Objective**: Write the scaffold/run/init/deferred oracle.

- [x] 4.1.1 [spec-author] Write `apps/cli/tests/audit-scaffold-run.spec.test.ts` additions for ST-101–ST-109
- [x] 4.1.2 [spec-author] Write `apps/cli/tests/init-deferred-doctor.spec.test.ts` for ST-110–ST-118 (CLI mapping subset)
- [x] 4.1.3 [spec-author] Write `apps/server/tests/init.spec.test.ts` scaffolding for ST-110–ST-115 (red; module absent)
- [x] 4.1.4 Run the spec files and record the red-phase failures

**Deliverables**:
- [x] Scaffold tests assert no token in files
- [x] Run tests assert child args and temp cleanup
- [x] Init tests assert idempotence and no password output

**Verify**: `pnpm --filter @openvault/cli test` and `pnpm --filter @openvault/server test:integration -- init.spec` fail on missing modules

### Step 4.2: Scaffold and Run Implementation

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Docker scaffold–§`ov run` · AR-17, AR-18
**Objective**: Implement the scaffold and run commands.

- [x] 4.2.1 Implement `apps/cli/src/commands/docker.ts` with Compose-name validation, pre-call path/existence checks, containment, template substitution, `--force`, and one-time token output
- [x] 4.2.2 Implement `apps/cli/src/run/manifest.ts` with the strict run manifest
- [x] 4.2.3 Implement `apps/cli/src/run/delivery.ts` and `apps/cli/src/commands/run.ts` with temp delivery, env sanitization, spawn, signals, and cleanup
- [x] 4.2.4 Register the groups and extend root help
- [x] 4.2.5 Run the scaffold/run spec tests and record the green result

**Deliverables**:
- [x] ST-101–ST-109 pass
- [x] Scaffold files contain no token
- [x] Run leaves no temp directory after success, failure, or signal

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

### Step 4.3: Init Implementation

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §`ov init` · AR-3, AR-33–AR-36
**Objective**: Build the shared bootstrap primitive and the CLI command.

- [x] 4.3.1 Implement the init lock, wrapped-state recovery guard, keyring creation/validation, and migration in `apps/server/src/init/index.ts`
- [x] 4.3.2 Implement CA generation/reuse, `issueServerCertificate`, and public PEM writes in `apps/server/src/init/ca.ts`
- [x] 4.3.3 Implement server certificate generation/reuse, chain/SAN/EKU/validity checks, key-mode checks, and expired-leaf regeneration in `apps/server/src/init/tls.ts`
- [x] 4.3.4 Implement org/admin creation, password policy/order, org-name update, policy-version bump, and signing-key ensure in `apps/server/src/init/admin.ts`
- [x] 4.3.5 Export `runInit` from `@openvault/server/init` and implement `apps/cli/src/commands/init.ts` with `--prepare` and env mappings
- [x] 4.3.6 Run the init spec tests and record the green result

**Deliverables**:
- [x] ST-110–ST-115 pass
- [x] Two runs do not rotate the CA or duplicate the admin
- [x] The generated password exists only in the one-time `0600` file

**Verify**: `pnpm --filter @openvault/server test:integration -- init.spec && pnpm --filter @openvault/cli test`

### Step 4.4: Doctor, Completion, and Deferred Commands

**Reference**: [03-03-commands-init.md](03-03-commands-init.md) §Doctor and completion–§Deferred commands · AR-2, AR-26, AR-27
**Objective**: Finish the remaining surface.

- [x] 4.4.1 Implement `apps/cli/src/commands/doctor.ts` for readiness, credentials, TLS, and clock skew
- [x] 4.4.2 Implement `apps/cli/src/commands/completion.ts` for bash, zsh, and fish
- [x] 4.4.3 Implement `apps/cli/src/commands/{backup,restore,kek}.ts` as parsed, safety-gated `not_implemented` stubs marked `[RD-13]`
- [x] 4.4.4 Register the groups, extend root help, and run the Phase 4 spec tests

**Deliverables**:
- [x] ST-116–ST-118 pass
- [x] Root help lists every group and marks the RD-13 commands
- [x] Deferred commands never mutate anything

**Verify**: `pnpm --filter @openvault/cli test && pnpm --filter @openvault/cli typecheck`

### Step 4.5: Implementation Tests and Gate

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Implementation Tests · AR-17, AR-18, AR-33–AR-36
**Objective**: Cover manifest edges, cleanup, and init safety.

- [x] 4.5.1 Write `apps/cli/tests/run-manifest.spec.test.ts` for manifest edges, octal modes, binary env, and duplicate keys; keep run lifecycle/exit-code coverage in `commands.spec.test.ts`
- [x] 4.5.2 Extend `apps/cli/tests/commands.spec.test.ts` for scaffold file naming, token non-leakage, force, and path validation
- [x] 4.5.3 Extend `apps/server/tests/integration/init.spec.test.ts` for keyring mode, CA mismatch/replacement, one-sided TLS, concurrent init, FIFO rejection, and password-policy failure injection
- [x] 4.5.4 Run the CLI and server tests, typecheck, lint, and build
- [x] 4.5.5 Run `pnpm verify` and the init integration suite
- [x] 4.5.6 Run the CLI E2E against the real server after the final command changes

**Deliverables**:
- [x] Implementation tests pass
- [x] `pnpm verify` passes
- [x] Init integration passes on PostgreSQL 16

**Verify**: `pnpm verify && pnpm --filter @openvault/server test:integration -- init.spec`

---

## Phase 5: Documentation, Release Verification, Review, and Merge

> **Phase baseline tree**: recorded by the exec-plan skill at phase start.
> **Reasoning**: medium — documentation and release gates over verified behavior.

### Step 5.1: Documentation and Release Notes

**Reference**: [00-index.md](00-index.md) §Related Files · AR-2, AR-6, AR-17, AR-18, AR-33–AR-36
**Objective**: Make the implemented behavior discoverable and record the release.

- [x] 5.1.1 Update `docs/guide/cli.md` and `docs/reference/cli.md` with the dispatcher, every command, options, exit codes, credential contract, generated client, and the RD-13 marker
- [x] 5.1.2 Update `docs/reference/configuration.md` with the CLI environment and init variables; update `docs/reference/api.md` with the OpenAPI artifact and generated-client paths
- [x] 5.1.3 Update `docs/architecture/overview.md` with the CLI component and artifact locations; update `docs/guide/getting-started.md` with login/build usage
- [x] 5.1.4 Update `docs/security/limitations.md` with native-Windows fail-closed and the RD-13-gated commands
- [x] 5.1.5 Update `deploy/compose/compose.yaml` comments if the init contract changes; update `docs/changelog.md`; add `.changeset/cli.md`
- [x] 5.1.6 Run the docs build, `pnpm changeset status`, and `pnpm audit:prod`

**Deliverables**:
- [x] Docs build passes
- [x] Changeset names `@openvault/cli`, `@openvault/server`, and `@openvault/api-contract`
- [x] Production audit passes

**Verify**: `pnpm docs:build && pnpm changeset status && pnpm audit:prod`

### Step 5.2: Release Verification

**Reference**: [07-testing-strategy.md](07-testing-strategy.md) §Verification Checklist · AR-30
**Objective**: Prove every gate on the final tree.

- [x] 5.2.1 Run `pnpm verify` (includes `api:check`)
- [x] 5.2.2 Run `pnpm db:migrate` and `pnpm db:types:check` with `OPENVAULT_DB_URL`
- [x] 5.2.3 Run the full integration suite on PostgreSQL 16
- [x] 5.2.4 Run the full integration suite on PostgreSQL 17
- [x] 5.2.5 Run `pnpm changeset status` and the docs build one final time

**Deliverables**:
- [x] Every gate passes
- [x] Integration totals are recorded in the findings ledger

**Verify**: All commands exit 0; PostgreSQL 16 and 17 report the same passing total

### Step 5.3: Review, Merge, and Cleanup

**Reference**: [00-index.md](00-index.md) · project quality policy
**Objective**: Review the phase, resolve findings, merge through a pull request, and leave a clean tree.

- [x] 5.3.1 Run a correctness review (security-auditor + design-challenger lenses for auth/crypto/credential work) over the CLI, contract generator, and bootstrap changes; record findings
- [x] 5.3.2 Run a security/concurrency review (security-auditor + design-challenger lenses) over credential storage, refresh, TLS, secret input, child delivery, token output, and init; record findings
- [x] 5.3.3 Fix every critical/major finding and re-review; accept only documented minors/residuals
- [x] 5.3.4 Re-run `pnpm verify`, the database gates, and the PostgreSQL 16/17 integration suites after fixes
- [x] 5.3.5 Mark the execution plan complete, set the plan index to Done, and update both roadmaps to 11/14 RDs
- [x] 5.3.6 Use the git-commit skill in push mode, open a pull request, squash-merge after required checks pass, and delete the branch
- [x] 5.3.7 Remove temporary artifacts and confirm a clean `main` worktree

**Deliverables**:
- [x] Findings ledger records every ruling
- [x] Pull request is squash-merged and the branch is deleted
- [x] No temporary files remain

**Verify**: `git status` is clean on `main`; the remote branch is absent

---

## Execution Notes

- **Test suite shape.** The planned implementation-test filenames were consolidated by concern:
  `credentials.impl.test.ts`, `transport.spec.test.ts`, `commands.spec.test.ts`,
  `run-manifest.spec.test.ts`, `errors.spec.test.ts`, and the database-backed
  `integration/init.spec.test.ts`. Coverage is equivalent or broader than the original file list.
- **RD-13 boundary.** `ov backup`, `ov restore`, and `ov kek rotate` are registered and
  safety-gated but return `not_implemented`; this is the named RD-13 deferral in
  [01-requirements.md](01-requirements.md) §Acceptance Exception.
- **Credential lock.** Stale cleanup uses a `credentials.lock.reclaim` directory guard and
  re-checks the lock while holding it; a live lock is never renamed or unlinked. A crashed
  reclaim guard is a manual cleanup named in the error.
- **Init serialization.** Init takes a `0600` file lock and a PostgreSQL advisory lock, runs
  migrations under both, and uses `O_EXCL`/hard-link publication for the keyring. The file
  lock wait is 60 seconds.
- **Bootstrap credential.** The v0.1 bootstrap administrator is created with `must_change=false`
  because there is no CLI password-change route and the web UI is not available; the one-time
  `0600` password file must be removed after use.
- **Contract scope.** `pnpm api:check` detects route and artifact drift. A controller schema
  change that leaves the metadata table untouched is caught by the representative real-server
  command tests.
- **Verification evidence.** `pnpm verify` passes; PostgreSQL 16 and 17 integration suites each
  pass 688/688; `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, and the docs
  build pass.

---

## Dependencies

```text
Phase 1 (package + contract + runtime)
    ↓
Phase 2 (auth/project/secret)
    ↓
Phase 3 (cert/identity/role/access/audit)
    ↓
Phase 4 (scaffold/run/init/doctor/completion)
    ↓
Phase 5 (docs/release/review/merge)
```

Phase 2–4 use the Phase 1 generated client, transport, and credential store. Phase 4's init
module is independent of the generated client but uses the server package. Phase 5 requires all
prior phases.

---

## Success Criteria

**Feature is complete when:**

1. ✅ All phases completed
2. ✅ `pnpm verify` passes, including `pnpm api:check`
3. ✅ `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, and the docs build pass
4. ✅ The full integration suite passes on PostgreSQL 16 and 17
5. ✅ Every RD-11 command whose backend exists works against the real server
6. ✅ `ov init` is idempotent and never prints the password
7. ✅ The credential file, argv, logs, and error text never expose a value, password, or token
8. ✅ `pnpm api:check` fails on a mutated generated artifact
9. ✅ The three RD-13-backed commands are registered and explicitly gated
10. ✅ Documentation, changelog, and changeset are updated
11. ✅ Correctness and security reviews have no open critical/major finding
12. ✅ The pull request is squash-merged and the branch is deleted

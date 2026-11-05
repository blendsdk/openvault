# RD-11 CLI Implementation Plan

> **Feature**: The `ov` command line: credential store, generated API client, dispatcher, bootstrap, auth, project/secret/certificate/identity/role/access/audit commands, Docker scaffold, `run --`, backup, restore, KEK rotation, doctor, and completion.
> **Status**: Done
> **Created**: 2026-11-05 14:32
> **Completed**: 2026-11-06 10:00
> **Preflight**: [00-preflight-report.md](00-preflight-report.md) — passed after three review lenses
> **Implements**: openvault-v0-1/RD-11
> **CodeOps Artifact Schema**: 1

## Overview

Every server surface RD-11 needs already exists: RD-04 issued CLI login/refresh/logout/session routes, RD-06 issued scoped policy and access explanation, RD-08 issued projects and secrets, RD-09 issued certificates, and RD-10 issued the scaffold endpoint and the agent manifest/delivery model. What is missing is the client: there is no `ov` binary, no credential file, no generated API client, no dispatcher, no `pnpm api:check`, and no bootstrap command. The published CLI docs are target-state only.

This plan adds `apps/cli` with a strict credential store, a `node:https` transport, `blendsdk/cmdline` group parsers behind a thin dispatcher, and the full command set backed by the existing API. It adds a server-side `init` module so `ov init` creates the keyring, internal CA, server certificate, organization, bootstrap administrator, and signing key idempotently. It adds a server script that turns the real controllers and one documentation table into `packages/api-contract/openapi.json` and a generated typed client in the CLI, with `pnpm api:check` failing on drift.

`ov backup`, `ov restore`, and `ov kek rotate` are implemented through `apps/server/src/ops`. The archive is a passphrase-encrypted age container with a logical JSON database dump; restore verifies checksums, the audit chain, one secret per project, and the CA key; KEK rotation rewraps every stored key without re-encrypting values. The remaining RD-13 program (secret/certificate rotation workflows, Compose hardening, least-privilege role provisioning, and release engineering) stays out of this plan.

## Minimum-Sufficient Baseline

**Original goal:** Give operators and automation a safe, scriptable `ov` client for the existing OpenVault API, with a protected credential file and a generated contract.

**Smallest viable design:** One new `apps/cli` package, one server `init` module, one server contract script, and no new server product routes. Reuse `blendsdk/cmdline` for group parsing, `blendsdk/api-client` for typed requests and refresh, `blendsdk/codegen` for the OpenAPI document and client, and the existing controllers/contracts for every command. Add no database migration, no new API product surface, no CLI framework, no external HTTP client, and no backup/rotation implementation.

**Excluded machinery:** A second API definition, a hand-written HTTP client, an age/backup implementation, a TUI, multi-account profiles, OIDC CLI login, a plugin system, and a database-backed credential store. See AR-2, AR-6, AR-8, AR-17, AR-29, and AR-31.

**Approved complexity:** One new workspace package plus one server-side bootstrap module and one contract-generation script. The package is required to ship the binary; the bootstrap module is the RD-05/RD-13 shared init primitive; the script is the only way to satisfy the generated-client and drift-gate requirement with the existing `blendsdk/codegen` pattern (AR-6). No larger alternative is planned.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-11 |
| 02 | [Current State](02-current-state.md) | Existing API, auth, contracts, and gaps |
| 03-01 | [CLI Runtime](03-01-cli-runtime.md) | Package, dispatcher, credential store, transport, client, output |
| 03-02 | [API Contract](03-02-api-contract.md) | Route metadata, OpenAPI build, generated client, `api:check` |
| 03-03 | [Commands and Init](03-03-commands-init.md) | Command groups, `run`, scaffold, init, doctor, completion, deferred commands |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Login and a command

`OPENVAULT_CA_FILE` for `ov login` must point at the **proxy's public root CA** (the
reference stack uses Caddy's internal root), not the OpenVault internal CA. The internal CA is
used by the agent listener and the scaffold's `openvault-ca.pem` (AR-56).

```bash
export OPENVAULT_CA_FILE=./proxy-root-ca.pem
ov login --url https://localhost
ov whoami
ov secret set db-password --project payments --stdin
ov secret get db-password --project payments --json
```

### Generated contract

```bash
pnpm api:generate   # writes packages/api-contract/openapi.json and apps/cli/src/generated
pnpm api:check      # fails on any document or client drift
```

### Scaffold

```bash
ov docker scaffold payments api \
  --secret db-password --secret stripe-key \
  --compose-project payments
```

The token is printed once. It is never written into the Compose or manifest file.

### Run a child with delivered files

```bash
ov run --project payments -- ./start.sh
```

`openvault.run.yaml`:

```yaml
project: payments
entries:
  - name: db-password
    file: db_password
  - name: stripe-key
    env: STRIPE_KEY
    optional: true
```

### Bootstrap

```bash
ov init --prepare
```

Creates or reuses the keyring, internal CA, server certificate, organization, bootstrap
administrator, and signing key. A generated bootstrap password is written once to a `0600`
file; it is never printed.

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Package | New `apps/cli` (`@openvault/cli`, bin `ov`) | AR-1 |
| RD-13 boundary | Backup/restore/KEK rotate implemented; remaining RD-13 program deferred | AR-2 |
| Backup format | age-encrypted logical JSON dump | AR-61 |
| Restore safety | Owner role, empty target or `--force`, `--yes` | AR-62 |
| KEK rotation | Rewrap only, zero-old-key check, maintenance window | AR-63 |
| Bootstrap | `@openvault/server/init` shared primitive; `ov init` delegates | AR-3 |
| Dispatcher | Global extraction + positional conversion + strict group parsers | AR-4, AR-5 |
| Generated client | Real controllers + metadata table → OpenAPI + client; `api:check` | AR-6, AR-7 |
| Credentials | RD-11 file contract, atomic write, lock, fail closed | AR-8–AR-10 |
| Transport | `node:https`, pinned CA, bounds, no redirects | AR-11 |
| Refresh | `BearerAuth` once-per-request, unauthenticated refresh runtime | AR-12 |
| Output | Human by default; `--json` envelope; fixed exit codes | AR-13 |
| Safety | Prompt destructive commands; `--yes`; non-interactive exits 2 | AR-14 |
| Secret input | stdin, file descriptor, or hidden prompt; never argv | AR-15 |
| Set semantics | PUT then create; idempotency key; one conflict retry | AR-16 |
| Run | CLI manifest, private temp dir, files/env, no shell, cleanup | AR-17 |
| Scaffold | Write Compose + manifest; print token once; never embed it | AR-18 |
| Audit export | Raw streaming NDJSON to `0600` file | AR-19 |
| Verify | Exit 1 on a broken chain; print first bad event id | AR-20 |
| Explain | Resolve names through list metadata; default action by target type | AR-21 |
| Name resolution | Client-side list + exact match | AR-22 |
| Role revoke | Assignment id or unique principal/role/scope match; `--object-type` for object scope | AR-23, AR-50 |
| Logging | Structured request ids only; never bodies or secrets | AR-24 |
| Rate limits | One `Retry-After` retry inside the adapter, capped | AR-25, AR-44 |
| Doctor | Readiness, TLS/credentials, clock skew | AR-26 |
| Completion | Static bash/zsh/fish scripts | AR-27 |
| Tests | Fake HTTPS plus real-server binary E2E | AR-28 |
| Dependencies | Existing pinned workspace libraries only | AR-29 |
| Verification | Full repository gates plus PostgreSQL 16/17 | AR-30 |
| Schema | No migration | AR-31 |
| Artifacts | OpenAPI in the contract package; client in the CLI | AR-32 |
| Init CA | Idempotent, never rotates; recovery guard | AR-33, AR-39 |
| Init password | One-time `0600` file or operator file; policy-checked | AR-34 |
| Init TLS | CA-signed server certificate; chain/SAN/validity checks | AR-35, AR-36 |
| Init DB URL | Environment only; never argv | AR-40 |
| Init migrations | Separate migrator env URL | AR-59 |
| CA public file | Fail closed on mismatch; explicit replace | AR-60 |
| Init signing | `issueServerCertificate`; init never holds the CA scalar | AR-41 |
| Init UID | Init and server share a UID | AR-42 |
| Init org | Name update + policy version bump | AR-43 |
| Runtime errors | CLI wrapper maps runtime errors | AR-44 |
| Probe/export | Explicit bearer headers | AR-45 |
| Scaffold safety | Pre-call path checks; Compose-name validation | AR-46 |
| Certificate key | `--private-key` requires `--out` | AR-47 |
| Secret metadata | PATCH after value write | AR-48 |
| Audit project | Name → ULID | AR-49 |
| Single-command groups | Default command | AR-51 |
| Terminal output | TTY escaping | AR-54 |
| Run manifest | 1 MiB, duplicate keys, cleanup | AR-57 |
| Export safety | Temp+rename, content-type check | AR-58 |
| Credential directory | `0700`, owned, non-symlink | AR-55 |
| Generated lint | Ignore generated artifacts | AR-52 |
| E2E | Real-server binary test under `tests/integration` | AR-53 |
| CA trust | Proxy root CA vs internal CA | AR-56 |
| Specialist | None | AR-37 |

## Specialist Agents

**None** — the capability-gap check ran against this repository's evidence and found no gap a
standing specialist would close.

_Detection evidence: RD-11 adds ordinary TypeScript over existing controllers, `blendsdk/cmdline`,
`blendsdk/api-client`, and `blendsdk/codegen`. The repository's correctness and security/concurrency
review lenses cover credential storage, token refresh, TLS, injection, and contract drift; there is
no repeated CLI-area finding history (RD-10 used the same lenses)._

## Related Files

| File | Change |
|---|---|
| `apps/cli/package.json` | New package, bin `ov`, pinned dependencies |
| `apps/cli/src/{main,cli,config,errors,output,dispatcher}.ts` | Entry, command registry, global options, exit mapping |
| `apps/cli/src/credentials/*.ts` | Path resolution, secure store, lock, hidden password input |
| `apps/cli/src/transport/https-adapter.ts` | `node:https` adapter, CA trust, bounds, download |
| `apps/cli/src/client/*.ts` | Authenticated client, refresh wiring, unauthenticated runtime |
| `apps/cli/src/commands/*.ts` | auth, project, secret, cert, identity, role, access, audit, docker, run, init, backup, kek, doctor, completion |
| `apps/cli/src/run/manifest.ts`, `run/delivery.ts` | CLI run manifest and child lifecycle |
| `apps/cli/src/generated/**` | Generated typed client (marker-bearing) |
| `apps/cli/tests/**` | Unit and fake-HTTPS integration tests |
| `apps/server/scripts/api-contract.ts` | Build the OpenAPI document and generated client; check drift |
| `apps/server/src/init/{index,ca,tls,admin}.ts` | Idempotent bootstrap |
| `apps/server/package.json` | `api:generate` / `api:check`, `./init` export |
| `packages/api-contract/openapi.json` | Generated committed contract |
| `apps/server/tests/integration/cli.spec.test.ts` | Real-server binary E2E |
| `apps/server/tests/integration/init.spec.test.ts` | Bootstrap idempotence, concurrency, and safety |
| `docs/guide/cli.md`, `docs/reference/cli.md` | Implemented behavior |
| `docs/reference/api.md`, `docs/reference/configuration.md` | Contract and init env |
| `docs/architecture/overview.md` | Generated-client location and CLI component |
| `docs/changelog.md`, `.changeset/cli.md` | Release note |
| `package.json`, `pnpm-workspace.yaml` | `api:generate` / `api:check`; `api:check` in verify |
| `deploy/compose/compose.yaml` | `ov init --prepare` contract verified |

# Current State: RD-11 CLI

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The server already exposes every API RD-11 needs. The route registration in
`apps/server/src/app.ts:454-469` mounts:

| Base path | Controller | CLI relevance |
|---|---|---|
| `/v1/auth/cli` | `CliAuthController` | login, refresh, logout, `/me`, session list/revoke |
| `/v1/admin/projects` | `ProjectsController` | project list/create/get/update/delete |
| `/v1/data` | `SecretsController` | project resolution, secret list/create/read/version/update/delete/recover/purge |
| `/v1/data` | `CertificatesController` | certificate list/import/generate/get/private-key/update/delete/recover/purge |
| `/v1/admin/identities` | `IdentityController` | identity list/create/get/revoke/join-token |
| `/v1/admin/assignments` | `AssignmentsController` | assignment list/create/delete |
| `/v1/admin/access-explain` | `AccessExplainController` | effective-access explanation |
| `/v1/audit` | `AuditController` | event query, chain verify, NDJSON export |
| `/v1/admin/scaffold` | `ScaffoldController` | Docker Compose scaffold |
| `/v1/meta` | `MetaController` | auth capabilities and role catalog |
| `/ready` | `ReadyController` | readiness probe |

The contracts live in `packages/api-contract/src/*.ts` and are strict Zod objects. The CLI can
reuse them for input validation and response typing. `CliAuthController` already implements
the RD-04 token model: login shares the browser verifier and limiter, refresh rotates the
family, logout is idempotent, and `/me` plus session list/revoke require a CLI bearer
(`apps/server/src/controllers/cli-auth.ts:73-209`).

RD-10 added the scaffold endpoint and its response contract
(`packages/api-contract/src/scaffold.ts`): project, identity, object-scope assignments, one
join token, a per-service Compose snippet, a manifest skeleton, and a manifest file template.
The token is returned once and is not embedded in the compose or manifest strings.

RD-10 also added `apps/agent`, which proves the manifest grammar, safe file targets, atomic
writes, and child-process wrapper pattern the CLI can follow for `ov run`.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/app.ts` | Route registration | Reuse; add no new product routes |
| `apps/server/src/controllers/cli-auth.ts` | CLI auth routes | Reuse |
| `apps/server/src/controllers/{projects,secrets,certificates,identity,assignments,audit,scaffold,meta,ready}.ts` | Product routes | Reuse; no behavior change |
| `packages/api-contract/src/{cli-auth,projects,secrets,certificates,identities,rbac,audit,scaffold}.ts` | Strict schemas | Reuse; export no new product schemas |
| `apps/server/src/security/keyring.ts` | Keyring load/validate | Reuse in init; add create/write path |
| `apps/server/src/security/ca.ts` | CA wrap/unwrap/sign | Reuse in init; add CA generation and server-cert signing |
| `apps/server/src/security/signing-keys.ts` | JWT signing key lifecycle | Reuse `ensure()` in init |
| `apps/server/src/auth/password.ts` | Argon2id policy | Reuse in init |
| `apps/server/src/db/config.ts`, `apps/server/blendsdk.migrations.ts` | Migration config | Reuse in init |
| `apps/server/scripts/` | Existing `generate-db-types.ts` | Add `api-contract.ts` |
| `apps/cli/` | Does not exist | Create the package |
| `packages/api-contract/openapi.json` | Does not exist | Generate and commit |
| `apps/cli/src/generated/` | Does not exist | Generate and commit |
| `package.json`, `apps/server/package.json` | Scripts | Add `api:generate`, `api:check`, and `api:check` in verify |
| `docs/guide/cli.md`, `docs/reference/cli.md` | Target-state docs | Replace with implemented behavior |
| `docs/architecture/overview.md` | Claims a generated client | Make the claim true and locate the artifacts |
| `deploy/compose/compose.yaml` | `ov init --prepare` target | Verify the init env contract |

### Code Analysis

- The CLI auth login body is `loginRequestSchema` with `identifier` and `password`
  (`packages/api-contract/src/cli-auth.ts:1-25`). The response has separate access and refresh
  expiries and a public user (`:55-65`). The CLI must store both tokens and both expiries.
- The refresh contract is a strict `{ refreshToken }` body (`:73-75`); the server rotates and
  returns a new pair. A failed refresh is `401 invalid_refresh_token`.
- Session list entries expose `id`, `createdAt`, `expiresAt`, and `current` (`:103-112`);
  revoke is `DELETE /v1/auth/cli/sessions/:familyId`.
- `ProjectsController` resolves `:project` as a ULID, not a name
  (`apps/server/src/controllers/projects.ts:71-76`). The CLI must resolve names through the
  list route.
- `SecretsController` resolves `:project` as a project name and `:name` as a secret name
  (`apps/server/src/controllers/secrets.ts:57-70`). Create is `POST`, new version is `PUT`,
  recover and purge are `POST` actions, and the value response is the only body with a value.
- `CertificatesController` resolves `:project` as a name and `:name` as a certificate name.
  Import/generate return `200` for a new version and `201` for a new certificate; the response
  body is the same (`apps/server/src/controllers/certificates.ts:104-148`).
- `IdentityController` accepts a project ULID in the list query and create body
  (`packages/api-contract/src/identities.ts:15-25`). The CLI must resolve the project name.
- The assignment contract accepts `principalId`, `role`, `scopeType`, `scopeId`, and an optional
  `expiresAt` (`packages/api-contract/src/rbac.ts:105-145`). The list route filters by the same
  fields, which supports `ov role revoke` matching.
- The audit export route sets `application/x-ndjson` and streams lines; it is not a JSON
  envelope (`apps/server/src/controllers/audit.ts:77-130`).
- `packages/api-contract/src/ids.ts` imports `@openvault/core` name patterns, so the contract
  package must be built before the contract script runs.
- There is no `blendsdk.api.ts`, no OpenAPI JSON, no generated client, and no `api:check`
  script in the repository. The architecture document currently overstates this.
- There is no `apps/cli`, no `ov` binary, no credential store, and no dispatcher.
- There is no server bootstrap module. `apps/server/src/main.ts` runs migrations, loads the
  keyring, and starts listeners, but never creates a keyring, CA, organization, or admin.
  `deploy/compose/compose.yaml:25-40` already expects `ov init --prepare` to do that.
- `Keyring` can parse and validate a keyring file, but it intentionally never serializes key
  bytes. Init must generate the JSON shape directly and write it `0600`.
- `CaSigner` can load a `ca_keys` row, unwrap the scalar, and issue certificates, but there is
  no CA generation or server-certificate helper in production code. The test fixture
  `apps/server/tests/integration/helpers/agent-tls.ts` is the closest reference and must not be
  imported by product code.

## Gaps Identified

### Gap 1: No CLI binary or dispatch layer

**Current Behavior:** Operators have no `ov` command. Every action requires hand-written HTTP
calls.

**Required Behavior:** A strict dispatcher, global options, group parsers, positional forms, and
`--` passthrough for `ov run`.

**Fix Required:** Add `apps/cli` with the dispatcher over `blendsdk/cmdline`.

### Gap 2: No protected credential store

**Current Behavior:** No token file, no refresh serialization, no logout cleanup.

**Required Behavior:** The full RD-11 credential contract.

**Fix Required:** Add the credential path resolver, secure atomic writer, lock, and hidden
password input.

### Gap 3: No generated API client or drift gate

**Current Behavior:** The architecture claims a generated client; none exists. `pnpm api:check`
is undefined.

**Required Behavior:** A committed OpenAPI document and typed client generated from the real
controllers, with drift detection.

**Fix Required:** Add `apps/server/scripts/api-contract.ts` and the root scripts.

### Gap 4: No command implementations

**Current Behavior:** Auth, project, secret, certificate, identity, role, access, audit,
scaffold, run, doctor, and completion commands do not exist.

**Required Behavior:** Each command in RD-11's table, with safe input and output.

**Fix Required:** Add the command modules and the generated-client wiring.

### Gap 5: No bootstrap command

**Current Behavior:** The reference Compose calls `ov init --prepare`, but nothing creates the
keyring, CA, server certificate, organization, or administrator.

**Required Behavior:** Idempotent bootstrap that never rotates the CA and never prints the
password.

**Fix Required:** Add `apps/server/src/init` and the `ov init` command.

### Gap 6: Documentation is target-state only

**Current Behavior:** `docs/guide/cli.md` says the CLI is not in the repository; the reference
page is marked target.

**Required Behavior:** Documentation matches the implemented commands, credential contract,
generated artifacts, and bootstrap behavior.

**Fix Required:** Update the CLI guide/reference, API/configuration references, architecture,
changelog, and changeset.

## Dependencies

### Internal Dependencies
- RD-04 CLI auth routes and token policy.
- RD-06 action catalog, assignments, and access explanation.
- RD-08 project/secret contracts and routes.
- RD-09 certificate contracts and routes.
- RD-10 scaffold endpoint, manifest grammar, and agent delivery patterns.
- Existing keyring, CA, signing-key, password, and migration modules.

### External Dependencies
- Node.js 24.21.0 (`node:https`, `node:fs`, `node:child_process`, WebCrypto).
- `blendsdk@5.68.1` (`cmdline`, `api-client`, `codegen`).
- `yaml@2.9.1`, `zod@4.6.7`.
- PostgreSQL 16 and 17 for the end-to-end and init tests.
- TypeScript 7.0.2, Vitest 5.0.5, Biome 2.6.4, VitePress 1.6.4.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Credential file written loosely or partially | Low | High | Dedicated store with mode checks, `O_NOFOLLOW`, atomic rename, lock, fail-closed tests (AR-8–AR-10) |
| Refresh race reuses a token and revokes the family | Medium | High | Lock around read-refresh-write; single unauthenticated refresh runtime (AR-9, AR-12) |
| Generated client drifts from routes | Medium | High | Metadata test plus `pnpm api:check` in verify (AR-6, AR-7) |
| Secret value leaks through argv or logs | Low | High | Value only from stdin/file/prompt; captured-argv and captured-log tests (AR-15, AR-24) |
| `ov run` leaves plaintext in a temp directory | Medium | High | `mkdtemp` 0700, 0400/0600 files, cleanup on exit/signal, no shell (AR-17) |
| Scaffold token written into a file | Low | High | Token printed once, never interpolated; file-content test (AR-18) |
| Init rotates the CA or duplicates the admin | Medium | High | Idempotent read-before-create; two-run integration test (AR-33–AR-36) |
| Init password printed or logged | Low | High | One-time file, no stdout value, captured-output test (AR-34) |
| Contract script loads server code with side effects | Low | Medium | Controllers build route definitions only; no DB or network access |
| CLI/server workspace cycle | Medium | Medium | Server does not depend on the CLI; E2E spawns the built binary by path (AR-28) |
| Full verify becomes slow | Medium | Low | `api:check` rebuilds in memory only; no database or network |

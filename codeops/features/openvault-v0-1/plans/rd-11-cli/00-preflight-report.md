# Preflight Report: RD-11 CLI

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Audit target**: all plan documents in `codeops/features/openvault-v0-1/plans/rd-11-cli/`
> **Context**: RD-01, RD-02, RD-04, RD-05, RD-06, RD-08, RD-09, RD-10, RD-11, RD-13, RD-14, the existing controllers/contracts, `blendsdk/cmdline`/`api-client`/`codegen`, and the reference Compose files
> **Iterations**: 2 (three independent review lenses, then a plan revision)
> **Status**: ✅ PREFLIGHT PASSED — every actionable critical/major finding resolved at planning time
> **Post-execution update (2026-11-06)**: the self-authored RD-13 command deferral was rejected by user review of PR #29. `ov backup`, `ov restore`, and `ov kek rotate` were implemented through `apps/server/src/ops` and verified. The deferral references below are superseded; see [05-findings.md](05-findings.md) §Operations Findings.

> **⚠️ SAME-SESSION REVIEW:** The plan and this report were produced in the same session. Independent correctness and security/concurrency reviews run again during execution. This report records the planning-stage preflight only.

## Codebase Context Summary

| Area | Verified fact |
|---|---|
| CLI auth | `CliAuthController` already implements login, refresh, logout, `/me`, session list, and session revoke (`apps/server/src/controllers/cli-auth.ts:73-209`). |
| CLI contracts | `cliLoginRequestSchema`, `cliTokenResponseSchema`, `cliMeResponseSchema`, and session schemas are strict Zod objects (`packages/api-contract/src/cli-auth.ts`). |
| Projects | `ProjectsController` resolves `:project` as a ULID, so the CLI must resolve names (`apps/server/src/controllers/projects.ts:71-76`). |
| Secrets | `SecretsController` resolves project/secret names; create is POST, value update is PUT, recover/purge are POST (`apps/server/src/controllers/secrets.ts:144-329`). |
| Certificates | Import/generate return 200 for a new version and 201 for a new certificate; the body is the same (`apps/server/src/controllers/certificates.ts:104-148`). |
| Audit export | The route streams `application/x-ndjson`, not a JSON envelope (`apps/server/src/controllers/audit.ts:77-130`). |
| Scaffold | RD-10's route returns a one-time token and per-service Compose/manifest strings; the token is not embedded (`packages/api-contract/src/scaffold.ts`, `apps/server/src/scaffold/service.ts`). |
| Contract tooling | `blendsdk/codegen` provides `OpenAPIGenerator`, `generateClient`, `checkClient`, and `formatOpenApiDocument`; no contract exists in the repository today. |
| Command parser | `blendsdk/cmdline` has no nested execution or `--` passthrough; `execute(context, { argv, write })` is the invocation API. |
| API client | `blendsdk/api-client` provides `BearerAuth`, `RequestAdapter`, `ApiError`, and `ApiTransportError`; the adapter response has no headers. |
| Credential keys | `KeyringProvider.load` checks regular file and `0600` but not `O_NOFOLLOW` or owner; init must add those checks (AR-33/AR-55). |
| Bootstrap state | The schema has `org`, `principals`, `local_credentials`, `role_assignments`, `ca_keys`, and `signing_keys`; no migration is needed. |
| Reference stack | `deploy/compose/compose.yaml` runs `ov init --prepare` with shared keyring/TLS volumes; Caddy serves `https://localhost` with `tls internal` (AR-56). |

## Design Challenger Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| DC-01 | Critical | Two init runs can overwrite the keyring after the CA row is wrapped, leaving it undecryptable. | Added an init lock, `O_EXCL` keyring creation, `EEXIST` re-read, CA unique-violation re-read, and a concurrent-init test (AR-39, ST-110a). |
| DC-02 | Critical | `must_change=true` blocks every CLI data command, and RD-12 is not available. | The v0.1 bootstrap credential is created with `must_change=false`; the generated password is strong random material in a one-time `0600` file (AR-34). Revisit when a CLI password-change route or RD-12 lands. |
| DC-03 | Critical | Phase 1's green gate included command-specific dispatcher tests that are implemented later. | Split the spec: Phase 1 covers global extraction, help, exit, single-command, and `--` mechanics; command positionals and destructive prompts belong to Phases 2–4 (99). |
| DC-04 | Critical | Scaffold rotated the token before checking output files; a refused overwrite invalidated the old token. | Output paths are validated and checked before the API call; a refused overwrite exits 1 without a server call (AR-46, ST-101a). |
| DC-05 | Critical | Credential locking did not cover login/logout, and `remove()` could unlink a lock it did not own. | Lock login/save/logout/refresh; owner token in the lock; stale only when dead PID **and** age >60s; logout holds the lock and best-effort removes on read failure (AR-9, ST-14a/14b). |
| DC-06 | Critical | One idempotency key across PUT and POST conflicts on the create-after-404 path. | Use separate keys per method/path; correct the 409 retry to the POST conflict path (AR-16, ST-71). |
| DC-07 | Major | Init can create a new keyring when the old one is missing but wrapped rows exist. | Recovery guard fails closed and names restore-from-backup (AR-33, ST-110b). |
| DC-08 | Major | Init TLS reuse checks only key match; expired/mismatched material can pass. | Verify chain, SANs, EKU, dates, and key mode; regenerate an expired leaf from the same CA; fail closed on mismatch (AR-35, ST-110c/110d). |
| DC-09 | Major | Init inserts the org admin without bumping policy state. | The admin transaction bumps `policy_state.version`; org name updates with `--org` (AR-43, ST-110g). |
| DC-10 | Major | Init uses one database URL, conflicting with RD-13's migrator/app roles. | Read `OPENVAULT_MIGRATION_DB_URL` for DDL and `OPENVAULT_DB_URL` for data; both env-only (AR-59). |
| DC-11 | Major | Init file ownership is unspecified; RD-13 non-root containers can lose access. | Init and server share a UID/GID; the server fails closed if files are unreadable (AR-42, ST-131). |
| DC-12 | Major | Init tests were placed in the unit-test tree, which excludes integration tests. | DB-backed init tests live in `apps/server/tests/integration/init.spec.test.ts` and `init.impl.test.ts` (AR-53, 99). |
| DC-13 | Major | Init would unwrap the CA scalar outside `CaSigner`, violating RD-05. | Added a bootstrap-only `issueServerCertificate` in `security/ca.ts`; init never holds the scalar (AR-41, ST-130). |
| DC-14 | Major | The quick start pins the OpenVault internal CA for `https://localhost`, but Caddy uses its own root. | Document and publish the proxy root CA separately from the internal CA (AR-56, ST-138). |
| DC-15 | Major | Single-command groups cannot be dispatched without a second token. | Register the sole command with `default: true` or inject the token; one test per group (AR-51, ST-23a). |
| DC-16 | Major | `cmdline.execute` signature was wrong. | Corrected to `execute(context, { argv, write })` (03-01). |
| DC-17 | Major | Generated files use single quotes and fail Biome. | Biome ignores `apps/cli/src/generated/**` and `openapi.json`; `api:check` owns them (AR-52, ST-136). |
| DC-18 | Major | The contract table is the schema source; `api:check` cannot see a controller schema change. | Disclosed the limitation; representative E2E commands parse real responses and catch schema drift at the command boundary (03-02). |
| DC-19 | Major | RD-11's three RD-13-backed commands are not executed. | Superseded: the commands were implemented in the post-execution operations slice (AR-2, 05-findings §Operations Findings). |
| DC-20 | Major | `ov access explain` used value/private routes, requiring `secret.read`. | Resolve names through `listSecrets`/`listCertificates` only (AR-21, ST-94). |
| DC-21 | Major | `role grant --object` has no object type; names can collide. | Require `--object-type secret|certificate` (AR-50, ST-90). |
| DC-22 | Major | `audit list --project` passed a name to a ULID field. | Resolve names or use `--project-id` (AR-49, ST-97). |
| DC-23 | Major | `cert get --private-key` printed the key to stdout. | Requires `--out`; the key is never printed or in JSON (AR-47, ST-82a). |
| DC-24 | Major | `secret set --tag/--content-type` silently did nothing on update. | PATCH metadata after the value write; report the non-atomic failure (AR-48, ST-71a). |
| DC-25 | Major | Scaffold `--compose-project` was interpolated into paths without validation. | Strict Compose-name schema, containment, symlink rejection (AR-46, ST-101b). |
| DC-26 | Major | `auth sessions --revoke` had no confirmation. | Requires `--yes` or an interactive prompt; non-interactive without `--yes` exits 2 (AR-14, ST-128). |
| DC-27 | Major | `probe`/`download` had no auth path. | Explicit `headers` parameter plus `authHeaders()`; the adapter never stores a token (AR-45, ST-53b). |
| DC-28 | Major | Credential and TLS errors are wrapped in `ApiTransportError`. | Preflight credentials and wrap every call in a CLI mapper; sentinel refresh error maps to exit 3 (AR-44, ST-53a). |
| DC-29 | Major | 429 `Retry-After` cannot be read from `ApiError`. | Perform the single retry inside the adapter, where headers are available (AR-25, AR-44, ST-50). |
| DC-30 | Major | `ov init` generated a password after the admin insert; a write failure locked the admin out. | Write the password file before the insert; remove it on failure; skip generation when the admin exists (AR-34, ST-110f). |
| DC-31 | Major | Operator passwords bypassed the 12–1024 policy. | Call `validateNewPassword` (AR-34, ST-110e). |
| DC-32 | Minor | `checkClient` does not prune stale files. | Corrected: `generateClient` prunes; `checkClient` reports drift (03-02). |
| DC-33 | Minor | The plan index linked to missing preflight/findings files. | This report and `05-findings.md` now exist. |
| DC-34 | Minor | `ov run` had no manifest size bound or duplicate-key rule. | 1 MiB bound, `uniqueKeys`, 100-entry cap, cleanup on all paths (AR-57, ST-132/134). |
| DC-35 | Minor | The run env denylist missed several loader/trust variables. | Added `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `SSL_*`, `PYTHON*`, `GCONV_PATH`, `GIT_CONFIG_*` (AR-57, ST-133). |
| DC-36 | Minor | Audit export could write a 403 JSON body to the target. | Check 2xx + `application/x-ndjson`; temp file + rename; preserve the old export (AR-58, ST-140). |
| DC-37 | Minor | `ov run` had a second manifest grammar. | Accepted: the CLI profile has no service/refresh/output root; the bounds follow the agent grammar (AR-57). |
| DC-38 | Minor | `ov run` key buffers were not explicitly zeroed. | Added a zeroization checklist for init and run key material (03-03). |
| DC-39 | Minor | TTY tables could emit control sequences from names. | TTY escaping for table cells; raw only for the explicit value surface (AR-54, ST-141). |
| DC-40 | Minor | Response-header access was missing for verbose request ids. | The adapter exposes headers in `probe`; verbose logs use the known request id from the error/response. |

## Correctness Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| CR-01 | Major | Init keyring/CA ordering and concurrency. | Init lock, `O_EXCL`, re-read, unique-violation handling, concurrent test (AR-39). |
| CR-02 | Major | Keyring owner/symlink checks were overclaimed. | Add `O_NOFOLLOW`, `fstat` owner, parent directory checks (AR-33/AR-55). |
| CR-03 | Major | TLS reuse checks were incomplete. | Chain/SAN/EKU/validity/key-mode checks; expired leaf regeneration (AR-35). |
| CR-04 | Major | Password file order and rerun behavior. | Password only when the admin is created; write before insert; remove on failure (AR-34). |
| CR-05 | Major | Access explain least privilege. | List metadata, never value/private routes (AR-21). |
| CR-06 | Major | Role revoke with `--assignment` still required positionals. | Positionals optional with `--assignment`; list and delete by id (AR-23). |
| CR-07 | Major | Secret metadata options were not applied on update. | PATCH after value write (AR-48). |
| CR-08 | Major | Scaffold path traversal. | Compose-name schema + containment (AR-46). |
| CR-09 | Major | Caddy CA vs internal CA. | Separate trust files documented (AR-56). |
| CR-10 | Major | Single-command groups. | Default command or injected token (AR-51). |
| CR-11 | Major | `cmdline.execute` call shape. | Corrected signature (03-01). |
| CR-12 | Major | Generated files fail Biome. | Ignore generated artifacts (AR-52). |
| CR-13 | Major | Phase 1 test scope. | Split spec by owning phase (99). |
| CR-14 | Major | Missing E2E/init test tasks and wrong paths. | Added tasks and moved DB tests to `tests/integration/` (AR-53, 99). |
| CR-15 | Major | Missing preflight/findings artifacts. | Created both. |
| CR-16 | Major | RD-13 acceptance gap. | Superseded: backup/restore/KEK rotate implemented and tested (AR-2, 05-findings). |
| CR-17 | Minor | `--org` was silently ignored. | Update the org name and bump policy version (AR-43). |
| CR-18 | Minor | Password policy bypass. | `validateNewPassword` (AR-34). |
| CR-19 | Minor | Audit export content type. | Stream-only contract + adapter check (AR-58). |
| CR-20 | Minor | `checkClient` prune wording. | Corrected (03-02). |
| CR-21 | Minor | `packages/api-contract/tests/openapi` would import server code. | The contract test lives in `apps/server/tests/` (AR-53). |

## Security and Concurrency Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| SC-01 | Critical | Missing keyring with wrapped rows creates a new KEK. | Recovery guard fails closed (AR-33). |
| SC-02 | Critical | Concurrent init can interleave keyring/CA/TLS writes. | Init lock and re-read (AR-39). |
| SC-03 | Major | Stale-lock TOCTOU and logout/refresh race. | Owner token, dead-PID+age stale rule, lock in logout, best-effort removal (AR-9). |
| SC-04 | Major | Keyring path trust. | `O_NOFOLLOW`, owner, parent directory checks (AR-33/AR-55). |
| SC-05 | Major | Credential directory mode. | `0700`, owner, non-symlink on every read/write (AR-55). |
| SC-06 | Major | Database URL in argv. | Environment-only (AR-40). |
| SC-07 | Major | Migration URL ambiguity. | Separate migrator env URL (AR-59). |
| SC-08 | Major | Access explain reads values. | List metadata only (AR-21). |
| SC-09 | Major | Session revoke had no confirmation. | `--yes` or prompt (AR-14). |
| SC-10 | Major | Secret/cert `--out` overwrite. | `wx`/`--force`, symlink rejection, temp+rename (AR-15/AR-47). |
| SC-11 | Major | Scaffold path traversal. | Compose-name schema + containment (AR-46). |
| SC-12 | Major | Runtime errors lose CLI codes. | CLI mapper and sentinel refresh error (AR-44). |
| SC-13 | Major | 429 header unavailable. | Adapter-owned retry (AR-25/AR-44). |
| SC-14 | Major | Probe/download auth. | Explicit headers (AR-45). |
| SC-15 | Major | Password policy bypass. | `validateNewPassword` (AR-34). |
| SC-16 | Major | Password file overwrite/order. | Create only with the admin; write before insert (AR-34). |
| SC-17 | Major | TLS chain/SAN/validity. | Full validation and leaf regeneration (AR-35). |
| SC-18 | Major | Object type ambiguity. | `--object-type` (AR-50). |
| SC-19 | Major | Caddy/internal CA confusion. | Separate trust files (AR-56). |
| SC-20 | Minor | Run denylist gaps. | Expanded list (AR-57). |
| SC-21 | Minor | Run manifest bounds/cleanup. | 1 MiB, unique keys, `finally` cleanup (AR-57). |
| SC-22 | Minor | Export 403 body. | Content-type check + temp+rename (AR-58). |
| SC-23 | Minor | Audit filter mapping. | `--project-id`/ULID resolution (AR-49). |
| SC-24 | Minor | Private-key stdout. | `--out` required (AR-47). |
| SC-25 | Minor | Group help dispatch. | Pass `--help` to the group parser (03-01). |
| SC-26 | Minor | FD secret input. | `/dev/fd/N` supported (AR-15). |
| SC-27 | Minor | Key zeroization. | `finally` zeroing (03-03). |
| SC-28 | Minor | Idempotency header wiring. | `{ headers: { "Idempotency-Key": key } }` (AR-16). |
| SC-29 | Minor | Public CA file mismatch. | Fail closed; explicit `--replace-ca-public` (AR-60). |
| SC-30 | Minor | Terminal escape injection. | TTY escaping (AR-54). |
| SC-31 | Minor | Security test coverage. | Added ST-128–ST-141 and adversarial init/lock/export cases (07). |

## Accepted Residuals

These are recorded in `docs/security/limitations.md` during Phase 5:

1. **Native Windows credential store.** The CLI fails closed on native Windows because Node cannot
   enforce an owner-only ACL; WSL uses the POSIX path (AR-10).
2. **RD-13-backed commands.** Superseded after user review: `ov backup`, `ov restore`, and
   `ov kek rotate` are implemented through `apps/server/src/ops`; the remaining RD-13 program
   (secret/certificate rotation workflows, Compose hardening, role provisioning) is deferred.
3. **Bootstrap credential rotation.** The v0.1 generated password is not force-changed because the
   CLI has no password-change route and RD-12 is not available; the one-time file must be removed
   after first use (AR-34).
4. **Contract schema source.** `api:check` detects route and artifact drift; a controller schema
   change that leaves the table untouched is caught by the representative command E2E tests, not
   by `api:check` alone (AR-6, 03-02).
5. **Single-node scaffold serialization.** The server-side per-identity mutex from RD-10 remains
   in-process; multi-instance deployments need a database lock (RD-10 residual).
6. **Proxy/internal CA separation.** Operators must publish and use two CA files correctly; a
   wrong file causes a clear TLS verification failure (AR-56).
7. **Second run manifest grammar.** `ov run` uses a CLI profile rather than the agent manifest
   verbatim; both share the entry grammar and safety bounds (AR-57).

## Plan Readiness Proof

| Check | Result |
|---|---|
| Required plan documents exist | ✅ `00`, `01`, `02`, `03-01`, `03-02`, `03-03`, `07`, `99` |
| `00-index.md` declares the implemented RD | ✅ `> **Implements**: openvault-v0-1/RD-11` |
| Ambiguity register has no open material item | ✅ 60/60 resolved |
| Specification tests precede implementation | ✅ Every phase has spec tests, a red task, implementation, green task, impl tests, and a gate |
| Critical/major preflight findings resolved | ✅ All actionable findings resolved or explicitly accepted |
| Task counts consistent | ✅ 92 tasks: 22/12/15/25/18 |
| Verification command confirmed | ✅ `pnpm verify` (including `api:check`), `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, docs build, PostgreSQL 16/17 integration |

## Verdict

**PASS for execution.** The plan is grounded in the existing controllers, contracts, and
`blendsdk` APIs. The bootstrap design now serializes keyring/CA/TLS writes, fails closed on a
missing keyring with wrapped state, never exposes the CA scalar, validates TLS material, and
handles the password lifecycle safely. The CLI runtime preflights credentials, maps runtime
errors, retries 429 in the adapter, and keeps tokens out of argv, logs, and generated files.
The three RD-13-backed commands were initially a named deferral; user review rejected that
narrowing, and the post-execution operations slice implemented them.

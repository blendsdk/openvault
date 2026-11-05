# Findings Ledger: RD-11 CLI

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Closed — no open critical or major finding
> **Last Updated**: 2026-11-05 18:10
> **CodeOps Artifact Schema**: 1

## Purpose

This ledger records the post-execution correctness and security/concurrency reviews, their
rulings, and the accepted residuals. Planning-stage findings are in
[00-preflight-report.md](00-preflight-report.md).

## Review Method

Two independent reviewers examined the uncommitted implementation: one for correctness against
the plan, controllers, contracts, and tests; one for security, credentials, TLS, child
delivery, and bootstrap concurrency. Both reviewers re-checked their findings after the fixes.
The executing agent ran the full verification and both PostgreSQL suites.

## Correctness Findings

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| F-01 | Major | Global `--org`/`--project` consumed command-local options | `audit` falls back to `context.globals.project`; `init` uses `globals.org` | Resolved |
| F-02 | Major | JSON/usage errors leaked parser help to stdout; unknown top-level options exited 0 | Parser output is buffered; failures go to stderr; unknown group/option exits 2 with a JSON envelope in `--json` | Resolved |
| F-03 | Major | Wrapped refresh/TLS failures lost their stable codes | `asCliError` recognizes wrapped `RefreshRejectedError`, TLS messages, timeouts, size, and file-exists causes | Resolved |
| F-04 | Major | `InitError`/`KeyringError` collapsed to `internal_error` | Bootstrap errors preserve their code; `init_configuration` exits 2 | Resolved |
| F-05 | Major | Audit export did not refresh on 401 and lost status codes | Export has refresh-on-401, one 429 retry, server-envelope mapping, temp+rename, and failure preservation | Resolved |
| F-06 | Major | `ov run` lacked SIGKILL escalation and cleanup on a second signal | Persistent handlers, 5-second SIGKILL timer, `finally` cleanup | Resolved |
| F-07 | Major | `readVisibleLine` hung on closed stdin | End/close handling returns a validation error; no hang | Resolved |
| F-08 | Major | `checkContract` ignored error-level issues | `hasErrors` included; `api:check` exits 1 on errors or drift | Resolved |
| F-09 | Major | Init password paths could chmod arbitrary directories | Password input/output must be absolute; existing directories are never chmodded and group/world-writable directories fail closed | Resolved |
| F-10 | Major | Stale-lock takeover could remove a live lock | Replaced rename takeover with a serialized `credentials.lock.reclaim` guard; the lock is re-read and removed only while guarded | Resolved |
| F-11 | Major | Init file-lock timeout too short for migrations/Argon2 | Raised to 60 seconds; migrations and data writes run under the file and advisory locks | Resolved |
| F-12 | Major | Broken `audit verify --json` emitted a success envelope | Failure emits only the error envelope on stderr and exits 1 | Resolved |
| F-13 | Minor | Usage preconditions ran after credential loading | Project and `--private-key --out` checks run before client creation | Resolved |
| F-14 | Minor | `--verbose` emitted nothing | HTTPS adapter emits value-free `{event, method, path, status, requestId?, durationMs}` events | Resolved |
| F-15 | Minor | Unquoted YAML `mode: 0400` was rejected | Numeric 400/440/600/640 digits are interpreted as octal; quoted and `0o` forms still work | Resolved |
| F-16 | Minor | Recovery-guard test depended on earlier tests | Uses an isolated database and removes the keyring after a successful init | Resolved |
| F-17 | Minor | Keyring directory rule was undocumented/inconsistent | Provider/init reject group/world-writable parents; docs updated | Resolved |
| F-18 | Minor | Install guide claimed forced password change | Docs state the v0.1 bootstrap credential is not force-changed | Resolved |
| F-19 | Minor | Duplicate tags were accepted | `parseTags` rejects duplicate keys | Resolved |
| F-20 | Minor | Table cells could inject terminal controls | All table cells escape C0/C1 controls; raw values remain only on explicit value surfaces | Resolved |
| F-21 | Minor | Secret file input was unbounded | Reads through an fd with a hard 65,536-byte bound | Resolved |
| F-22 | Minor | Stream write errors could escape the export promise | Writes are checked and wrapped; errors reject and remove the temp file | Resolved |
| N-01 | Major (new) | FIFO password file could block `open` | Reads use `O_NONBLOCK`; a FIFO fails `fstat` as a non-regular file | Resolved |

## Security and Concurrency Findings

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| CLI-01 | Major | Audit `--project` filter was ignored | Falls back to the global project context and resolves to a ULID | Resolved |
| CLI-02 | Major | Broken audit verify JSON emitted two documents | Only the failure envelope is written | Resolved |
| CLI-03 | Major | Logout removed credentials outside the lock | A lock timeout fails without deleting; normal logout removes under the lock | Resolved |
| CLI-04 | Major | Logout could not clean a loose config directory | `forceRemove` unlinks a regular, non-symlink credential file without requiring the directory mode | Resolved |
| CLI-05 | Major | Stale-lock takeover could move a live lock | Reclaim guard serializes cleanup; live locks are never renamed or unlinked | Resolved |
| CLI-06 | Major | `ov run` could leave a temp directory on a second signal | Persistent handlers, SIGKILL escalation, cleanup in `finally` | Resolved |
| CLI-07 | Major | Wrapped refresh/TLS errors mapped incorrectly | Name/message mapping covers wrapped and raw transport failures | Resolved |
| CLI-08 | Major | Token and base URL could belong to different servers | Client pins the origin, rejects a changed origin, and refresh uses the pinned URL | Resolved |
| CLI-09 | Minor | Secret file/fd reads were unbounded | Bounded fd read with close in `finally` | Resolved |
| CLI-10 | Minor | Empty password could throw outside the promise | Password callbacks reject instead of throwing | Resolved |
| CLI-11 | Minor | `--verbose` was documentation-only | Wired through the transport with no token/body output | Resolved |
| CLI-12 | Major | Planned implementation/security coverage was thin | Added `credentials.impl`, `errors.spec`, `run-manifest.spec`, transport edges, init failure/concurrency cases, and real multi-process lock tests (82 CLI tests, 9 init tests) | Resolved — consolidated by concern |
| CRED-01 | Minor | Invalid `createdAt` or a failed lock write could leave an unrecoverable lock | Non-finite timestamps use file mtime; lock creation failures remove the file | Resolved |
| INIT-01 | Major | Init could chmod arbitrary directories | Absolute password paths; no chmod of existing directories; group/world-writable parents fail closed | Resolved |
| INIT-02 | Major | Password/TLS read TOCTOU | `O_NOFOLLOW` + `fstat` on the open fd; bounded reads; FIFO-safe `O_NONBLOCK` | Resolved |
| INIT-03 | Minor | Keyring creation could overwrite and TLS was not re-verified | Keyring uses `O_EXCL` temp + hard-link publish with `EEXIST` re-read; TLS pair is re-read and validated | Resolved |
| INIT-04 | Minor | TLS temp file chmod after rename could follow a symlink | `fchmodSync` on the temp descriptor before rename | Resolved |
| NET-01 | Minor | Stream write failure could escape the promise | Writes are checked and wrapped; errors reject and clean the temp file | Resolved |
| NEW-02 | Minor | `--replace-ca-public` could not repair a wrong-mode CA file | Replace skips the read when explicitly requested; symlinks/directories still fail | Resolved |
| NEW-03 | Minor | Keyring was written in place, so a crash could leave a partial file | Temp file + `fsync` + hard-link publication; final path is complete or absent | Resolved |

## Accepted Residuals

| ID | Residual | Reason | Documentation |
|---|---|---|---|
| RR-01 | Native Windows credential store fails closed | Node cannot enforce an owner-only ACL without an untested external command | `docs/security/limitations.md` |
| RR-02 | Backup/restore/KEK rotate are gated on RD-13 | Their archive, restore, and rewrap operations are owned by RD-13 | `docs/guide/cli.md`, roadmap |
| RR-03 | Bootstrap password is not force-changed | No CLI password-change route and no web UI yet; one-time `0600` file must be deleted | `docs/security/limitations.md`, install guide |
| RR-04 | `api:check` does not detect a controller schema change alone | The metadata table is the schema source; representative E2E commands catch drift | `docs/architecture/overview.md`, API reference |
| RR-05 | Scaffold serialization is in-process | RD-10 single-node decision | RD-10 ledger |
| RR-06 | Proxy and internal CA files must stay distinct | Caddy uses its own root CA for the public endpoint | `docs/guide/cli.md` |
| RR-07 | `ov run` uses a CLI-specific manifest | Avoids a service identity and join token; entry grammar and bounds match the agent | `docs/guide/cli.md` |
| RR-08 | A crashed reclaim guard needs manual cleanup | The error names `credentials.lock.reclaim`; this is safer than moving a possibly live lock | CLI reference / this ledger |
| RR-09 | Init file lock is local; cross-host serialization relies on the database advisory lock | The reference deployment is single-host; the advisory lock covers shared databases | Init module |

## Verification Evidence

| Gate | Result | Date |
|---|---|---|
| Planning preflight | Passed after revision | 2026-11-05 |
| `pnpm verify` (build, typecheck, api:check, lint, unit, artifacts, react, docs) | Passed | 2026-11-05 |
| `pnpm api:check` | `CLEAN` | 2026-11-05 |
| `pnpm db:migrate` + `pnpm db:types:check` | Passed | 2026-11-05 |
| `pnpm changeset status` | Passed; five packages to bump | 2026-11-05 |
| `pnpm audit:prod` | No known vulnerabilities | 2026-11-05 |
| Docs build | Passed | 2026-11-05 |
| Integration, PostgreSQL 16 | 688/688 tests | 2026-11-05 |
| Integration, PostgreSQL 17 | 688/688 tests | 2026-11-05 |
| CLI unit tests | 82/82 tests | 2026-11-05 |
| Init integration tests | 9/9 tests | 2026-11-05 |
| Correctness review | No open critical/major finding | 2026-11-05 |
| Security/concurrency review | No open critical/major finding | 2026-11-05 |

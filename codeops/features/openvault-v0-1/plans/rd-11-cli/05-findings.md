# Findings Ledger: RD-11 CLI

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Closed — no open critical or major finding
> **Last Updated**: 2026-11-06 10:00
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

## Operations Findings

The user review of PR #29 rejected the self-authored backup/restore/KEK deferral. The three
operations were implemented and reviewed again. The table records the defects found while
making the operations safe.

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| OPS-01 | Major | Version immutability triggers rejected KEK rewrap updates | Rotation disables the key-table triggers for the transaction as a table-owning role; rollback restores them | Resolved |
| OPS-02 | Major | Append-only triggers rejected restore `TRUNCATE` | Restore disables all triggers before truncation, restores rows, then re-enables them in the same transaction | Resolved |
| OPS-03 | Major | Migration seed rows made a fresh target look non-empty | `org` and `policy_state` are seed tables and do not count as user data; they are still replaced by the dump | Resolved |
| OPS-04 | Major | JSONB arrays were sent as PostgreSQL array literals | JSON array values are serialized as JSON text before parameter binding | Resolved |
| OPS-05 | Major | Restore/rotation as the app role cannot own or unlock tables | Both commands fail with `restore_requires_owner`/`kek_rotation_requires_owner`; docs require the owner/migrator URL | Resolved |
| OPS-06 | Major | A running server can write an old-`kek_id` row after rotation verification | Documented maintenance window: stop the server before rotation. The CLI removes the old key only after its own zero-row check | Accepted residual (documented) |
| OPS-07 | Minor | The archive uses a logical JSON dump, not `pg_dump` custom format | Accepted for v0.1 to avoid a host `pg_dump` dependency; age encryption and checksums remain | Accepted residual (documented) |
| OPS-08 | Minor | Restore does not verify a pre-backup agent certificate because the certificate PEM is not stored | The CA key probe and `workload_certs` metadata remain; the full agent-certificate drill belongs to RD-13/RD-14 | Accepted residual (documented) |

| OPS-09 | Major | Backup read every table in autocommit and re-read the keyring after the dump | One repeatable-read snapshot; keyring bytes are read once and compared after the dump; the archive, audit event, and manifest use the same bytes | Resolved |
| OPS-10 | Major | `DISABLE TRIGGER ALL` required superuser | Restore and rotation use `DISABLE TRIGGER USER`; restore inserts in FK-safe order with cyclic current-version columns inserted NULL and updated after versions; a non-superuser owner integration test passes | Resolved |
| OPS-11 | Critical | Restore could delete data in target tables absent from the archive without `--force` | The non-empty preflight enumerates every target data table; absent tables with rows are refused unless `--force`; forced restore truncates all target tables | Resolved |
| OPS-12 | Major | The archive keyring was syntax-checked but not used before the destructive restore | Preflight unwraps the current CA scalar, an audit key, and one current secret with the archive keyring before any target change | Resolved |
| OPS-13 | Major | Restore and delete could target different databases | `OPENVAULT_RESTORE_DB_URL` and `OPENVAULT_DB_URL` must resolve to the same host/port/database; both are validated before any change | Resolved |
| OPS-14 | Major | Database committed before keyring/CA files were written; rollback could leave an incompatible old keyring | Keyring/CA are staged in their target directories before restore and published only after commit; migration/restore failures remove the staging files | Resolved |
| OPS-15 | Major | Secret verification used a global `LIMIT 100` | `DISTINCT ON (p.id)` verifies one current secret for every project | Resolved |
| OPS-16 | Major | Row-column consistency checked only by key count | Every row must have the same sorted column set; empty-object rows are rejected | Resolved |
| OPS-17 | Major | Concurrent rotations could choose the same new ID or lose a key | Rotation holds a keyring-directory lock; the new ID is chosen from the union of keyring and database IDs; a missing referenced KEK fails before change; the zero-old-key check covers every key table | Resolved |
| OPS-18 | Major | CLI collapsed every operations failure to `internal_error` or a TLS/file code | `asCliError` preserves `OpsError` codes and exit codes; tests cover checksum mismatch and configuration errors | Resolved |
| OPS-19 | Minor | Short writes and missing directory fsync | Atomic writer loops until every byte is written and fsyncs the parent directory after rename | Resolved |
| OPS-20 | Minor | Restore did not publish the proxy CA directory | `OPENVAULT_CA_PUBLIC_DIR`/`--ca-public-dir` is staged and published with the internal CA; docs require TLS re-provisioning if the CA changed | Resolved |

| OPS-21 | Major | Service principals failed restore because `owner_project_id` was treated as a deferred cyclic column | `principals` is inserted after `projects` with `owner_project_id` intact; consumers and join tokens follow. A restore fixture with a service principal, consumer, and join token passes | Resolved |
| OPS-22 | Major | Triggers were re-enabled and sequences repaired after commit, so a crash could leave protections off or sequences at 1 | Trigger enable and transactional `ALTER SEQUENCE ... RESTART WITH` now run inside the restore transaction before `COMMIT`; a trigger-state assertion passes | Resolved |
| OPS-23 | Major | Rotation still used `DISABLE TRIGGER ALL`, so a non-superuser owner could not rotate | Rotation uses `DISABLE TRIGGER USER`; the non-superuser owner test restores and rotates successfully | Resolved |
| OPS-24 | Minor | A refused non-empty restore left staged keyring/CA files | The non-empty preflight runs before staging; the refusal test asserts no `.keyring.restore-*` files remain | Resolved |

## Accepted Residuals

| ID | Residual | Reason | Documentation |
|---|---|---|---|
| RR-01 | Native Windows credential store fails closed | Node cannot enforce an owner-only ACL without an untested external command | `docs/security/limitations.md` |
| RR-02 | The remaining RD-13 program is deferred | Secret/certificate rotation workflows, Compose hardening, role provisioning, and release engineering remain RD-13 work | `docs/guide/cli.md`, roadmap |
| RR-03 | Bootstrap password is not force-changed | No CLI password-change route and no web UI yet; one-time `0600` file must be deleted | `docs/security/limitations.md`, install guide |
| RR-04 | `api:check` does not detect a controller schema change alone | The metadata table is the schema source; representative E2E commands catch drift | `docs/architecture/overview.md`, API reference |
| RR-05 | Scaffold serialization is in-process | RD-10 single-node decision | RD-10 ledger |
| RR-06 | Proxy and internal CA files must stay distinct | Caddy uses its own root CA for the public endpoint | `docs/guide/cli.md` |
| RR-07 | `ov run` uses a CLI-specific manifest | Avoids a service identity and join token; entry grammar and bounds match the agent | `docs/guide/cli.md` |
| RR-08 | A crashed reclaim guard needs manual cleanup | The error names `credentials.lock.reclaim`; this is safer than moving a possibly live lock | CLI reference / this ledger |
| RR-09 | Init file lock is local; cross-host serialization relies on the database advisory lock | The reference deployment is single-host; the advisory lock covers shared databases | Init module |
| RR-10 | Restore verifies the audit chain after the database commit | The archive keyring/CA/secret preflight runs before the target change; a post-commit chain failure leaves restored rows for inspection and reports failure | `docs/security/limitations.md` |
| RR-11 | Restore non-empty preflight is not serialized against a live writer | Restore is documented as a maintenance-window operation with the server stopped; a live writer could race the count/truncate boundary | `docs/security/limitations.md`, backup/restore guide |
| RR-12 | Some restore failure paths cannot audit because no usable restored writer exists | Verification failures audit through the restored database; migration/restore/publish failures are reported to the operator without mutating an empty target solely to write an event | Findings ledger |

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
| Integration, PostgreSQL 16 | 693/693 tests | 2026-11-06 |
| Integration, PostgreSQL 17 | 693/693 tests | 2026-11-06 |
| CLI unit tests | 84/84 tests | 2026-11-06 |
| Init integration tests | 9/9 tests | 2026-11-06 |
| Operations integration tests | 5/5 tests | 2026-11-06 |
| Correctness review | No open critical/major finding | 2026-11-05 |
| Security/concurrency review | No open critical/major finding | 2026-11-05 |

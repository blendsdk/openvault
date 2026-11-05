# Requirements: RD-11 CLI

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-11](../../requirements/RD-11-cli.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan
- New `apps/cli` package with the `ov` binary and the complete command surface in RD-11.
- A strict dispatcher over `blendsdk/cmdline` with global options, positional aliases, and
  `--` passthrough for `ov run`.
- A generated API client and OpenAPI document derived from the real controllers, plus
  `pnpm api:check` as a drift gate.
- The RD-11 credential file contract: path precedence, `0700` directory, `0600` file, atomic
  replacement, symlink rejection, lock-based concurrency, and `ov logout` cleanup.
- Login, refresh-on-401, logout, `whoami`, and CLI session list/revoke.
- Project, secret, certificate, identity, role, access-explain, and audit commands.
- `ov docker scaffold` against RD-10's endpoint, writing a Compose snippet and a manifest
  without the token and printing the token once.
- `ov run --` with a strict CLI manifest, private temporary delivery, env/file injection, and
  clean child lifecycle.
- `ov backup`, `ov restore`, and `ov kek rotate` backed by `apps/server/src/ops`: an
  age-encrypted logical backup, a checksum-verified restore, and a KEK rewrap that preserves
  value ciphertext.
- `ov init` implemented as the shared RD-11/RD-13 bootstrap primitive.
- `ov doctor`, static shell completion, JSON/human output, exit codes, and redacted verbose logs.
- Tests: credential/dispatcher/command unit tests with a real HTTPS fake vault; real-server
  binary end-to-end tests; bootstrap integration tests.
- Documentation, deployment example verification, changelog, and changeset.

### Deferred / out of this plan
- The remaining RD-13 operations: secret and certificate rotation workflows, Compose hardening,
  least-privilege role provisioning, scheduled off-box checkpoints, and release engineering.
  The three RD-11 commands are implemented; the broader RD-13 program is not.
- The web UI (RD-12), image build/publish/signing (RD-14), OIDC CLI login, multi-account
  profiles, a TUI, and interactive secret editing (RD-11 Won't Have).
- Any new server product route other than the operations and bootstrap local surfaces.
- Any database migration.

## Acceptance Criteria

RD-11 owns its acceptance criteria. This plan adds these executable criteria:

1. Every RD-11 command runs through the generated client or the local operations module
   against the reference-style server, and `ov --help` lists every group and command.
2. `ov secret set name --stdin` never places the value in `process.argv`; a test inspects the
   spawned process arguments and the recorded request body.
3. `ov run --project payments -- ./start.sh` parses options before `--` and spawns the command
   with an argument array, never a shell.
4. `--json` success output is valid JSON on stdout; every error is on stderr and carries a
   stable code and request id when the server supplied one.
5. A destructive command prompts; `--yes` skips the prompt; non-interactive without `--yes`
   exits 2. A test covers all three.
6. The credential directory is `0700` and the file `0600` on POSIX; a symlink, a wrong owner, a
   looser mode, a corrupt version, a loose directory, and a concurrent writer all fail closed or
   serialize. Login, logout, and refresh share the lock. Native Windows fails closed with a
   clear code (AR-10, AR-55).
7. `ov docker scaffold` is idempotent, writes the Compose and manifest files, prints the token
   once, and leaves no literal token in either file.
8. `ov audit verify` exits 1 on a broken chain and prints the first bad event id.
9. `ov access explain` resolves a secret/certificate/project name and reports principals,
   roles, assignments, and consumers.
10. `pnpm api:check` fails when `packages/api-contract/openapi.json` or the generated client is
    stale, and `pnpm verify` runs it.
11. `ov auth sessions` lists the caller's CLI families and revokes an owned family.
12. No secret value, private key, password, or token appears in argv, logs, verbose events,
    error text, or any file other than the credential file and the explicit `--out` target.
13. `ov init` run twice (including two concurrent runs) produces one keyring, one current CA,
    one organization, one bootstrap administrator, one org-admin assignment, one signing key,
    and one matching server certificate/key pair; the CA is never rotated; a missing keyring
    with wrapped rows fails closed; the password is written only when the admin is created and
    meets the 12-character policy.
14. `ov backup` produces an age-encrypted archive containing the logical database dump,
    keyring, redacted config, public CA, and checkpoints; a wrong passphrase or checksum
    failure changes nothing. `ov restore` restores every row into an empty migrated target,
    verifies the audit chain, decrypts one current secret per project, and signs a probe
    certificate with the restored CA. A non-empty target is refused without `--force`.
15. `ov kek rotate` rewraps secret and certificate data keys, audit keys, CA keys, and JWT
    seeds; value ciphertext is byte-identical before and after; no row references the old KEK
    before it is removed from the keyring.
16. Restore and rotation require a role that owns the tables; the app role fails with a clear
    ownership error. Both operations write audit events.
17. `pnpm verify`, `pnpm api:check`, `pnpm db:types:check`, `pnpm changeset status`,
    `pnpm audit:prod`, the docs build, and the integration suite pass on PostgreSQL 16 and 17.

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Package and binary | `apps/cli`, `@openvault/cli`, `ov` | AR-1 |
| RD-13 boundary | Backup/restore/KEK rotate implemented; remaining RD-13 program deferred | AR-2 |
| Backup format | age-encrypted logical JSON dump | AR-61 |
| Restore safety | Owner role, empty target or --force, --yes | AR-62 |
| KEK rotation | Rewrap only; verify counts; maintenance window | AR-63 |
| Operations audit | `backup.create`, `backup.restore`, `kek.rotate` | AR-64 |
| Bootstrap | Server `init` module plus CLI delegation | AR-3 |
| Dispatcher | Global extraction + positional conversion + cmdline groups | AR-4, AR-5 |
| Contract | Real controllers + metadata table → OpenAPI + client | AR-6, AR-7 |
| Credentials | RD-11 contract, lock, fail closed | AR-8–AR-10 |
| Transport | `node:https`, CA, bounds, no redirects | AR-11 |
| Refresh | `BearerAuth` once, unauthenticated refresh runtime | AR-12 |
| Output | Human default, JSON envelope, fixed exit codes | AR-13 |
| Safety | Prompt + `--yes`; non-interactive exit 2 | AR-14 |
| Secret input | stdin/file/prompt, never argv | AR-15 |
| Set | PUT then create, separate idempotency keys, metadata PATCH | AR-16, AR-48 |
| Run | CLI manifest + private temp delivery | AR-17 |
| Scaffold | Files without token; token printed once | AR-18 |
| Export | Raw NDJSON stream | AR-19 |
| Verify | Exit 1 on break | AR-20 |
| Explain | Names resolved through list metadata | AR-21, AR-22 |
| Role revoke | Id or unique match | AR-23 |
| Logging | Redacted structured events | AR-24 |
| Rate limits | One capped retry | AR-25 |
| Doctor | Ready + credentials + clock | AR-26 |
| Completion | Static scripts | AR-27 |
| Tests | Fake HTTPS + real-server E2E | AR-28 |
| Dependencies | Pinned workspace libraries | AR-29 |
| Verification | Full repository gates | AR-30 |
| Schema | No migration | AR-31 |
| Artifacts | Contract in `packages/api-contract`, client in CLI | AR-32 |
| Init | Idempotent CA/keyring/admin/TLS; init lock + recovery guard | AR-33–AR-36, AR-39 |
| Init DB URL | Environment only, never argv | AR-40 |
| Init migrations | Separate migrator env URL | AR-59 |
| CA public file | Fail closed on mismatch; explicit replace | AR-60 |
| CA signing | `issueServerCertificate`; init never holds the scalar | AR-41 |
| Init UID | Init and server share a UID | AR-42 |
| Init org | Name update + policy version bump | AR-43 |
| Runtime errors | CLI wrapper maps runtime errors | AR-44 |
| Probe/export | Explicit bearer headers | AR-45 |
| Scaffold safety | Pre-call path checks; Compose-name validation | AR-46 |
| Certificate key | `--private-key` requires `--out` | AR-47 |
| Audit project | Name → ULID | AR-49 |
| Object grants | `--object-type` required | AR-50 |
| Single-command groups | Default command | AR-51 |
| Generated lint | Ignore generated artifacts | AR-52 |
| E2E placement | `tests/integration/` | AR-53 |
| Terminal output | TTY escaping | AR-54 |
| Credential directory | `0700`, owned, non-symlink | AR-55 |
| CA trust | Proxy root CA vs internal CA | AR-56 |
| Run manifest | 1 MiB, duplicate keys, cleanup | AR-57 |
| Export safety | Temp+rename, content-type check | AR-58 |
| Specialist | None | AR-37 |
| Help | Root help + version | AR-38 |

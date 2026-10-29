# RD-11: CLI

> **Document**: RD-11-cli.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-04, RD-06, RD-08, RD-09, RD-10
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the `ov` command line: bootstrap, login, projects, secrets,
certificates, identities, roles, audit, Docker scaffold, `run --`, backup/restore, and KEK
rotation. The CLI is the automation and incident surface; the UI covers common interactive
flows.

## Functional Requirements

### Must Have

- [ ] `ov init`, `ov login`, `ov logout`, and `ov whoami`.
- [ ] Project, secret, certificate, identity, and role commands.
- [ ] `ov audit` query, `ov audit verify`, and `ov audit export`.
- [ ] `ov docker scaffold <project> <service>`.
- [ ] `ov run -- <cmd>` runs a command with files or wrapper env injection.
- [ ] `ov backup` and `ov restore`.
- [ ] `ov kek rotate`.
- [ ] Nested command groups through a thin dispatcher over `blendsdk/cmdline`.
- [ ] `--json` output on stdout; errors on stderr with a stable code and request id.
- [ ] Destructive commands prompt unless `--yes` is passed.
- [ ] Credentials are stored with mode `0600`; `ov logout` removes them.
- [ ] Secret values are read from stdin, a file descriptor, or an interactive prompt; never
  from argv.
- [ ] The CLI uses the generated API client and fails `pnpm api:check` when stale.
- [ ] `ov access explain` lists effective principals, roles, assignments, and consumers.
- [ ] Help text lists every command and option.

### Should Have

- [ ] Shell completion for bash, zsh, and fish.
- [ ] `ov doctor` checks API reachability, TLS trust, credentials, and clock skew.
- [ ] `--verbose` logs request ids but never values.

### Won't Have (Out of Scope)

- OIDC login for the CLI (v0.2).
- Interactive TUI or secret editor.
- Multi-account profiles.

## Technical Requirements

### Command groups

| Group | Commands |
|---|---|
| auth | `login`, `logout`, `whoami`, `sessions` |
| project | `list`, `create`, `delete` |
| secret | `set`, `get`, `list`, `versions`, `delete`, `recover`, `purge` |
| cert | `import`, `generate`, `get`, `list`, `delete` |
| identity | `create`, `list`, `revoke`, `join-token` |
| role | `grant`, `revoke` |
| access | `explain` |
| audit | `list`, `verify`, `export` |
| docker | `scaffold` |
| run | `run -- <cmd>` |
| backup | `backup`, `restore` |
| kek | `rotate` |

### Dispatcher

`blendsdk/cmdline` does not execute nested subcommands or treat `--` as a passthrough. The CLI
uses a small dispatcher:

1. Read the top-level group (`secret`, `cert`, `role`, …).
2. Pass the remaining arguments to the group's `cmdline` parser.
3. `ov run --` and `ov-agent run --` handle `--` before invoking the parser.
4. Unknown groups print help and exit 2.

### Output

```json
{ "success": true, "data": { ... } }
```

Errors:

```json
{ "success": false, "error": { "code": "secret_not_found", "message": "...", "requestId": "..." } }
```

### Safety

- Destructive commands (`delete`, `purge`, `revoke`, `rotate`, `restore`) require `--yes` in
  non-interactive mode.
- `ov run` never passes secret values as arguments; files are mounted or env is set in the
  child process.
- The CLI refuses to write credentials to a world-readable file.

## Integration Points

- RD-04 supplies login and tokens.
- RD-06 supplies actions and capabilities.
- RD-08 and RD-09 supply data commands.
- RD-10 supplies scaffold and agent commands.
- RD-13 supplies backup/restore/rotation.
- RD-14 checks the generated client and CLI security tests.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Nested commands | Flat / dispatcher | Thin dispatcher | Usable UX without forking cmdline | AR-6 |
| Auth | Local / OIDC | Local in v0.1 | Scope control | AR-30 |
| Output | Human / JSON | Both | Automation and humans | AR-6 |
| Values | Argv / stdin | Stdin/file/prompt | Avoid `ps` leakage | AR-29 |
| Destructive safety | Prompt / flag | Prompt + `--yes` | Prevent accidents | AR-6 |

## Security Considerations

- **Data sensitivity:** tokens, secret values, private keys.
- **Input validation:** command names, option types, sizes, paths.
- **Authentication & authorization:** every API call uses the user's token; server enforces
  policy.
- **Injection risks:** no shell string concatenation; `ov run` uses `spawn` with an argument
  array.
- **Encryption needs:** TLS; credentials file `0600`.
- **Rate limiting:** server-side; CLI backs off on 429.
- **Infrastructure:** no secrets in argv, logs, shell history, or error output.

## Acceptance Criteria

1. [ ] Every command in the table runs against the reference stack; `ov --help` lists all
   groups.
2. [ ] `ov secret set db-password --stdin` reads the value from stdin and never places it in
   argv.
3. [ ] `ov run --project payments -- ./start.sh` parses options before `--` and execs the
   command unchanged.
4. [ ] `--json` output is valid JSON on stdout; errors are on stderr.
5. [ ] Destructive commands prompt; `--yes` skips the prompt; non-interactive without
   `--yes` exits 2.
6. [ ] The credentials file is mode `0600`; `ov logout` removes it.
7. [ ] `ov docker scaffold` is idempotent and prints the token once.
8. [ ] `ov audit verify` exits non-zero on a broken chain and prints the first bad event id.
9. [ ] `ov access explain` lists principals, roles, assignments, and consumers.
10. [ ] `pnpm api:check` fails when the generated client is stale.
11. [ ] Security requirements verified: no values in argv, logs, or credentials file beyond
    tokens.

# CLI reference

::: warning Target reference
The `ov` binary is part of v0.1.
:::

## Global options

| Option | Meaning |
|---|---|
| `--json` | Machine-readable output |
| `--project <name>` | Project context |
| `--org <name>` | Organization context |
| `--yes` | Skip destructive confirmations |
| `--verbose` | Debug logging without values |

## Commands

| Command | Purpose |
|---|---|
| `ov init` | Create the organization, admin, keyring, and CA (public certificate + wrapped `ca_keys`; re-running does not rotate) |
| `ov login` / `ov logout` | Manage CLI credentials |
| `ov whoami` | Show the current principal |
| `ov auth sessions` | List and revoke CLI token families |
| `ov project list/create/delete` | Manage projects |
| `ov secret set/get/list/versions/delete` | Manage secrets |
| `ov cert import/generate/get/delete` | Manage certificates |
| `ov identity create/revoke` | Manage service identities; revoke disables the principal and revokes all certificates and unused tokens |
| `ov identity join-token` | Issue a single-use join token, shown once |
| `ov role grant/revoke` | Manage assignments |
| `ov access explain` | Explain effective access and consumers |
| `ov audit` | Query, verify, and export audit events |
| `ov docker scaffold` | Add an agent to a Compose service; grants object-scope reader for manifest entries |
| `ov run -- <cmd>` | Run a command with injected secrets |
| `ov backup` / `ov restore` | Back up and restore |
| `ov kek rotate` | Rotate the KEK |

## Credentials

The CLI stores tokens in an OS-specific config directory: `$XDG_CONFIG_HOME/openvault/` or
`~/.config/openvault/` on Linux, `~/Library/Application Support/openvault/` on macOS, and
`%APPDATA%\openvault\` on Windows. The directory is mode `0700` and the file is mode `0600` on
POSIX; Windows restricts both to the current user or fails closed. Writes are atomic, symlinks
are rejected, and concurrent processes are serialized by a lock file.

`ov logout` calls the server to revoke the refresh family, then removes the credential and lock
files. If the network call fails, it still removes the local files and reports that the
server-side family may remain until expiry. Tokens never appear in argv, environment
variables, shell history, diagnostics, or logs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General failure |
| 2 | Usage error |
| 3 | Authentication required |
| 4 | Permission denied |
| 5 | Not found |
| 6 | Conflict |

## Examples

```bash
ov secret set db-password --stdin --project payments
ov secret get db-password --project payments --json
ov role grant payments-api secrets.reader --project payments
ov access explain db-password --project payments
ov audit verify
ov docker scaffold payments api
ov run --project payments -- ./start.sh
```

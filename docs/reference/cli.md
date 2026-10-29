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
| `ov init` | Create the organization, admin, keyring, and CA |
| `ov login` / `ov logout` | Manage CLI credentials |
| `ov whoami` | Show the current principal |
| `ov project list/create/delete` | Manage projects |
| `ov secret set/get/list/versions/delete` | Manage secrets |
| `ov cert import/generate/get/delete` | Manage certificates |
| `ov identity create/revoke` | Manage service identities |
| `ov identity join-token` | Issue a single-use join token |
| `ov role grant/revoke` | Manage assignments |
| `ov access explain` | Explain effective access and consumers |
| `ov audit` | Query, verify, and export audit events |
| `ov docker scaffold` | Add an agent to a Compose service |
| `ov run -- <cmd>` | Run a command with injected secrets |
| `ov backup` / `ov restore` | Back up and restore |
| `ov kek rotate` | Rotate the KEK |

## Credentials

The CLI stores tokens in `~/.config/openvault/credentials.json`, mode `0600`. `ov logout`
removes them.

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

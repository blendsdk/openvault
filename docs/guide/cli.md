# CLI

::: warning Target documentation
The `ov` command is part of v0.1. The current repository contains the workspace and API
skeleton, not the full CLI.
:::

The CLI is for bootstrap, automation, and incident work. The web UI covers the common
day-to-day flows.

## Login and context

```bash
ov login
ov whoami
ov logout
```

`ov login` supports the local administrator first. OIDC login for the CLI is planned for
v0.2.

## Projects and secrets

```bash
ov project list
ov project create payments
ov secret set db-password --stdin
ov secret list --project payments
ov secret get db-password --project payments
ov secret versions db-password --project payments
ov secret delete db-password --project payments --yes
```

Values are read from stdin, a file descriptor, or an interactive prompt. Never pass a value
as a command-line argument.

## Roles and access

```bash
ov identity create payments-api --project payments
ov identity join-token payments-api --project payments
ov role grant payments-api secrets.reader --project payments
ov access explain db-password --project payments
```

`ov access explain` lists every principal with an effective grant, the role, the scope, and
the assignment that produces it.

## Docker scaffold

```bash
ov docker scaffold payments api
```

Creates or reuses the project and identity, issues a single-use join token, and prints a
Compose snippet. It does not write the token into the Compose file.

## Run a command with injected secrets

```bash
ov run --project payments -- ./start.sh
```

Options before `--` are parsed by the CLI. The command after `--` runs unchanged with the
configured secrets available as files or, in wrapper mode, environment variables.

## Audit

```bash
ov audit --project payments --from 2026-10-01
ov audit verify
ov audit export --format ndjson --out audit.ndjson
```

## Output

Every command supports `--json` for automation. Errors go to stderr with a stable code and
a request id.

## Next

- [CLI reference](/reference/cli)
- [RBAC](/guide/rbac)

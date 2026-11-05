# CLI reference

The `ov` binary is built from `apps/cli` (`@openvault/cli`). It uses the generated client from
`apps/cli/src/generated`, which is produced from the real server controllers by
`apps/server/scripts/api-contract.ts`.

```bash
pnpm build
node apps/cli/dist/main.js --help
```

## Global options

Global options may appear before or after the group name, but before `--`.

| Option | Meaning |
|---|---|
| `--json` | Machine-readable output |
| `--yes` | Skip destructive confirmations |
| `--verbose` | Value-free request events on stderr |
| `--project <name>` | Project context |
| `--org <name>` | Organization context (reserved) |
| `--ca <path>` | CA bundle for server verification |
| `--url <url>` | Server base URL for login and doctor |
| `--timeout <seconds>` | Request timeout, 1–120 (default 15) |
| `-h`, `--help` | Root or group help |
| `--version` | Print the CLI version |

Environment fallbacks: `OPENVAULT_CA_FILE` for `--ca`, `OPENVAULT_URL` for `--url`.

## Commands

### Auth

| Command | Options | Purpose |
|---|---|---|
| `ov auth login` | `--identifier`, `--password-stdin` | Log in and store tokens |
| `ov auth logout` | — | Revoke the family and remove local credentials |
| `ov auth whoami` | — | Show the current principal |
| `ov auth sessions` | `--revoke <familyId>`, `--yes` | List or revoke CLI token families |

`ov login`, `ov logout`, and `ov whoami` are aliases for the matching auth commands.

### Projects

| Command | Options | Purpose |
|---|---|---|
| `ov project list` | — | List visible projects |
| `ov project create <name>` | `--name` | Create a project |
| `ov project delete <name>` | `--name`, `--yes` | Soft-delete a project |

### Secrets

| Command | Options | Purpose |
|---|---|---|
| `ov secret set <name>` | `--stdin`, `--from-file`, `--encoding utf8\|base64`, `--content-type`, `--expires-at`, `--tag key=value`, `--idempotency-key` | Create a secret or a new version |
| `ov secret get <name>` | `--version-id`, `--out`, `--force` | Read one value |
| `ov secret list` | `--q`, `--tag-key`, `--tag-value`, `--limit`, `--cursor` | List secret metadata |
| `ov secret versions <name>` | — | List versions |
| `ov secret delete <name>` | `--yes` | Soft-delete |
| `ov secret recover <name>` | — | Recover a deleted secret |
| `ov secret purge <name>` | `--yes` | Permanently delete |

`--project` is required for every secret command. `set` reads the value from stdin, a regular
file, `/dev/fd/N`, or a hidden prompt; it never accepts a value option. `get` prints only the
value in human mode. `--out` writes decoded bytes with mode `0600`.

### Certificates

| Command | Options | Purpose |
|---|---|---|
| `ov cert import <name>` | `--cert`, `--key`, `--chain`, `--tag`, `--allow-not-yet-valid`, `--version-id` | Import a certificate and key |
| `ov cert generate <name>` | `--subject`, `--san`, `--key-type`, `--validity-days`, `--tag`, `--version-id` | Generate a self-signed certificate |
| `ov cert get <name>` | `--version-id`, `--private-key --out`, `--force` | Read the chain or private key |
| `ov cert list` | `--q`, `--san`, `--expires-before`, `--expires-after`, `--limit`, `--cursor` | List certificates |
| `ov cert delete <name>` | `--yes` | Soft-delete |

`--private-key` requires `--out`; the key is written with mode `0600` and is never printed or
included in JSON.

### Identities, roles, and access

| Command | Options | Purpose |
|---|---|---|
| `ov identity create <name>` | `--project` | Create a service identity |
| `ov identity list` | `--project` | List identities |
| `ov identity revoke <name-or-id>` | `--project`, `--yes` | Revoke an identity |
| `ov identity join-token <name-or-id>` | `--project`, `--ttl` | Issue a one-time join token |
| `ov role grant <principal> <role>` | `--project`, `--scope`, `--scope-id`, `--object-type`, `--object`, `--expires-at` | Grant a role |
| `ov role revoke [principal role]` | `--project`, `--assignment`, `--scope`, `--scope-id`, `--object-type`, `--object`, `--yes` | Revoke an assignment |
| `ov access explain <target>` | `--target-type secret\|certificate\|project`, `--action` | Explain effective access |

Object-scope grants require `--object-type secret|certificate` and `--object`, or a bare
`--scope-id` ULID. `access explain` resolves names through list metadata and never reads a
value or private key.

### Audit

| Command | Options | Purpose |
|---|---|---|
| `ov audit list` | `--from`, `--to`, `--actor-id`, `--action`, `--object-type`, `--object-id`, `--result`, `--request-id`, `--project`, `--project-id`, `--limit`, `--cursor` | Query events |
| `ov audit verify` | — | Verify the chain; exits 1 when broken |
| `ov audit export` | filters plus `--out`, `--force` | Stream NDJSON to a `0600` file |

`--project` resolves a project name to its ULID; `--project-id` accepts the ULID directly.
Export writes to a temporary file, checks the status and `application/x-ndjson` content type,
then renames. A failed export preserves any previous file.

### Docker and run

| Command | Options | Purpose |
|---|---|---|
| `ov docker scaffold <project> <service>` | `--secret`, `--compose-project`, `--out`, `--force` | Write Compose and manifest files |
| `ov run` | `--manifest`, `--` | Run a child with delivered secrets |

`docker scaffold` validates both output paths before calling the API, writes the Compose file
with mode `0644` and the manifest with `0600`, and prints the join token once. The token is
never written into either file.

`run` reads `openvault.run.yaml` (or `--manifest`), fetches each required entry, writes files
into a private temporary directory, sets `OPENVAULT_RUN_DIR`, removes every other
`OPENVAULT_*` variable, and spawns the child with `shell: false`. Everything after `--` is the
child command and is never parsed.

### Bootstrap and diagnostics

| Command | Options | Purpose |
|---|---|---|
| `ov init` | `--prepare`, `--keyring`, `--internal-ca`, `--ca-public-dir`, `--tls-cert`, `--tls-key`, `--base-url`, `--org`, `--admin-name`, `--admin-email`, `--password-file`, `--generate-password`, `--bootstrap-password-file`, `--replace-ca-public` | Bootstrap the vault |
| `ov doctor` | — | Check readiness, TLS, credentials, and clock skew |
| `ov completion <bash\|zsh\|fish>` | `--shell` | Print a static completion script |

`init` reads `OPENVAULT_DB_URL`, optional `OPENVAULT_MIGRATION_DB_URL`, and the matching
`OPENVAULT_*` path/name variables. The database URL is never accepted in argv. Every path,
including `--password-file` and `--bootstrap-password-file`, must be absolute. See
[Configuration](/reference/configuration#cli-and-bootstrap).

### Deferred operations

`ov backup`, `ov restore`, and `ov kek rotate` are registered and safety-gated, but their
operations belong to the backup and rotation release. They exit 1 with `not_implemented`.

## Credentials

The CLI stores tokens in `$XDG_CONFIG_HOME/openvault/credentials.json` or
`~/.config/openvault/credentials.json` on Linux, `~/Library/Application Support/openvault/` on
macOS, and `%APPDATA%\openvault\` on Windows. The directory is `0700`; the file and lock are
`0600`. On POSIX the file must be a regular file owned by the current user, symlinks are
rejected, and concurrent processes serialize through the lock. Native Windows fails closed
with `credential_store_unsupported`; WSL uses the POSIX path.

`ov logout` calls the server to revoke the refresh family, then removes the credential and lock
files. If the network call fails, it still removes the local files and warns that the family may
remain until expiry. Tokens never appear in argv, environment variables, shell history,
diagnostics, or logs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General, transport, or rate-limit failure |
| 2 | Usage or validation error |
| 3 | Authentication required |
| 4 | Permission denied |
| 5 | Not found |
| 6 | Conflict |

## Generated API contract

`pnpm api:generate` writes `packages/api-contract/openapi.json` and the typed client under
`apps/cli/src/generated`. `pnpm api:check` rebuilds both in memory and fails on drift; it runs
inside `pnpm verify`.

## Examples

```bash
ov login --url https://vault.example.com --identifier admin@example.com
ov secret set db-password --project payments --stdin
ov secret get db-password --project payments --json
ov role grant payments-api secrets.reader --project payments
ov role grant payments-api secrets.reader --project payments \
  --scope object --object-type secret --object db-password
ov access explain db-password --project payments
ov audit verify
ov docker scaffold payments api --secret db-password
ov run --project payments -- ./start.sh
```

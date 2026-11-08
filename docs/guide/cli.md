# CLI

The `ov` command is the bootstrap, automation, and incident surface. The web UI covers the
common interactive flows. `ov` is built from `apps/cli` and talks to the same HTTPS API as the
browser.

## Build and sign in

```bash
pnpm --filter @openvault/cli build
export PATH="$PWD/apps/cli/node_modules/.bin:$PATH"

export OPENVAULT_CA_FILE=/path/to/proxy-root-ca.pem
ov login --url https://vault.example.com --identifier admin@example.com
ov whoami
ov logout
```

`ov login` prompts for the password without echo. `--password-stdin` reads it from a pipe so
scripts never place a password in argv. Tokens are written only to the credential file.

`OPENVAULT_CA_FILE` must point at the CA that signed the **proxy** certificate. In the
reference stack Caddy terminates TLS with its own internal root, while the OpenVault internal
CA signs the agent listener and the proxy-to-server upstream certificate. The two CA files are
not interchangeable.

## Projects and secrets

```bash
ov project list
ov project create payments
ov project delete payments --yes

ov secret set db-password --project payments --stdin
ov secret list --project payments
ov secret get db-password --project payments
ov secret get db-password --project payments --out ./db-password --force
ov secret versions db-password --project payments
ov secret delete db-password --project payments --yes
```

Values are read from stdin, a regular file, `/dev/fd/N`, or an interactive hidden prompt.
A value is never accepted as a command-line option. `secret get` prints only the value in
human mode so it can be piped; `--json` prints the full response.

`secret set` tries the update route first and creates the secret when it does not exist. Tags
and content type are written with the value on create; on update they are applied in a
separate metadata request.

## Certificates, identities, and roles

```bash
ov cert import api --project payments --cert leaf.pem --key key.pem
ov cert generate api --project payments --subject CN=api --san DNS:api
ov cert get api --project payments
ov cert get api --project payments --private-key --out api.key
ov cert list --project payments

ov identity create payments-api --project payments
ov identity list --project payments
ov identity join-token payments-api --project payments
ov identity revoke payments-api --project payments --yes

ov role grant payments-api secrets.reader --project payments
ov role grant payments-api secrets.reader --project payments \
  --scope object --object-type secret --object db-password
ov role revoke payments-api secrets.reader --project payments --yes
ov role revoke --assignment 01ARZ3NDEKTSV4RRFFQ69G5FAV --yes
```

`--private-key` requires `--out`; a private key is never printed to stdout or included in JSON.
`identity join-token` prints the token once and warns that it cannot be retrieved again.

`role grant` accepts `--scope org`, `--scope project` (the default), or `--scope object`.
Object scope requires `--object-type secret|certificate` and `--object`, or a bare
`--scope-id` ULID. `role revoke` without `--assignment` lists matching assignments; if several
match it prints their ids and exits 2.

## Access and audit

```bash
ov access explain db-password --project payments
ov access explain api --project payments --target-type certificate
ov access explain payments --target-type project

ov audit list --project payments --from 2026-10-01T00:00:00Z
ov audit verify
ov audit export --out audit.ndjson
```

`access explain` resolves the target through list metadata, so an auditor does not need
`secret.read` to inspect grants. `audit verify` exits 0 only when the chain is intact and prints
the first broken event id when it is not. Export streams NDJSON to a `0600` file.

## Docker scaffold

```bash
ov docker scaffold payments api \
  --secret db-password \
  --compose-project payments
```

The command checks both output paths before contacting the server. It creates or reuses the
project and identity, grants object-scope reader only for the listed secrets, and issues a
single-use join token. The token is printed once with a warning and is never written into the
Compose or manifest file. Re-running with the same arguments reuses the grants and rotates the
token.

## Run a command with delivered secrets

`openvault.run.yaml`:

```yaml
project: payments
entries:
  - name: db-password
    file: db_password
  - name: stripe-key
    env: STRIPE_KEY
    optional: true
```

```bash
ov run --project payments -- ./start.sh
```

Options before `--` are parsed by `ov`. Everything after `--` is passed to the child unchanged
and is never parsed. Required values are fetched before the child starts. Files are written to a
private temporary directory; the child receives its path in `OPENVAULT_RUN_DIR`, and every
other `OPENVAULT_*` variable is removed. The directory is removed on exit or signal.

## Bootstrap

```bash
export OPENVAULT_DB_URL=postgres://openvault:secret@postgres:5432/openvault
export OPENVAULT_KEYRING=/var/lib/openvault/keyring.json
export OPENVAULT_TLS_CERT=/etc/openvault/tls/server.crt
export OPENVAULT_TLS_KEY=/etc/openvault/tls/server.key
export OPENVAULT_INTERNAL_CA=/etc/openvault/ca/ca.pem

ov init --prepare
```

`ov init` creates or reuses the keyring, internal CA, server certificate, organization,
bootstrap administrator, and signing key. It is idempotent and never rotates the CA. A generated
password is written once to a `0600` file and is never printed. If the keyring is missing but
wrapped state exists in the database, init fails closed and asks for a restore from backup.

The database URL comes only from the environment. `OPENVAULT_MIGRATION_DB_URL` must name the
migrator/owner role for `ov init` bootstrap writes and DDL; the app role cannot write
organizations, principals, credentials, assignments, or key tables. The server uses
`OPENVAULT_DB_URL` for runtime traffic. Init and the server must run
as the same non-root UID so the `0600` keyring and TLS key are readable.

## Output and exit codes

`--json` prints `{ "success": true, "data": ... }` on stdout. Errors always go to stderr as
`{ "success": false, "error": { "code", "message", "requestId?" } }` or as
`code: message (request ...)` in human mode. `--verbose` writes value-free request events to
stderr.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General, transport, or rate-limit failure |
| 2 | Usage or validation error |
| 3 | Authentication required |
| 4 | Permission denied |
| 5 | Not found |
| 6 | Conflict |

## Credentials

The credential file is `$XDG_CONFIG_HOME/openvault/credentials.json` or
`~/.config/openvault/credentials.json` on Linux, `~/Library/Application Support/openvault/` on
macOS, and `%APPDATA%\openvault\` on Windows. The directory is `0700`, the file and lock are
`0600`, writes are atomic, symlinks are rejected, and concurrent processes serialize through
the lock. Native Windows fails closed because Node cannot enforce an owner-only ACL there; use
WSL instead.

## Backup, restore, and KEK rotation

```bash
export OPENVAULT_DB_URL=postgres://openvault:secret@postgres:5432/openvault
export OPENVAULT_BACKUP_DB_URL=postgres://openvault_backup:secret@postgres:5432/openvault
export OPENVAULT_KEYRING=/var/lib/openvault/keyring.json
export OPENVAULT_INTERNAL_CA=/etc/openvault/tls/ca.pem
export OPENVAULT_BACKUP_PASSPHRASE_FILE=/run/secrets/backup-passphrase

ov backup --out /backups/openvault.age
ov restore /backups/openvault.age --yes
ov kek rotate --yes
```

`ov backup` writes one passphrase-encrypted age archive containing a logical JSON database
dump, the raw keyring, a redacted configuration manifest, the public internal CA, and the
audit checkpoints. The passphrase comes from a `0600` file or an interactive hidden prompt;
it is never accepted in argv. The database password and every stored secret value remain
outside the manifest. Compaction and `pg_dump` compatibility are deferred; the archive is a
portable v1.0 logical dump.

`ov restore` decrypts and verifies every manifest checksum before touching the target. The
target must be empty unless `--force` is set, and `--yes` is required for the destructive
confirmation. Set `OPENVAULT_RESTORE_DB_URL` to an owner or migrator role that can disable
triggers and truncate the tables; the default `OPENVAULT_DB_URL` is the application role and
may fail with `restore_requires_owner`. Restore runs migrations, restores rows, writes the
keyring and public CA, verifies the audit chain, decrypts every current secret and certificate
private key, verifies the JWT signing key, and signs a probe certificate with the restored CA
key. Add `--agent-certificate <pem>` to verify a certificate captured before the backup.

`ov kek rotate` generates a new KEK, rewraps every secret and certificate data key, audit
key, CA scalar, and JWT seed, updates `kek_id`, verifies that no row still references the old
key, and only then removes it from the keyring. Value ciphertext is never re-encrypted.
Rotation needs a role that owns the key tables because it temporarily disables the
immutability triggers. Run it during a maintenance window with the server stopped: a running
server holds the old keyring in memory and can write new rows with the old `kek_id` after the
verification step. Use `--dry-run` to see the counts without changing anything.

All three operations write `backup.create`, `backup.restore`, or `kek.rotate` audit events.

## Next

- [CLI reference](/reference/cli)
- [RBAC](/guide/rbac)
- [Agent](/guide/agent)

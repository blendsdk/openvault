# Commands and Bootstrap: RD-11 CLI

> **Document**: 03-03-commands-init.md
> **Parent**: [Index](00-index.md)

## Overview

This component defines every `ov` command, the `run` delivery model, the Docker scaffold, the
bootstrap command, doctor, completion, and the three RD-13-gated commands. Each command uses
the generated client from [03-02](03-02-api-contract.md), the runtime from
[03-01](03-01-cli-runtime.md), and the existing server contracts.

## Command Matrix

| Group | Command | Positionals | Key options | Server route |
|---|---|---|---|---|
| auth | `login` | — | `--url`, `--identifier`, `--password-stdin` | `POST /v1/auth/cli/login` |
| auth | `logout` | — | — | `POST /v1/auth/cli/logout` |
| auth | `whoami` | — | — | `GET /v1/auth/cli/me` |
| auth | `sessions` | — | `--revoke <familyId>`, `--yes` | `GET`/`DELETE /v1/auth/cli/sessions` |
| project | `list` | — | — | `GET /v1/admin/projects` |
| project | `create` | `name` | — | `POST /v1/admin/projects` |
| project | `delete` | `name` | `--yes` | list + `DELETE /v1/admin/projects/:id` |
| secret | `set` | `name` | `--stdin`, `--from-file`, `--encoding`, `--content-type`, `--tag`, `--expires-at`, `--idempotency-key` | `PUT` then `POST /v1/data/:project/secrets` |
| secret | `get` | `name` | `--version`, `--out` | `GET /v1/data/:project/secrets/:name` |
| secret | `list` | — | `--q`, `--tag-key`, `--tag-value`, `--limit`, `--cursor` | `GET /v1/data/:project/secrets` |
| secret | `versions` | `name` | — | `GET .../:name/versions` |
| secret | `delete` | `name` | `--yes` | `DELETE .../:name` |
| secret | `recover` | `name` | — | `POST .../:name/recover` |
| secret | `purge` | `name` | `--yes` | `POST .../:name/purge` |
| cert | `import` | `name` | `--cert`, `--chain`, `--key`, `--tag`, `--allow-not-yet-valid`, `--version` | `POST .../certificates/import` |
| cert | `generate` | `name` | `--subject`, `--san`, `--key-type`, `--validity-days`, `--tag`, `--version` | `POST .../certificates/generate` |
| cert | `get` | `name` | `--version`, `--private-key` (requires `--out`), `--out` | `GET .../certificates/:name` (+ `private-key`) |
| cert | `list` | — | `--q`, `--san`, `--expires-before`, `--expires-after`, `--limit`, `--cursor` | `GET .../certificates` |
| cert | `delete` | `name` | `--yes` | `DELETE .../certificates/:name` |
| identity | `create` | `name` | `--project` (global) | `POST /v1/admin/identities` |
| identity | `list` | — | `--project` (global) | `GET /v1/admin/identities` |
| identity | `revoke` | `name-or-id` | `--yes` | `POST /v1/admin/identities/:id/revoke` |
| identity | `join-token` | `name-or-id` | `--ttl` | `POST /v1/admin/identities/:id/join-tokens` |
| role | `grant` | `principal role` | `--scope`, `--scope-id`, `--object-type`, `--object`, `--expires-at` | `POST /v1/admin/assignments` |
| role | `revoke` | `principal role` (optional with `--assignment`) | `--assignment`, `--scope`, `--scope-id`, `--object-type`, `--object`, `--yes` | list + `DELETE /v1/admin/assignments/:id` |
| access | `explain` | `target` | `--target-type`, `--action` | list/get + `GET /v1/admin/access-explain` |
| audit | `list` | — | filters, `--project-id`, `--limit`, `--cursor` | `GET /v1/audit/events` |
| audit | `verify` | — | — | `GET /v1/audit/verify` |
| audit | `export` | — | filters, `--out`, `--force` | `GET /v1/audit/export` |
| docker | `scaffold` | `project service` | `--secret`, `--compose-project`, `--out`, `--force` | `POST /v1/admin/scaffold` |
| run | `run` | child after `--` | `--manifest` | data reads |
| init | `init` | — | `--prepare`, `--keyring`, `--internal-ca`, `--ca-public-dir`, `--tls-cert`, `--tls-key`, `--base-url`, `--org`, `--admin-name`, `--admin-email`, `--password-file`, `--generate-password`, `--bootstrap-password-file` | local `runInit` (DB URL from `OPENVAULT_DB_URL`) |
| backup | `backup` | — | `--out`, `--passphrase-file` | RD-13 |
| restore | `restore` | `archive` | `--yes`, `--passphrase-file` | RD-13 |
| kek | `rotate` | — | `--yes` | RD-13 |
| doctor | `doctor` | — | — | `/ready`, `/v1/auth/cli/me`, `Date` |
| completion | `completion` | `shell` | — | local |

Every authenticated command requires `--project` where the route needs a project, except
`project`, `auth`, `init`, `doctor`, `completion`, `access` with `--target-type project`, and
the global audit/role routes.

## Implementation Details

### Shared command context

```ts
/** Per-invocation command context. */
export interface CommandContext {
  readonly globals: GlobalOptions;
  readonly runtime: CliRuntime;
  readonly credentials: CredentialStore;
  readonly transport: HttpsAdapter;
  /** Builds the authenticated client on first use. */
  client(): Promise<OpenVaultClient>;
  /** Prints a human or JSON success result. */
  render<T>(data: T, human: (value: T) => string): void;
  /** Requires the global project or fails with usage_error. */
  project(): string;
}
```

`render` writes `{success:true,data}` when `--json`, otherwise the human text. `project()`
throws `CliError("usage_error", "--project is required", {exitCode:2})` when absent.

### Auth commands

- `login`:
  - Base URL: `--url`, else `OPENVAULT_URL`, else error. Must be an HTTPS origin.
  - Identifier: `--identifier`, else prompt `Identifier: `.
  - Password: `--password-stdin` reads stdin; otherwise `readPassword`.
  - Call `loginCli`; on success, save the credential document and print
    `Logged in as <name> <<email>>` or the JSON token response without the tokens? The JSON
    output includes the public user and expiries but **not** the access/refresh tokens; the
    tokens are only in the credential file. This prevents accidental token logging.
  - If `mustChangePassword`, print a warning that data commands are blocked until the password
    changes in the browser.
- `logout`: load credentials if present; call `logoutCli` with the refresh token; always remove
  the credential and lock files. If the network call fails, print a warning that the family may
  remain until expiry and still exit 0. JSON output `{loggedOut:true, serverNotified:boolean}`.
- `whoami`: `getCliMe`; human output `name <email> (id)` and a must-change warning.
- `sessions`: list; human table `ID`, `CREATED`, `EXPIRES`, `CURRENT`. `--revoke <id>` prompts
  unless `--yes` (it is a destructive command); in a non-interactive process without `--yes`
  it exits 2 without calling the server. A confirmed revoke calls `revokeCliSession` and prints
  `Revoked <id>`. The current family can be revoked; the CLI then reports that the next request
  requires login.
- `ov auth sessions --revoke` with no value is a usage error.

### Project commands

- `list`: table `NAME`, `ID`, `CERTIFICATES`, `DELETED`; JSON returns `{projects}`.
- `create <name>`: `createProject`; print the project.
- `delete <name>`: resolve by listing and exact match; require confirmation unless `--yes`;
  delete by ID; print `Deleted <name>`.

Name resolution is shared:

```ts
/** Resolves one active project name to its record. */
async function resolveProject(client: OpenVaultClient, name: string): Promise<Project>;
```

It lists projects, finds `name`, and throws `not_found` with a stable message when absent.

### Secret commands

- `set <name>`:
  - Read the value from `--stdin` (all stdin), `--from-file <path>` (a regular file **or**
    `/dev/fd/N` / `/proc/self/fd/N` with a bounded read, max 64 KiB decoded), or a hidden
    prompt. Reject a value option.
  - Validate `--encoding` (`utf8`/`base64`) and `--content-type`.
  - Parse repeated `--tag key=value`; reject duplicate keys, control characters, and more than
    fifteen tags.
  - Build the write body. Generate a **separate** idempotency key for each method/path if
    `--idempotency-key` is absent.
  - Try `writeSecretValue`; on `secret_not_found`, `createSecret`; on create
    `409 secret_name_conflict`, retry `writeSecretValue` once. On the update path, if `--tag` or
    `--content-type` was supplied, call `updateSecretMetadata` after the value write (not
    atomic; report a metadata failure separately). Print the resulting metadata and version id.
  - The value is never printed or logged; the command prints `Set <name> version <id>`.
- `get <name>`:
  - `getSecret`; if `--out` is set, write the decoded bytes (base64 decodes to bytes, utf8 writes
    text) with mode `0600` atomically and print the path. Otherwise print the value to stdout
    exactly (no extra text) so it can be piped; human mode prints only the value. `--json`
    prints the full response including the value.
  - `--version` passes the ULID.
- `list`: table `NAME`, `STATUS`, `VERSION`, `TAGS`, `EXPIRES`; JSON returns `{secrets,nextCursor}`.
- `versions <name>`: table `VERSION`, `CREATED`, `STATUS`, `CURRENT`.
- `delete <name>`: confirm; `deleteSecret`; print `Deleted <name>`.
- `recover <name>`: `recoverSecret`; print metadata.
- `purge <name>`: confirm; `purgeSecret`; print `Purged <name>`.

### Certificate commands

- `import <name>`: require `--cert` and `--key`; optional `--chain`. Read files with a bound
  (leaf/chain 256 KiB, key 64 KiB), reject empty files, pass `allowNotYetValid` and the optional
  expected version. Print metadata, fingerprint, and warnings.
- `generate <name>`: require `--subject` and at least one `--san`; key type default `ec-p256`;
  validity default 365. Calls `generateCertificate`.
- `get <name>`: default public chain. `--private-key` **requires `--out <path>`**; without it
  the command exits 2. It calls `getCertificatePrivateKey` and writes the PEM atomically with
  mode `0600`, rejecting a symlink or existing target without `--force`. A warning goes to
  stderr. The key is never printed to stdout or included in `--json`.
- `list`: filters; table `NAME`, `SUBJECT`, `EXPIRES`, `DAYS`, `STATUS`.
- `delete <name>`: confirm; `deleteCertificate`.

### Identity, role, and access commands

- `identity create <name>`: require `--project`; resolve the project name to its ULID; call
  `createIdentity({name, projectId})`.
- `identity list`: require `--project`; resolve; table `NAME`, `ID`, `STATUS`, `CREATED`.
- `identity revoke <name-or-id>`: if the value is a ULID, use it; otherwise resolve by listing the
  project's identities. Confirm; call `revokeIdentity`.
- `identity join-token <name-or-id>`: optional `--ttl` 1–86,400; print the token once with a
  warning that it cannot be shown again. JSON includes the token.
- `role grant <principal> <role>`:
  - Require `--project` unless `--scope org`.
  - Resolve the principal: exact identity name in the project, else a user by ID if the value is
    a ULID, else error.
  - Scope: `--scope org` → `org`/`org`; `--scope project` (default) → project ID; `--scope object`
    requires `--object-type secret|certificate` plus `--object <name>` resolved to its ID, or a
    bare `--scope-id <ulid>`.
  - Call `createAssignment`.
- `role revoke [<principal> <role>]`:
  - `principal`/`role` are optional only when `--assignment <id>` is supplied. With an
    assignment id, list the visible assignments, find the id, confirm, and delete it.
  - Otherwise resolve the principal and scope as above; list assignments filtered by principal,
    role, and scope.
  - If exactly one match, confirm and delete; if several, exit 2 with the matching IDs.
- `access explain <target>`:
  - `--target-type secret|certificate|project` (default `secret`).
  - `secret`: require `--project`; resolve the name through `listSecrets` (exact match,
    paginated) to the object ID; action default `secret.read`; scope `object`, objectType
    `secret`. Never read the value.
  - `certificate`: require `--project`; resolve the name through `listCertificates` (exact
    match, paginated); action default `certificate.read`; scope `object`, objectType
    `certificate`. Never read private material.
  - `project`: resolve the project name; action default `project.read`; scope `project`.
  - Call `explainAccess`; human table `PRINCIPAL`, `KIND`, `ROLE`, `SCOPE`, `ASSIGNMENT`,
    `CONSUMER`; JSON returns the response.

### Audit commands

- `audit list`: filters `--from`, `--to`, `--actor-id`, `--action`, `--object-type`,
  `--object-id`, `--result`, `--request-id`, `--project <name>` or `--project-id <ulid>`,
  `--limit`, `--cursor`. `--project` resolves to a ULID through `listProjects`; the query uses
  `projectId`. Table `TIME`, `ACTION`, `ACTOR`, `RESULT`, `OBJECT`, `REQUEST`.
- `audit verify`: call `verifyAudit`; human prints `ok <from>..<to>` or
  `broken <reason> first=<id>` to stderr. Exit 0 on `ok`, 1 otherwise.
- `audit export`: the same filters; `--out` required; refuse an existing file unless `--force`;
  stream NDJSON with the HTTPS adapter, checking 2xx and `application/x-ndjson` before creating
  the target; write to a temp file, `fsync`, and rename; print `Exported <bytes> bytes to <path>`;
  set mode `0600`. A non-2xx or stream failure removes the temp file and preserves any previous
  export.

### Docker scaffold

`ov docker scaffold <project> <service> [--secret <name>]... [--compose-project <name>] [--out <dir>] [--force]`

1. Determine `composeProject = --compose-project ?? project`; validate it with
   `^[a-z0-9][a-z0-9_-]{0,62}$`. Resolve both target paths and require containment under
   `--out` (default cwd); reject symlinks and existing files unless `--force`. Do this
   **before** the API call so a refused overwrite does not rotate the join token.
2. Call `createScaffold({project, service, entries})`.
3. Write two files under `--out`:
   - `openvault.<composeProject>.<service>.compose.yaml` with the returned `compose`, mode `0644`.
   - `openvault.<composeProject>.<service>.manifest.yaml` with the returned `manifest`, mode `0600`.
   Replace the `${COMPOSE_PROJECT_NAME}` template in the manifest file name with the resolved
   compose project. Do not substitute the token.
4. Refuse to overwrite either file unless `--force`.
5. Print the join token once to stdout with a warning; JSON output includes `joinToken`, file
   paths, and the response's identity/assignments. The token is never written to a file.
6. Re-running with the same arguments reuses the project/identity/assignments and issues a fresh
   token; the files are overwritten only with `--force`.

### `ov run`

Manifest (`openvault.run.yaml` by default):

```yaml
project: payments
entries:
  - name: db-password
    file: db_password
  - name: stripe-key
    env: STRIPE_KEY
  - name: legacy-token
    env: LEGACY_TOKEN
    optional: true
```

Rules (AR-17):

- Read at most 1 MiB; reject duplicate YAML keys; strict object: exactly `project` and
  `entries`; 1–100 entries; reject control characters.
- Each entry has `name` (secret name), optional `file`, optional `env`, optional `mode`
  (`0400`/`0440`/`0600`/`0640`, default `0400`), and optional `optional`.
- At least one of `file`/`env`; unique names, file targets, and env names.
- `file` matches `^[A-Za-z0-9._-]+$`, not `.`/`..`, no separators.
- `env` matches `^[A-Za-z_][A-Za-z0-9_]{0,127}$` and is not a loader variable (`PATH`, `HOME`,
  `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `LD_*`,
  `DYLD_*`, `BASH_ENV`, `ENV`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PERL5OPT`,
  `RUBYOPT`, `GCONV_PATH`, `GIT_CONFIG_*`, `OPENVAULT_*`).
- `project` must equal `--project` when both are present.

Delivery:

1. Fetch every entry into memory via `getSecret`.
2. A required 404, policy 403, or transport failure aborts before the child starts.
3. An optional failure marks the entry degraded; a previous file is removed if present.
4. Create `mkdtempSync(join(tmpdir(), "openvault-run-"))` mode `0700`; write each file with
   `O_CREAT|O_EXCL`, mode `0600`, then `chmod` the final mode; `fsync`; rename into place.
5. Build the child environment from `process.env` with every `OPENVAULT_*` and
   `COMPOSE_PROJECT_NAME` removed, then add only manifest `env:` values. Reject a value that is
   not valid UTF-8 or contains NUL.
6. Spawn `spawn(command, args, { env, cwd, stdio: "inherit", shell: false })`.
7. Forward SIGINT/SIGTERM to the child; wait up to 5 seconds, then SIGKILL.
8. On child exit, remove the temp directory recursively and exit with the child's code (or 1 on
   a signal).
9. Cleanup runs through one `finally` for parse, fetch, write, spawn, child-exit, and signal
   paths; a spawn failure removes the temp directory before the error is reported.
10. Never print a value. A verbose entry may name the entry and the target, never the value.

### CA trust for the reference stack

`ov login`/`ov doctor` against `https://localhost` trust the proxy's public root CA (Caddy's
`tls internal` root), not the OpenVault internal CA. The OpenVault internal CA is used by the
agent listener and the proxy-to-server upstream; the scaffold writes `openvault-ca.pem` for
that purpose. The docs must publish both files with distinct names to avoid a verification
failure or an operator disabling TLS checks (AR-56).

### `ov init`

The CLI maps options and environment into `runInit` from `@openvault/server/init`:

| CLI option | Environment fallback | Required |
|---|---|---|
| — | `OPENVAULT_DB_URL` | yes (environment only; never argv) |
| `--keyring` | `OPENVAULT_KEYRING` | yes |
| `--internal-ca` | `OPENVAULT_INTERNAL_CA` or `dirname(--tls-cert)/ca.pem` | derived |
| `--ca-public-dir` | `OPENVAULT_CA_PUBLIC_DIR` | no |
| `--tls-cert` | `OPENVAULT_TLS_CERT` | with `--tls-key` |
| `--tls-key` | `OPENVAULT_TLS_KEY` | with `--tls-cert` |
| `--base-url` | `OPENVAULT_BASE_URL` | default `https://localhost` |
| `--org` | `OPENVAULT_ORG_NAME` | default `OpenVault` |
| `--admin-name` | `OPENVAULT_BOOTSTRAP_ADMIN_NAME` | default `OpenVault Administrator` |
| `--admin-email` | `OPENVAULT_BOOTSTRAP_ADMIN_EMAIL` | default `admin@openvault.local` |
| `--password-file` | `OPENVAULT_BOOTSTRAP_PASSWORD_FILE` | one of password modes |
| `--generate-password` | — | one of password modes |
| `--bootstrap-password-file` | `OPENVAULT_BOOTSTRAP_PASSWORD_OUTPUT` | default beside keyring |
| `--replace-ca-public` | — | no |

`--prepare` sets `--generate-password` and derives every path from the environment. It is the
reference Compose invocation. `OPENVAULT_MIGRATION_DB_URL` is read directly from the
environment (not a CLI option) and defaults to `OPENVAULT_DB_URL`; it lets RD-13 supply a
migrator role for DDL while the app role owns runtime data (AR-59).

`runInit` behavior:

1. Read `OPENVAULT_DB_URL` and optional `OPENVAULT_MIGRATION_DB_URL` from the environment; there
   is no `--db-url` option. Validate both with `parseDatabaseUrl`; validate absolute paths and
   an HTTPS origin. Use the migration URL (or the app URL when unset) for DDL and the app URL
   for the bootstrap data writes.
2. Take one init lock: a `0600` lock file beside the keyring plus a PostgreSQL advisory lock.
   The lock spans keyring creation, CA insert, TLS generation, admin creation, and signing-key
   ensure.
3. Run migrations with the server migration config under the migration URL (set/restore
   `OPENVAULT_DB_URL` around the call).
4. Create or load the keyring:
   - Absent: generate 32 random bytes, write `{version:1,current:"kek-1",keys:{"kek-1":"<base64>"}}`
     atomically `0600`, then fill the buffer.
   - Present: `KeyringProvider.load` validates regular file, owner, and `0600`.
5. Create or reuse the internal CA:
   - Absent: generate P-256 CA keys; self-signed certificate `CN=OpenVault Internal CA`,
     10 years, `BasicConstraints(CA:TRUE, pathlen:0)`, `KeyUsage(keyCertSign|cRLSign)`; wrap the
     scalar with `wrapCaScalar`; insert `ca_keys` with status `current`.
   - Present: load the current row; do not rotate; verify the public point matches the
     certificate.
   - Write the CA PEM to every configured public path atomically `0644`, rejecting symlinks. If
     a public path already exists with different bytes, fail closed unless
     `--replace-ca-public` is supplied (AR-60).
6. Create or reuse the server certificate:
   - Both absent: generate P-256 server keys; sign a certificate with the CA key for
     `openvaultd`, `localhost`, `127.0.0.1`, and the `--base-url` host; `serverAuth` EKU; write
     cert `0644` and PKCS#8 key `0600`.
   - Both present: parse and verify the pair matches; reuse.
   - One present: fail closed.
7. Create or reuse the organization (`org` row id 1) and bootstrap administrator:
   - Find a user by lower-cased email. If absent, insert the principal, local credential
     (`hashPassword`), and `org.admin` assignment on `org` in one transaction.
   - `must_change` is false in v0.1 for both modes because RD-12 (the web UI) is not available and RD-04 blocks CLI data commands while it is true; the generated password is strong random material and its `0600` file must be removed after first use (AR-34).
   - Never update an existing administrator's password or roles.
8. Ensure the JWT signing key with `SigningKeyService.ensure()`.
9. Write the generated bootstrap password to the configured one-time file `0600` **before**
   the administrator insert, remove it if the insert fails, and never print it. If the
   administrator already exists, do not generate or write a password. Return the path.
10. Return a summary of created/reused items and warnings (for example "CA already existed; not
    rotated").

`runInit` is idempotent and safe to run concurrently only through the explicit init lock: the
keyring is created with `O_CREAT|O_EXCL` (on `EEXIST`, re-read and validate), a `ca_keys`
unique violation is caught and the current row re-read, and the TLS pair is written under the
same lock and verified after writing. **Recovery guard:** if the keyring is missing but any
`ca_keys`, `signing_keys`, `secret_versions`, `certificate_versions`, or `audit_keys` row
exists, init fails closed with a restore-from-backup message; it never writes a new KEK over
wrapped state.

The CA scalar never leaves `security/ca.ts`: init calls a bootstrap-only
`issueServerCertificate` operation that unwraps the current CA row, signs the server
certificate, and zeroes the scalar in `finally` (AR-41). Generated server keys and keyring
buffers are zeroed in `finally` where mutable.

Operator passwords are validated with `validateNewPassword` (12–1024) before hashing. The
organization row is created if absent and its name is updated when `--org` differs; the admin
assignment transaction bumps `policy_state.version` so a running server sees the bootstrap
grant. Init writes no audit event (no request context and the audit key may not exist yet);
the first login is audited normally.

Init and the server must run as the same non-root UID/GID so the `0600` keyring and TLS key
are readable. The reference Compose must set that contract; RD-13 owns the final UID
hardening (AR-42).

### Deferred commands

`ov backup`, `ov restore`, and `ov kek rotate` parse and validate their options. `restore` and
`rotate` prompt unless `--yes`; a missing confirmation in a non-interactive process exits 2
before any operation. After a confirmed invocation they throw:

```text
not_implemented: <command> is delivered by RD-13 (backup, rotation, and operations); no server operation exists in this release
```

Exit code 1. The root help marks them `[RD-13]`. This is the explicit AR-2 boundary and the
named RD-13 deferral: RD-11's client surface is complete; the three operations remain owned by
RD-13 and are not claimed as implemented.

### Doctor and completion

`ov doctor`:

1. `GET /ready` through `probe`; pass when 200, else report `readiness`.
2. `GET /v1/auth/cli/me`; pass when 200, else `credentials`.
3. Compare the `Date` header with local time; warn above 60 seconds, fail above 300.
4. Print one line per check and exit 1 if any failed. `--json` returns
   `{ok, checks:[{name,ok,detail}]}`.

`ov completion <bash|zsh|fish>` prints a static script with the groups and commands. The script
does not call the API. An unknown shell exits 2.

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Missing `--project` | `usage_error`, exit 2 | AR-13 |
| Project name not found | `project_not_found`, exit 5 | AR-22 |
| Identity name not found | `identity_not_found`, exit 5 | AR-22 |
| Secret create/update race | One retry; otherwise the server error | AR-16 |
| Required `run` entry missing | Abort before spawn; no child | AR-17 |
| Optional `run` entry missing | Omit file/env; continue | AR-17 |
| Scaffold file exists | `file_exists`, exit 1; use `--force` | AR-18 |
| Scaffold token | Printed once; never in a file | AR-18 |
| Broken audit chain | Exit 1, print reason and first bad id | AR-20 |
| Ambiguous role revoke | Exit 2 with matching assignment ids | AR-23 |
| RD-13 command | `not_implemented`, exit 1 | AR-2 |
| Init existing CA | Reuse; warning only | AR-33 |
| Init password | One-time file; never stdout | AR-34 |

## Testing Requirements
- Command tests against a fake HTTPS server that records requests: auth, project, secret, cert,
  identity, role, access, audit, scaffold.
- `secret set` from stdin/file/prompt; captured argv never contains the value.
- `secret get --out` decodes base64 bytes and writes `0600`.
- `run` with a child that writes its env and file paths; required/optional failures; cleanup.
- Scaffold writes two files with no token; the token is printed once; idempotent re-run.
- Audit verify exit 1 on a broken response; export streams to a `0600` file.
- Deferred commands parse, prompt, and return `not_implemented`.
- Doctor pass/fail for readiness, credentials, TLS, and clock.
- Completion output contains every group.
- Real-server binary E2E in `apps/server/tests/integration/cli.spec.test.ts`.
- Init integration in `apps/server/tests/integration/init.spec.test.ts`.

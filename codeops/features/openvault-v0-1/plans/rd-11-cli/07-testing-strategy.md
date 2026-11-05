# Testing Strategy: RD-11 CLI

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Credential store, lock, paths, password input | 95% |
| Dispatcher, global options, output, exit codes | 95% |
| HTTPS adapter and client refresh | 90% |
| Command handlers | 90% |
| Contract builder and generated client check | 95% |
| Init keyring/CA/TLS/admin | 90% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- CLI tests use real filesystem temp directories, real `node:https` servers with a generated CA,
  and real child processes. No mocked TLS or filesystem.
- The real-server end-to-end tests live in `apps/server/tests/integration/cli.spec.test.ts` and
  spawn the built `apps/cli/dist/main.js` against the real server and PostgreSQL.
- Init tests live in `apps/server/tests/integration/init.spec.test.ts` with a real database and
  temp keyring/TLS files.
- Docker Compose E2E is out of scope because the image is RD-14 (AR-28).

## 🚨 Specification Test Cases (MANDATORY — NON-NEGOTIABLE)

> These cases derive from `RD-11-cli.md`, the plan specs, and the Ambiguity Register.
> They are the immutable oracle. If the implementation differs, the implementation is wrong.
> In-code traceability comments restate the behavior in plain language, never an ST/RD id.

### Credential Store

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | `XDG_CONFIG_HOME` set | Path is `$XDG_CONFIG_HOME/openvault/credentials.json` | RD-11 credential storage, AR-8 |
| ST-2 | Linux without XDG | Path is `~/.config/openvault/credentials.json` | AR-8 |
| ST-3 | macOS | Path is `~/Library/Application Support/openvault/credentials.json` | AR-8 |
| ST-4 | Windows | Path is `%APPDATA%\openvault\credentials.json` | AR-8 |
| ST-5 | First save | Directory `0700`, file `0600`, complete JSON, no partial destination | AR-8 |
| ST-6 | Existing file replaced | Temp file + fsync + rename; the old complete document remains on a pre-rename failure | AR-8 |
| ST-6a | Existing config directory `0755` or a directory symlink | `credential_store_insecure`; no read or write | AR-55 |
| ST-7 | File is a symlink | `credential_store_insecure`; no write and no silent repair | AR-8 |
| ST-8 | File mode `0644` | `credential_store_insecure`; no write | AR-8 |
| ST-9 | File owned by another UID | `credential_store_insecure`; no write | AR-8 |
| ST-10 | Unknown version or corrupt JSON | `credential_store_corrupt`; no repair | AR-8 |
| ST-11 | Unknown field in the document | Rejected as corrupt | AR-8 |
| ST-12 | `load` on a missing file | Returns undefined; authenticated commands map to `authentication_required` | AR-8 |
| ST-13 | `remove` | Credential and lock files are gone; missing files are not an error | AR-8 |
| ST-14 | Two writers | One waits; the lock file is `0600`; both complete without interleaving | AR-9 |
| ST-14a | Logout races a refresh | Logout holds the lock; no rotated token is saved after removal; the file is gone | AR-9 |
| ST-14b | Stale lock takeover | Only a dead PID **and** age > 60s is stale; a live lock is never unlinked; the owner token controls cleanup | AR-9 |
| ST-15 | Lock held by a dead PID | Stale lock is removed and the action runs | AR-9 |
| ST-16 | Lock held by a live PID | Waits up to 5 seconds, then `credential_store_locked` | AR-9 |
| ST-17 | Concurrent refresh | Read-refresh-write is serialized; the second process uses the rotated token | AR-9, AR-12 |
| ST-18 | Native Windows write | `credential_store_unsupported`; no file is created | AR-10 |
| ST-19 | Hidden prompt on a TTY | No echo; backspace/Ctrl-C handled; terminal restored | AR-15 |
| ST-20 | Non-TTY stdin | Reads one value with a 1024-character bound; empty input is `validation_error` | AR-15 |

### Dispatcher and Output

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-21 | `ov --help` | Lists every group and command; exit 0 | RD-11 acceptance 1, AR-38 |
| ST-22 | `ov --version` | Prints the package version; exit 0 | AR-38 |
| ST-23 | Unknown group | Root help and exit 2 | AR-4 |
| ST-23a | Single-command groups (`init`, `doctor`, `completion`, `backup`, `restore`, `kek rotate`) | The sole command runs without a second command token (default command) | AR-51 |
| ST-23b | `ov secret get --help` | Group help is printed, not root help | AR-38 |
| ST-24 | Unknown option in a group | Parser help and exit 2; no handler runs | AR-4 |
| ST-25 | Global `--json` before or after the group | Both parse; output is JSON | AR-13 |
| ST-26 | Repeated global option | Usage error, exit 2 | AR-13 |
| ST-27 | `ov project create payments` | Rewritten to `create --name payments` | AR-5 |
| ST-28 | `ov secret set db-password --stdin` | Rewritten to `set --name db-password --stdin` | AR-5 |
| ST-29 | `ov role grant api secrets.reader` | Rewritten to `grant --principal api --role secrets.reader` | AR-5 |
| ST-30 | `ov run --project payments -- ./start.sh` | Global options before `--`; child args after `--` unchanged | RD-11 acceptance 3, AR-17 |
| ST-31 | `--` in a non-run group | Usage error, exit 2 | AR-4 |
| ST-32 | Success with `--json` | stdout is `{success:true,data}` and stderr is empty | RD-11 acceptance 4 |
| ST-33 | Error with `--json` | stderr is `{success:false,error:{code,message,requestId?}}`; stdout empty | RD-11 acceptance 4 |
| ST-34 | Human error | stderr is `code: message (request …)`; stdout empty | AR-13 |
| ST-35 | 401/403/404/409/422/429/5xx | Exit codes 3/4/5/6/2/1/1 | AR-13 |
| ST-36 | `--verbose` success/failure | JSON events with method, path, status, request id, duration; no body/header/token/value | AR-24 |
| ST-37 | Destructive command interactive | Prompts; `n` aborts with exit 1 and no mutation | RD-11 acceptance 5, AR-14 |
| ST-38 | Destructive command with `--yes` | No prompt; mutation proceeds | AR-14 |
| ST-39 | Destructive command non-interactive without `--yes` | Exit 2; no mutation | AR-14 |

### Transport and Client

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-40 | Trusted CA | Request succeeds; TLS 1.2+ and hostname verification | AR-11 |
| ST-41 | Untrusted CA | `tls_verification_failed`, exit 1 | AR-11 |
| ST-42 | Hostname mismatch | `tls_verification_failed`, exit 1 | AR-11 |
| ST-43 | Timeout | `request_timeout`, exit 1 | AR-11 |
| ST-44 | 3xx response | No redirect followed; error with the status | AR-11 |
| ST-45 | JSON response over 1 MiB | `response_too_large`, exit 1 | AR-11 |
| ST-46 | Non-JSON error body | Status and code are still mapped; no HTML is printed | AR-11 |
| ST-47 | Access token expired, refresh succeeds | Request retries once with the new token; credential file is updated | AR-12 |
| ST-48 | Refresh returns 401 | `authentication_required`, exit 3; no recursive refresh | AR-12 |
| ST-49 | Two concurrent 401s | One single-flight refresh; both retries use the new token | AR-12 |
| ST-50 | 429 with `Retry-After: 1` | The adapter retries once after about 1 second, then succeeds | AR-25, AR-44 |
| ST-51 | 429 twice | `rate_limited`, exit 1 | AR-25 |
| ST-52 | Audit export stream | Streams to a temp file, checks 2xx + `application/x-ndjson`, renames to a `0600` target; partial removed on failure | AR-19, AR-58 |
| ST-53 | Audit export target exists | `file_exists` unless `--force`; a failed forced export preserves the old file | AR-19, AR-58 |
| ST-53a | Missing/insecure credential file or TLS failure | The CLI wrapper maps to `authentication_required`/`tls_verification_failed`, not a raw `ApiTransportError` | AR-44 |
| ST-53b | Secure `probe`/`download` | Both send the explicit bearer header; `/ready` sends none | AR-45 |

### Auth Commands

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-54 | `ov login` with identifier and stdin password | Calls `loginCli`; saves both tokens and expiries; prints the user without tokens | RD-11 acceptance 1, AR-8 |
| ST-55 | `ov login` bad credentials | Generic `invalid_credentials`, exit 3; no credential file | AR-8 |
| ST-56 | `ov login` URL is HTTP or has a path | `usage_error`, exit 2 | AR-8 |
| ST-57 | `ov whoami` | Calls `getCliMe`; prints the user; warns when `mustChangePassword` | RD-11 acceptance 1 |
| ST-58 | `ov logout` with network | Calls `logoutCli`, removes credentials and lock; exit 0 | RD-11 acceptance 6, AR-8 |
| ST-59 | `ov logout` offline | Removes local files; warns that the family may remain; exit 0 | RD-11 acceptance 6 |
| ST-60 | `ov auth sessions` | Lists family ids, timestamps, and current flag; never tokens | RD-11 acceptance 11 |
| ST-61 | `ov auth sessions --revoke <id>` | Calls the delete route; prints revoked | RD-11 acceptance 11 |
| ST-62 | `ov auth sessions --revoke` with no value | Usage error, exit 2 | AR-4 |

### Project and Secret Commands

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-63 | `ov project list` | Table/JSON from `listProjects` | RD-11 acceptance 1 |
| ST-64 | `ov project create payments` | `createProject`; prints the project | RD-11 acceptance 1 |
| ST-65 | `ov project delete payments --yes` | Resolves the name to its ULID, deletes by ID | AR-22 |
| ST-66 | `ov project delete missing` | `project_not_found`, exit 5 | AR-22 |
| ST-67 | `ov secret set db-password --stdin` | Value from stdin; create/update; value never in argv or output | RD-11 acceptance 2, AR-15 |
| ST-68 | `ov secret set db-password --from-file value.txt` | Reads a regular file; rejects a directory or oversize file | AR-15 |
| ST-69 | Existing secret `set` | Calls `writeSecretValue`; prints the version id | AR-16 |
| ST-70 | Missing secret `set` | Calls `createSecret` after the 404 | AR-16 |
| ST-71 | Create/update race | One conflict retry; separate idempotency keys for PUT/POST; no duplicate version | AR-16 |
| ST-71a | `secret set` with `--tag`/`--content-type` on an existing secret | Value write then metadata PATCH; metadata actually changes; a PATCH failure is reported | AR-48 |
| ST-72 | `ov secret get` | Prints only the value in human mode; JSON includes the full response | RD-11 acceptance 1 |
| ST-73 | `ov secret get --out file` | Writes decoded bytes with mode `0600`; prints the path | AR-15 |
| ST-74 | `ov secret list --tag-key a --tag-value b` | Passes the query fields | AR-13 |
| ST-75 | `ov secret versions` | Prints version history | RD-11 acceptance 1 |
| ST-76 | `ov secret delete --yes` / `recover` / `purge --yes` | Calls the correct route and prints the result | RD-11 acceptance 1 |
| ST-77 | Secret value not found | `secret_not_found`, exit 5 | AR-13 |

### Certificate, Identity, Role, Access Commands

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-78 | `ov cert import api --cert leaf.pem --key key.pem` | Reads files, calls import, prints fingerprint and warnings | RD-11 acceptance 1, AR-15 |
| ST-79 | Missing `--cert` or `--key` | Usage error, exit 2; no API call | AR-13 |
| ST-80 | `ov cert generate api --subject CN=api --san DNS:api` | Calls generate with defaults/overrides | RD-11 acceptance 1 |
| ST-81 | `ov cert get api` | Prints the public chain only | AR-15 |
| ST-82 | `ov cert get api --private-key --out key.pem` | Calls the private-key route, writes `0600`, warns on stderr | AR-47 |
| ST-82a | `ov cert get api --private-key` without `--out` | Usage error, exit 2; no key printed | AR-47 |
| ST-83 | `ov cert list --expires-before …` | Passes query filters | AR-13 |
| ST-84 | `ov cert delete --yes` | Calls delete | RD-11 acceptance 1 |
| ST-85 | `ov identity create api` | Resolves the project ULID and creates the identity | AR-22 |
| ST-86 | `ov identity list` | Resolves the project and lists | AR-22 |
| ST-87 | `ov identity revoke api --yes` | Resolves the name or ULID and revokes | AR-22 |
| ST-88 | `ov identity join-token api` | Prints the token once with a warning; JSON includes it | RD-11 acceptance 1 |
| ST-89 | `ov role grant api secrets.reader --project payments` | Resolves the identity and project, creates the assignment | AR-23 |
| ST-90 | `ov role grant --scope object --object-type secret --object db-password` | Resolves the secret id and creates an object grant; a certificate with the same name is not selected | AR-50 |
| ST-91 | `ov role revoke` with one match | Confirms and deletes | AR-23 |
| ST-92 | `ov role revoke` with several matches | Exit 2 and lists assignment ids | AR-23 |
| ST-93 | `ov role revoke --assignment <id>` | Deletes the named assignment after verification | AR-23 |
| ST-94 | `ov access explain db-password` | Resolves the id through `listSecrets` only; default `secret.read`; prints principals/roles/assignments/consumers; an auditor without `secret.read` succeeds | RD-11 acceptance 9, AR-21 |
| ST-95 | `ov access explain api --target-type certificate` | Resolves certificate id; default `certificate.read` | AR-21 |
| ST-96 | `ov access explain payments --target-type project` | Resolves project id; default `project.read` | AR-21 |

### Audit, Scaffold, Run, Init, and Deferred Commands

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-97 | `ov audit list --project payments --from …` | Resolves the project name to a ULID and passes `projectId`; table/JSON | RD-11 acceptance 1, AR-49 |
| ST-98 | `ov audit verify` ok | Prints ok and exits 0 | RD-11 acceptance 8 |
| ST-99 | `ov audit verify` broken | stderr shows reason and first bad id; exit 1 | RD-11 acceptance 8 |
| ST-100 | `ov audit export --out audit.ndjson` | Streams NDJSON to a `0600` file; prints bytes | AR-19 |
| ST-101 | `ov docker scaffold payments api --secret db-password` | Validates paths first, calls scaffold, writes compose and manifest, prints token once; files contain no token | RD-11 acceptance 7, AR-18, AR-46 |
| ST-101a | Scaffold target exists without `--force` | Exits 1 before the API call; the old token remains valid | AR-46 |
| ST-101b | `--compose-project ../escape` | Rejected by the Compose-name schema; no file outside `--out` | AR-46 |
| ST-102 | Scaffold re-run | Reuses project/identity/assignments; issues a fresh token; files overwritten only with `--force` | AR-18 |
| ST-103 | Scaffold output file exists without `--force` | `file_exists`, exit 1; API call may have happened, no write | AR-18 |
| ST-104 | `ov run` required success | Child sees the file and env; temp directory removed after exit | RD-11 acceptance 3, AR-17 |
| ST-105 | `ov run` required 404 | Child never starts; exit 1 | AR-17 |
| ST-106 | `ov run` optional 404 | Child starts without that file/env; warning | AR-17 |
| ST-107 | `ov run` child exit 7 | CLI exits 7 and cleans the temp directory | AR-17 |
| ST-108 | `ov run` SIGINT | Child receives SIGINT; temp directory removed | AR-17 |
| ST-109 | `ov run` binary env value | Required binary env fails; optional degrades; no invalid UTF-8 exported | AR-17 |
| ST-110 | `ov init --prepare` twice | One keyring, one current CA, one org, one admin, one assignment, one signing key, matching TLS pair; CA unchanged; no second password file | RD-11 acceptance 13, AR-33–AR-36, AR-39 |
| ST-110a | Two concurrent `init` processes | One keyring/CA/admin; the loser converges or waits; no undecryptable row | AR-39 |
| ST-110b | Keyring missing but wrapped rows exist | Fails closed with a restore-from-backup message; writes no new keyring | AR-33 |
| ST-110c | Existing server certificate expired or SAN/chain mismatch | Expired leaf is regenerated from the same CA; SAN/CA mismatch fails closed | AR-35 |
| ST-110d | Existing TLS key mode `0644` | Fails closed; no reuse | AR-35 |
| ST-110e | `--password-file` with 1–11 characters | `validation_error`; no admin created | AR-34 |
| ST-110f | Admin already exists, `--generate-password` rerun | No new password file is written; warning | AR-34 |
| ST-110g | `--org Custom` | The org row name is updated; one admin assignment; policy version bumped | AR-43 |
| ST-111 | Init with an existing keyring `0644` | Fails closed; no CA or admin write | AR-33 |
| ST-112 | Init with one TLS file present | Fails closed; no regeneration | AR-35 |
| ST-113 | Init generated password | One-time file `0600`; password absent from stdout/stderr; `must_change` true | RD-11 acceptance 12, AR-34 |
| ST-114 | Init operator password file | Uses the value; `must_change` false; no output copy | AR-34 |
| ST-115 | Init CA public paths | Writes both `OPENVAULT_INTERNAL_CA` and `OPENVAULT_CA_PUBLIC_DIR/ca.pem` when set | AR-36 |
| ST-116 | `ov backup`, `ov restore`, `ov kek rotate` | Parse, prompt as applicable, then `not_implemented` exit 1; root help marks `[RD-13]`; the final report states the named deferral | AR-2 |
| ST-117 | `ov doctor` ready/credentials/clock | One line per check; exit 1 if any fails; JSON shape | AR-26 |
| ST-118 | `ov completion bash/zsh/fish` | Static script contains every group; unknown shell exit 2 | AR-27 |
| ST-119 | `pnpm api:check` clean | Exit 0 | RD-11 acceptance 10 |
| ST-120 | One generated file mutated | `pnpm api:check` exits 1 and names the file | RD-11 acceptance 10 |

### Preflight-Fix Regression Cases

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-128 | `ov auth sessions --revoke <id>` non-interactive without `--yes` | Exit 2; no server call | AR-14 |
| ST-129 | `ov init` with `OPENVAULT_DB_URL` and a conflicting explicit URL | There is no explicit URL option; the environment value is the only source | AR-40 |
| ST-130 | Init CA signing | `issueServerCertificate` unwraps, signs, and zeroes the scalar; init never receives the scalar | AR-41 |
| ST-131 | Init and server file ownership | The keyring/TLS files are readable by the same UID; a mismatch fails server startup | AR-42 |
| ST-132 | Run manifest over 1 MiB or duplicate YAML keys | `agent_manifest_invalid` equivalent; no child starts | AR-57 |
| ST-133 | Run manifest env includes `NODE_PATH` or `SSL_CERT_FILE` | Rejected as a loader variable | AR-57 |
| ST-134 | Run spawn failure | Temp directory removed; no child | AR-57 |
| ST-135 | Scaffold `--compose-project` traversal | Rejected by the Compose-name schema; no file outside `--out` | AR-46 |
| ST-136 | Generated artifacts and `biome check` | `apps/cli/src/generated/**` and `openapi.json` are ignored; `api:check` owns them | AR-52 |
| ST-137 | CLI E2E binary path | `apps/server/tests/integration/cli.spec.test.ts` spawns the built binary; `pnpm build` precedes it | AR-53 |
| ST-138 | `ov login` against the reference stack | Uses the proxy public root CA, not the OpenVault internal CA | AR-56 |
| ST-139 | Secret metadata PATCH failure after value write | Value remains; metadata error reported; no rollback claim | AR-48 |
| ST-140 | Audit export 403 JSON body | Not written to the target; exit 1; previous export preserved | AR-58 |
| ST-141 | TTY name/value with ESC | Escaped in tables; raw only for the explicit value surface | AR-54 |

### Cross-Cutting Security

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-121 | Captured argv for every command | No secret value, private key, password, or token appears | RD-11 acceptance 12 |
| ST-122 | Captured stdout/stderr and verbose events | No value, PEM, password, token, or request body | RD-11 acceptance 12, AR-24 |
| ST-123 | Credential file after login | Contains only version, baseUrl, tokens, expiries; mode `0600` | AR-8 |
| ST-124 | `ov secret get --json` | The value is present because the user explicitly requested JSON; no other command prints it | AR-15 |
| ST-125 | `ov docker scaffold --json` | Token is present because the user explicitly requested JSON; files still contain none | AR-18 |
| ST-126 | Error from a server 500 | No stack trace, database detail, token, or value; request id when present | AR-13 |
| ST-127 | Native Windows credential store | Fails closed before any write | AR-10 |

## Test Categories

### Specification Tests

| Test File | ST Cases | Component |
|---|---|---|
| `apps/cli/tests/credentials.spec.test.ts` | ST-1–ST-20 | Credential paths, store, lock, password |
| `apps/cli/tests/dispatcher.spec.test.ts` | ST-21–ST-39 | Dispatcher, output, exit codes, prompts |
| `apps/cli/tests/transport.spec.test.ts` | ST-40–ST-53 | HTTPS adapter, refresh, retry, streaming |
| `apps/cli/tests/auth-commands.spec.test.ts` | ST-54–ST-62 | Auth commands |
| `apps/cli/tests/project-secret-commands.spec.test.ts` | ST-63–ST-77 | Project and secret commands |
| `apps/cli/tests/cert-identity-role-access.spec.test.ts` | ST-78–ST-96 | Certificate, identity, role, access |
| `apps/cli/tests/audit-scaffold-run.spec.test.ts` | ST-97–ST-109 | Audit, scaffold, run |
| `apps/cli/tests/init-deferred-doctor.spec.test.ts` | ST-116–ST-118, ST-128–ST-134 | Init mapping, deferred commands, doctor, completion |
| `apps/server/tests/api-contract.spec.test.ts` | ST-119–ST-120 | Contract build, generation, drift |
| `apps/server/tests/integration/cli.spec.test.ts` | ST-54, ST-63–ST-77, ST-97–ST-101 | Real-server binary E2E |
| `apps/server/tests/integration/init.spec.test.ts` | ST-110–ST-115, ST-128–ST-135 | Real bootstrap |

### Implementation Tests

| Test File | Description | Priority |
|---|---|---|
| `apps/cli/tests/credentials.impl.test.ts` | Atomic rename failure, fsync, stale lock PID reuse, corrupt token fields | High |
| `apps/cli/tests/https-adapter.impl.test.ts` | Bound edges, abort, socket errors, header handling | High |
| `apps/cli/tests/secret-input.impl.test.ts` | File descriptor, base64 size, tag limits | High |
| `apps/cli/tests/run.impl.test.ts` | Manifest edges, temp cleanup, signal forwarding | High |
| `apps/cli/tests/scaffold.impl.test.ts` | File naming, template substitution, force | High |
| `apps/server/tests/integration/init.impl.test.ts` | CA match, keyring mode, TLS mismatch, concurrent admin | High |
| `apps/server/tests/api-contract.spec.test.ts` | Document shape, security, operation ids, no internal routes | High |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Real-server CLI E2E | Built `ov`, real server, PostgreSQL | Login, whoami, project/secret, identity/role/access, audit, scaffold |
| Init + server startup | `runInit`, migrations, keyring/CA/TLS, server config | Init then start readiness-style checks |
| Contract drift | Controllers, metadata table, generated artifacts | Clean check, mutation drift, stale marker |

### End-to-End Tests

| Scenario | Steps | Expected Result |
|---|---|---|
| Login and secret round trip | `ov login`, `ov secret set`, `ov secret get` | Value reads back; no token/value in logs; credential mode `0600` |
| Scaffold and identity grant | Create project/secret, scaffold, inspect DB | Object-scope reader only; token printed once |
| Audit verify | Read a secret, verify | Exit 0; broken chain (seeded) exits 1 |
| Run child | Manifest with file/env, child writes its view | Only manifest values; temp dir removed |

## Test Data

### Fixtures Needed

- A disposable CA and server certificate for the fake HTTPS server.
- A fake HTTPS vault that records method, path, headers, body, and can return 200/201/204/
  401/403/404/409/422/429/5xx, drop the socket, delay, or stream NDJSON.
- Temporary `HOME`/`XDG_CONFIG_HOME`, cwd, manifest, cert/key/value files.
- A sentinel secret value, password, and token for leakage assertions.
- A test database and migrations for init and real-server E2E.

### Mock Requirements

No core component is mocked. The fake vault is a real HTTPS server; the filesystem is real;
the child process is real; PostgreSQL is real. Only the clock, TTY boundary, and process
boundary are injectable.

## Verification Checklist
- [ ] All ST cases trace to a requirement, spec doc, or AR entry
- [ ] Specification tests written before implementation and fail for the right reason
- [ ] All specification tests pass after implementation
- [ ] Implementation tests cover edge cases and internals
- [ ] No regressions in existing tests
- [ ] `pnpm verify` (including `pnpm api:check`), `pnpm db:types:check`,
      `pnpm changeset status`, `pnpm audit:prod`, and the docs build pass
- [ ] Integration suite passes on PostgreSQL 16 and 17
- [ ] Captured argv/log/output assertions prove no secret leakage

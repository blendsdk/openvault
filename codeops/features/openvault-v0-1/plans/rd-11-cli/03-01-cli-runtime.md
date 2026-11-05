# CLI Runtime: RD-11 CLI

> **Document**: 03-01-cli-runtime.md
> **Parent**: [Index](00-index.md)

## Overview

This component is the `apps/cli` package: the `ov` binary, global options, the group
dispatcher, the protected credential store, the HTTPS transport, the authenticated generated
client, output rendering, and exit codes. It is the only place where a CLI token or a user
password exists.

## Architecture

```text
apps/cli/src/
├── main.ts              # bin entry; process exit code only
├── cli.ts               # runCli(argv, runtime): dispatcher, error mapping
├── dispatcher.ts        # global extraction, group selection, positional rewriting
├── config.ts            # base URL, CA path, credential path, runtime defaults
├── errors.ts            # CliError, stable codes, exit-code mapping
├── output.ts            # human and JSON envelopes, redacted verbose events
├── credentials/
│   ├── paths.ts         # XDG / macOS / Windows precedence
│   ├── store.ts         # versioned credential JSON, atomic secure writes
│   ├── lock.ts          # credentials.lock, stale recovery
│   └── password.ts      # hidden TTY prompt, stdin/file reads
├── transport/
│   └── https-adapter.ts # node:https, CA trust, bounds, streaming download
├── client/
│   ├── authenticated.ts # generated client + BearerAuth + refresh
│   └── anonymous.ts     # login/refresh/logout runtime
├── commands/            # one module per group; see 03-03
├── run/                 # CLI run manifest and child lifecycle
└── generated/           # generated typed client; see 03-02
```

The package is `@openvault/cli`, private, ESM, NodeNext, TypeScript 7.0.2. It builds to `dist/`
and exposes `bin.ov = "./dist/main.js"`. It shares contracts from `@openvault/api-contract` and
the bootstrap primitive from `@openvault/server/init`.

## Implementation Details

### Runtime injection

`runCli(argv, runtime)` is the single testable entry point.

```ts
/** Everything the CLI needs from the process boundary. */
export interface CliRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin: NodeJS.ReadableStream;
  readonly isTty: boolean;
  readonly now?: () => number;
  /** Injected only by tests; production calls the real bootstrap. */
  readonly runInit?: (options: InitOptions) => Promise<InitResult>;
}

/**
 * Runs one invocation.
 *
 * @param argv - Arguments after the executable.
 * @param runtime - Process boundary.
 * @returns Process exit code.
 */
export async function runCli(
  argv: readonly string[],
  runtime?: CliRuntime,
): Promise<number>;
```

`main.ts` sets `process.exitCode = await runCli(process.argv.slice(2))` and never calls
`process.exit`, so a pending stdout flush completes.

### Global options

The top-level dispatcher accepts these options anywhere before `--`:

| Option | Meaning | Default |
|---|---|---|
| `--json` | JSON output | human |
| `--yes` | Skip destructive prompts | prompt |
| `--verbose` | Structured request events on stderr | off |
| `--project <name>` | Project context | none |
| `--org <name>` | Organization context (reserved) | none |
| `--ca <path>` | CA bundle for server verification | `OPENVAULT_CA_FILE` |
| `--url <url>` | Server base URL for login/doctor | stored / `OPENVAULT_URL` |
| `--timeout <seconds>` | Request timeout, 1–120 | 15 |
| `-h`, `--help` | Root help or group help | — |

Global extraction removes these tokens from the group arguments. A repeated option is a usage
error. `--` stops extraction and is preserved for `ov run`.

### Dispatcher

```ts
/** One command group. */
export interface CommandGroup {
  readonly name: string;
  readonly summary: string;
  readonly createParser: (globals: GlobalOptions) => CommandLineParser;
  /** Leading positional names, in canonical option order. */
  readonly positionals?: readonly string[];
}

/**
 * Dispatches one invocation.
 *
 * @param argv - Arguments after the executable.
 * @param runtime - Process boundary.
 * @returns Exit code.
 */
export async function dispatch(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number>;
```

Rules:

1. `argv` empty or `--help`/`-h` at the top level prints root help and returns 0.
2. `--version` prints the package version and returns 0.
3. The first non-option token is the group. An unknown group prints root help and returns 2.
4. The remaining tokens are split at `--` only for the `run` group; for every other group a
   `--` is a usage error.
5. Leading non-option tokens after the group command are rewritten to the group's canonical
   options, in order, for example `project create payments` → `create --name payments`.
6. The group parser is a strict `CommandLineParser`; call `execute({ globals, runtime }, { argv, write })` — context is the first argument and the invocation overrides are the second.
7. `CommandLineValidationError` maps to exit 2 and writes the parser's rendered help plus the
   first issue to stderr. No handler runs after invalid input.
8. Single-command groups (`init`, `doctor`, `completion`, `backup`, `restore`, and the `kek`
   subcommand) register their sole command with `default: true`, or the dispatcher injects the
   command token before parsing.
9. `--help` after a group is passed to the group parser (never consumed by global extraction);
   a clean help request exits 0.

Root help lists every group and its commands in a stable order. Group help comes from
`cmdline`.

### Credential paths

`resolveCredentialPath(env, platform)` implements AR-8:

| Platform | Path |
|---|---|
| `XDG_CONFIG_HOME` set | `$XDG_CONFIG_HOME/openvault/credentials.json` |
| Linux | `~/.config/openvault/credentials.json` |
| macOS | `~/Library/Application Support/openvault/credentials.json` |
| Windows | `%APPDATA%\openvault\credentials.json` |

The directory is `0700`; the file and lock are `0600`. A relative `XDG_CONFIG_HOME`, a missing
home, or a non-absolute `APPDATA` fails closed with `credential_store_unavailable`.

### Credential document

```ts
/** The only persisted credential shape. */
export interface CredentialDocument {
  readonly version: 1;
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
}
```

- `version` is exactly `1`; any other value fails closed with `credential_store_corrupt`.
- `baseUrl` is an HTTPS origin without credentials, path, query, or fragment.
- Tokens are non-empty strings; expiries are ISO timestamps.
- Unknown fields are rejected, so a future field cannot be silently ignored.

### Secure writes and reads

`CredentialStore` is the only reader/writer.

- `load()`: `lstat` the directory and require a real directory, owner = current UID, mode
  exactly `0700`, not a symlink. Open the file with `O_RDONLY | O_NOFOLLOW`; `fstat`; require a
  regular file, current UID where available, and exact mode `0600`; parse and validate;
  otherwise `credential_store_insecure` or `credential_store_corrupt`. Never repair silently.
- `save(document)`: validate the directory as above (create `0700` only when absent), write a
  temporary file in the same directory with `O_CREAT|O_EXCL|O_WRONLY` mode `0600`, write the
  complete JSON, `fsync`, `rename`, `fsync` the directory. On POSIX, `fchmod` the temporary
  file. Never truncate the destination.
- `remove()`: unlink the credential file; missing files are not an error. It does not unlink a
  lock it does not own. `logout` calls it while holding the lock.
- `withLock(action)`: open `credentials.lock` with `wx`, mode `0600`, and write
  `{pid, createdAt, owner}` where `owner` is 16 random bytes. Wait 25–250 ms between attempts
  for at most 5 seconds. A lock is stale only when the recorded PID is dead **and** the file is
  older than 60 seconds. Stale cleanup is serialized by a `credentials.lock.reclaim` directory
  guard; while the guard is held, re-read the lock and remove it only if it is still stale.
  A live lock is never renamed or unlinked. Run the action; in `finally`, unlink only when the
  file's `owner` equals this process's owner. A timeout is `credential_store_locked`.
- Login, logout, save, and refresh are locked critical sections. Refresh is
  `load → server refresh → save`. A 401 clears nothing but returns `authentication_required`
  with a re-login message.
- If `load()` fails during `logout`, still attempt to remove the file and report the local
  removal result; a corrupt or loose file must not make the tokens impossible to delete.

Native Windows fails closed with `credential_store_unsupported` before any write, because the
CLI cannot enforce an owner-only ACL with Node primitives and an untested `icacls` path is
worse than a clear refusal (AR-10). WSL uses the POSIX path.

### Password input

```ts
/** Reads a password without echo when the input is a TTY. */
export function readPassword(options: {
  readonly stdin: NodeJS.ReadableStream;
  readonly isTty: boolean;
  readonly prompt: string;
  readonly stderr: (text: string) => void;
}): Promise<string>;
```

- TTY: raw mode, no echo, handle backspace and Ctrl-C, restore the terminal in `finally`.
- Non-TTY: read the first line (or the whole input when no newline) with a 1024-character
  bound. An empty value fails with `validation_error`.
- The password is never written to stdout/stderr, argv, or an environment variable.

### HTTPS adapter

```ts
/** Options for the CLI transport. */
export interface HttpsAdapterOptions {
  readonly baseUrl: string;
  readonly caPem?: string;
  readonly timeoutMs?: number;
  readonly maxJsonBytes?: number;
}

/** A non-streaming probe response. */
export interface ProbeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
}
```

`HttpsAdapter implements RequestAdapter`:

- `node:https.request` with `rejectUnauthorized: true`, `minVersion: "TLSv1.2"`, SNI from the
  base URL host, optional `ca`, and `timeout` (default 15 seconds).
- No redirects: a 3xx is returned as a non-2xx response and becomes an `ApiError`.
- JSON requests use `Content-Type: application/json`; the body is bounded at 1 MiB.
- JSON responses are bounded at 1 MiB; a larger body is an `ApiTransportError` with
  `response_too_large`. The audit export uses `download()`, which streams to a file with a
  100 MiB bound and never buffers the whole body.
- A non-JSON body is returned as text so an HTML proxy error still yields a status.
- `probe(path, headers?)` performs a GET with optional explicit headers and returns status,
  headers, and body for `ov doctor`.
- `download(path, target, { headers, force })` writes to a temporary file in the target
  directory, checks that the status is 2xx and the content type is `application/x-ndjson`,
  streams bytes, `fsync`s, and renames; an existing target is replaced only with `force`. On a
  non-2xx or stream failure it unlinks the temporary file and preserves the previous target.
- `send()` performs the single 429 retry because only the adapter sees `Retry-After`. It waits
  `min(Retry-After, 5s)` and retries once; a second 429 surfaces `rate_limited`.

### Authenticated client

```ts
/** Builds the client for one invocation. */
export async function createAuthenticatedClient(options: {
  readonly credentials: CredentialStore;
  readonly transport: HttpsAdapter;
  readonly runtime: CliRuntime;
}): Promise<OpenVaultClient>;

/** Builds the unauthenticated client used by login/refresh/logout. */
export function createAnonymousClient(transport: HttpsAdapter): OpenVaultClient;
```

- `BearerAuth.getToken` reads the credential document and returns `accessToken`.
- The client wrapper exposes `authHeaders()` returning an `Authorization: Bearer <token>` map
  for `probe` and `download`; the adapter never stores a token.
- `BearerAuth.refresh` runs the locked refresh flow and returns the new access token.
- The runtime's 401 retry calls refresh at most once per request.
- The refresh flow uses the anonymous client so a failed refresh cannot recurse.
- The credential file is preflighted before the client is created. A missing file is
  `authentication_required` (exit 3) with the message `Run ov login`.
- `blendsdk/api-client` wraps token-provider and adapter failures in `ApiTransportError`. Every
  generated call goes through a CLI mapper that recognizes `CliError`, `ApiError`, and
  `ApiTransportError`; a sentinel `RefreshRejectedError` from the refresh callback maps to exit
  3, and known cause codes (`CERT_*`, `ERR_TLS_*`, `ECONNREFUSED`, timeout, oversize) map to the
  documented CLI codes. The mapper never prints a raw cause message.

### Output and errors

```ts
/** One stable CLI failure. */
export class CliError extends Error {
  public constructor(
    public readonly code: CliErrorCode,
    message: string,
    public readonly options?: {
      readonly exitCode?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      readonly requestId?: string;
      readonly details?: unknown;
    },
  );
}
```

Success:

```json
{ "success": true, "data": { "…": "…" } }
```

Error on stderr:

```json
{ "success": false, "error": { "code": "secret_not_found", "message": "Secret not found", "requestId": "…" } }
```

`requestId` is omitted when absent. `ApiError` maps by status: 401→3, 403→4, 404→5, 409→6, 422→2,
429→1, 5xx→1; `ApiTransportError`→1. `CommandLineValidationError`→2. `CliError` uses its own
code.

`--verbose` writes one JSON event to stderr per request with `event`, `method`, `path`,
`status`, `requestId`, and `durationMs`. It never includes headers, bodies, tokens, passwords,
values, or PEM. `--json` output is one JSON document per invocation.

When stdout or stderr is a TTY, table cells and names escape C0/C1/ESC so a user-controlled
name cannot inject terminal control sequences. The raw value from `secret get` without `--out`
and any `--json` payload are the explicit value surfaces and are not table-escaped.

## Code Examples

### Login

```ts
const anonymous = createAnonymousClient(transport);
const tokens = await anonymous.auth.loginCli({ identifier, password });
await credentials.save({
  version: 1,
  baseUrl,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  accessExpiresAt: tokens.accessExpiresAt,
  refreshExpiresAt: tokens.refreshExpiresAt,
});
```

### Authenticated read

```ts
const client = await createAuthenticatedClient({ credentials, transport, runtime });
const secret = await client.secrets.getSecret({
  project: "payments",
  name: "db-password",
});
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Missing credential file | `authentication_required`, exit 3 | AR-8 |
| Symlink / wrong owner / loose mode | `credential_store_insecure`, exit 1, no repair | AR-8 |
| Corrupt JSON or version | `credential_store_corrupt`, exit 1 | AR-8 |
| Lock timeout | `credential_store_locked`, exit 1 | AR-9 |
| Native Windows | `credential_store_unsupported`, exit 1 | AR-10 |
| Logger/token injection via table | TTY escaping; no control sequences | AR-54 |
| TLS trust failure | `tls_verification_failed`, exit 1 | AR-11 |
| Response over bound | `response_too_large`, exit 1 | AR-11 |
| 401 after one refresh | `authentication_required`, exit 3 | AR-12 |
| 429 after one retry | `rate_limited`, exit 1 | AR-25, AR-44 |
| Raw runtime transport error | Mapped to a stable CLI code; no raw cause text | AR-44 |
| Loose config directory | `credential_store_insecure`, exit 1 | AR-55 |
| Invalid group/options | Parser help, exit 2 | AR-13 |
| Destructive without `--yes` | `confirmation_required`, exit 2 | AR-14 |

## Testing Requirements
- Credential path precedence on Linux/macOS/Windows; XDG override; missing home.
- Directory `0700`, file/lock `0600`, atomic replacement, symlink and owner rejection, corrupt
  version, lock contention, stale lock, concurrent refresh.
- Hidden password prompt with a fake TTY, stdin, and empty input.
- HTTPS adapter with a real generated CA: success, untrusted CA, hostname mismatch, timeout,
  redirect refusal, oversized JSON, streaming export, and non-JSON error body.
- Client refresh: one retry, no recursion, missing-file handling.
- Dispatcher: global extraction, positionals, unknown group, root/group help, `--` handling.
- Output: JSON success/error, human formatting, exit-code mapping, redacted verbose events.

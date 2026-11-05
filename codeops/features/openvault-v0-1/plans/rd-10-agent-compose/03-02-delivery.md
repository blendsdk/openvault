# Delivery and Lifecycle: RD-10 Agent Delivery and Compose

> **Document**: 03-02-delivery.md
> **Parent**: [Index](00-index.md)

## Overview

This component turns a joined identity and a validated manifest into delivered files, a
refresh loop, a renewal loop, a value-free status document, a read-only unix socket, and the
wrapper/health commands. It owns every behavior in RD-10's failure matrix and the
single-flight/cancellation rules that keep a credential failure final.

## Architecture

```text
run
 ├── load config + manifest
 ├── open state store
 ├── join if no valid identity
 ├── start status file + unix socket
 ├── startup fetch (buffer all required, stage all writes)
 ├── write files, reconcile removed entries, heartbeat
 ├── start refresh timer
 ├── start renewal timer
 └── wait for signal / credential failure
```

`refreshOnce()` and `renewOnce()` are separate methods so tests and `--once` can call them
directly. The runner is the only owner of timers, single-flight guards, and process exit.

## Implementation Details

### Delivery state

```ts
/** One delivered target. */
export type DeliveryTarget =
  | { readonly kind: "file"; readonly path: string; readonly mode: number }
  | { readonly kind: "env"; readonly name: string };

/** One delivered manifest entry held in memory. */
export interface DeliveredEntry {
  readonly name: string;
  readonly value: Buffer;
  readonly encoding: "utf8" | "base64";
  readonly versionId: string;
  readonly deliveredAt: Date;
  readonly required: boolean;
  readonly targets: readonly DeliveryTarget[];
}

/** Aggregate delivery state. */
export type ConsumerState = "ok" | "degraded" | "failed";
```

Values live only in memory and in the output files. The status document and local socket never
expose them except the documented `/v1/secrets/:name` response.

### Atomic file write

`writeFileAtomic(target, bytes, mode)`:

1. Ensure the output directory exists, is a real directory, is owned by the current UID, and
   has no group/other permission bits. Create it `0700` when absent.
2. Create a temporary file in the same directory with a random `.openvault-<hex>.tmp` name,
   `O_CREAT|O_EXCL|O_WRONLY`, mode `0600`.
3. Write all bytes, `fchmod` the temporary file to the final mode, `fsync`, `close`.
4. `rename` over the target and `fsync` the directory.
5. On any error before `rename`, close and unlink the temporary file; the previous target
   remains intact. A failure after `rename` is reported as `agent_state_write_failed`; the new
   complete file is in place, never a partial one.

Startup additionally stages every new file as a temporary file before renaming any of them. If
any stage fails, it removes the managed set and exits failed, so no mixed old/new set remains.

### Startup

`startupFetch()`:

1. Read the previous `managed-files.json` set.
2. Read every entry sequentially. The aggregate state starts `ok`.
3. For each entry, call `readSecret` with the current aggregate state and the entry's optional
   flag.
4. On success, buffer the decoded bytes and version id. A `base64` response is decoded to bytes
   for files; `utf8` is encoded as UTF-8. A file target and an env target may both exist.
5. On a transient failure of a required entry: stop, write no files, set `failed`, exit
   non-zero. On a transient failure of an optional entry: mark the entry `degraded`, continue.
6. On 401/403/TLS credential rejection or a required 404/410: remove every managed output
   file, set `failed`, exit 1.
7. On optional 404/410: mark the entry `degraded` and continue; remove any previous file for
   that entry after the required set is known.
8. After every required entry succeeded, stage all new files, then rename them, and remove
   files from the previous managed set that are not in the new set of file targets. This
   includes optional entries that transient-failed at startup, file-to-env changes, and file
   renames. Only the agent's recorded targets are removed. Update `managed-files.json` and the
   status document.
9. Set `ok` when every entry is `ok`; otherwise `degraded`.
10. Send `POST /v1/agent/consumer` with the final aggregate state. A heartbeat failure is
    logged and ignored; it does not fail the fetch.
11. On a terminal startup failure, call the shared terminal handler: send a best-effort
    `failed` heartbeat while mTLS still works, remove the managed set when required, write the
    failed status, and exit. A 401/TLS failure skips the heartbeat because the identity cannot
    authenticate.

No file is written before step 8. A startup failure therefore never creates a mixed set.

### Refresh

`refreshOnce()` runs on the manifest interval with up to 10% positive jitter.

1. If another refresh is active, skip this tick (single-flight).
2. Start from the previous delivered map and the previous aggregate state; a new process starts
   at `ok`.
3. Fetch entries sequentially with the current aggregate state.
4. A 200 replaces the in-memory value and stages the file (or env value) after the fetch loop.
   A file-write failure is terminal.
5. A transient failure keeps the previous value for that entry, marks it `degraded`, and
   continues. If it was a required entry, the aggregate is `degraded`, not `failed`; the
   process stays alive with last-known-good files.
6. A 401/403 or TLS credential rejection calls the shared terminal handler: set the
   cancellation flag, abort in-flight requests, send a best-effort `failed` heartbeat, remove
   every managed file, set `failed`, and exit 1.
7. A required 404/410 calls the terminal handler and exits 1.
8. An optional 404/410 removes only that entry's file and marks `degraded`.
9. Any other 4xx, a 3xx/1xx/204, or a malformed/oversized 200 calls the terminal handler and
   exits 1.
10. A 200 whose value cannot be decoded for an `env` target is a per-entry failure: optional
    entries degrade, required entries fail with `agent_request_rejected`.
11. Every output write and removal goes through one runner-owned mutation queue. Before
    staging, before `rename`, and before a removal, check the cancellation flag. A terminal
    failure drains or aborts the queue and enqueues the removal last, so a later cycle cannot
    re-add a file.
12. Write all successful entries atomically, remove optional files that returned 404/410, and
    update the status document with the aggregate state.
13. Send `POST /v1/agent/consumer` with the final aggregate state. This guarantees the server
    records a last-entry transient failure or an all-entry failure. The shared terminal handler
    sends `failed` for terminal cycles where mTLS still works.

The per-fetch headers let the server record a successful read or a 404/410 immediately. The
final heartbeat records the aggregate even when the last request failed. A network failure
cannot reach the server during the cycle; the next successful fetch or heartbeat corrects it.

### Renewal

`renewOnce()` is scheduled from the stored certificate's actual `notBefore`/`notAfter`:

```text
renewAt = notBefore + ceil((notAfter - notBefore) * 2 / 3)
jitter  = random 0..5% of the lifetime, capped so renewAt + jitter < notAfter
```

1. Schedule with a chunked timer: delays above 24 hours are split into 24-hour sleeps and
   re-evaluated, so a 90-day certificate does not overflow Node's timer limit.
2. At the threshold, load or create `pending-renewal.json`. A pending file younger than five
   minutes is reused; an older one is replaced with a fresh P-256 key and CSR.
3. POST `/v1/agent/renew` over mTLS with the current certificate, the pending CSR, and the
   current consumer metadata/manifest hash.
4. On 200, atomically replace `identity.json`, delete the pending file, and schedule the next
   renewal from the new certificate.
5. On `409 renewal_not_due`, recompute the threshold from the certificate dates and reschedule
   there; keep the same pending key while it is younger than five minutes.
6. On `409 renewal_not_current`, reload `identity.json`. Adopt it only when its `identityId`
   matches the in-memory identity, its certificate/key pair parses, and it is newer than the
   in-memory certificate. Otherwise another agent/process renewed or the state belongs to a
   different service; stop renewal, keep delivering with the old certificate until expiry, log
   `degraded`, and require a new join token at expiry.
7. On transient failure, keep the old certificate and files, log `degraded` for renewal, and
   retry with exponential backoff from 1s to 5 minutes plus jitter.
8. On 401/403 or TLS credential rejection, call the shared terminal handler: set the
   cancellation flag, abort in-flight data requests, remove all managed files, set `failed`,
   and exit 1. Renewal and refresh never race a re-add.
9. On a terminal/not-found renewal response (3xx/204/other 4xx/malformed/404), call the shared
   terminal handler and exit 1.
10. After five minutes of retries with the same key, generate a new pending key/CSR. The old
    certificate remains valid for data until expiry.

A successful renewal does not interrupt delivery. The next data request uses the new
certificate and key from the in-memory state.

### Status document

`status.json` is written atomically with mode `0600`:

```json
{
  "version": 1,
  "state": "ok",
  "requiredReady": true,
  "project": "payments",
  "service": "api",
  "manifestHash": "sha256:...",
  "identityId": "01J...",
  "certificateNotAfter": "2026-12-05T09:41:00.000Z",
  "lastAttemptAt": "2026-11-05T09:41:00.000Z",
  "lastSuccessAt": "2026-11-05T09:41:00.000Z",
  "refreshMs": 300000,
  "staleAfterMs": 960000,
  "renewal": {
    "state": "ok",
    "lastAttemptAt": null,
    "lastSuccessAt": "2026-11-05T09:41:00.000Z",
    "nextAttemptAt": "2026-11-25T09:41:00.000Z"
  },
  "entries": [
    {
      "name": "db-password",
      "required": true,
      "state": "ok",
      "versionId": "01J...",
      "updatedAt": "2026-11-05T09:41:00.000Z"
    }
  ]
}
```

It contains no values, PEM, keys, tokens, host paths, or response bodies. Entry states are
`ok`, `degraded`, or `failed`. The file is written after every attempt, including failures,
before the process exits. `requiredReady` is true when every required entry is currently
delivered.

`ov-agent health` reads the configured status file and prints only the state. The file records
`refreshMs` and `staleAfterMs` (three refresh intervals plus 60 seconds) so the health command
needs no manifest. Exit codes: `0` for `ok`, `1` for `degraded`, `2` for `failed` or a
missing/invalid/stale file. A file is stale when `lastAttemptAt` is older than `staleAfterMs`.

`ov-agent health --ready` is the Compose gate. It exits `0` when `requiredReady` is true and
the file is not stale, even when optional entries are `degraded`; otherwise it exits `2`.
This keeps optional failures from blocking the application while preserving the full health
codes for operators.

### Local unix socket

`startLocalSocket()` creates the parent directory `0700`, refuses to replace a non-socket
path, unlinks a stale socket owned by the current UID, and listens with mode `0660`.

Routes:

| Method | Path | Response |
|---|---|---|
| GET | `/v1/secrets/:name` | `{name, value, encoding, versionId, deliveredAt}` for a delivered manifest entry; 404 otherwise |
| GET | `/v1/status` | The status document without values |
| * | * | 404 |

The socket handler answers from memory only. It never calls `VaultClient`, never refreshes, and
never widens the manifest. A name is matched exactly after URL-decoding. `GET` is the only
method.

### Wrapper mode and child process

`ov-agent run -- <cmd> [args...]`:

1. Perform the same startup fetch and status setup as sidecar mode, but validate the manifest
   with `mode: "wrapper"` so `env:` entries are allowed.
2. Build the child environment from a copy of `process.env` with every `OPENVAULT_*` variable
   and `COMPOSE_PROJECT_NAME` removed, plus only the manifest `env:` entries. Values must be
   valid UTF-8 without NUL. The child is spawned with `spawn(cmd, args, { env, stdio:
   "inherit", shell: false })`.
3. Keep refreshing and renewing while the child runs. On a credential or required-not-found
   failure, remove the managed files, send `SIGTERM` to the child, wait a short grace period,
   then `SIGKILL`, and exit 1. The child's normal exit code is the agent's exit code.
4. On a normal child exit, stop timers and the socket and exit with the child's code.
5. `env` entries are rejected at startup in sidecar mode.
6. The wrapper child runs as the same UID and can read the state directory. This is documented
   as a trust requirement and an accepted residual; the child environment is sanitized, but
   same-UID filesystem isolation is not possible without dropping privileges.

### Commands

```text
ov-agent run [--manifest PATH] [--output-dir PATH] [--state-dir PATH]
             [--status-file PATH] [--socket PATH] [--once] [-- <cmd> [args...]]
ov-agent health [--status-file PATH] [--ready] [--max-age SECONDS]
```

`run` without `--` is sidecar mode. `--once` performs one startup fetch, writes files and
status, sends the heartbeat, and exits with the health code (0/1/2); it does not start the
socket or timers. Unknown options exit 2. `--` must be the last agent option; everything after
it is the child command and is never parsed.

### Signals

On SIGTERM or SIGINT, set the cancellation flag, abort in-flight requests, stop timers, close
and unlink the socket, leave delivered files in place, and exit 0. No partial file is possible
because writes are atomic.

## Code Examples

### Sidecar

```bash
ov-agent run
```

### One-shot CI

```bash
ov-agent run --once
echo $?   # 0 ok, 1 degraded, 2 failed
```

### Compose health gate

```bash
ov-agent health --ready
```

### Wrapper

```bash
ov-agent run -- ./start.sh --port 8080
```

## Error Handling

| Failure | Files | Status | Process |
|---|---|---|---|
| Startup required 5xx/network | None written | `failed` | Exit 1 |
| Startup optional 5xx/network | Required files only | `degraded` | Continue |
| Startup write failure after fetch | Managed set removed | `failed` | Exit 1 |
| Startup terminal failure (mTLS available) | Varies | `failed` | Best-effort failed heartbeat, then exit 1 |
| Refresh required 5xx/network | Keep last known good | `degraded` | Continue |
| Refresh optional 5xx/network | Keep last known good for that entry | `degraded` | Continue |
| Refresh 401/403 or TLS rejection | Remove all managed files | `failed` | Exit 1 |
| Refresh required 404/410 | Remove all managed files | `failed` | Exit 1 |
| Refresh optional 404/410 | Remove that file | `degraded` | Continue |
| Refresh 3xx/204/other 4xx/malformed 200 | Remove all managed files | `failed` | Exit 1 |
| Renewal 401/403 or TLS rejection | Remove all managed files | `failed` | Exit 1 |
| Renewal transient | Keep files and old certificate | `degraded` | Retry |
| Renewal terminal/not-found | Remove all managed files | `failed` | Exit 1 |
| Renewal `not_due` | Keep files | `ok` | Reschedule |
| Renewal `not_current` | Keep files until expiry | `degraded` | Stop renewal |
| Status or output write failure | Previous file remains; new complete file may replace it | `failed` | Exit 1 |

Every row is covered by an ST case in [07-testing-strategy.md](07-testing-strategy.md).

## Testing Requirements
- Unit tests for atomic writes, startup staging, managed-file reconciliation, every
  failure-matrix row, status, and health.
- Real unix-socket tests for manifest-only reads and value-free status.
- A real TLS fake vault for refresh and renewal timers.
- A wrapper test with a child process and a sentinel join token.
- Captured stdout/stderr assertions that no value or key appears.
- Single-flight and cancellation tests with overlapping refresh cycles.

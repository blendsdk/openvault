# Agent Runtime: RD-10 Agent Delivery and Compose

> **Document**: 03-01-agent-runtime.md
> **Parent**: [Index](00-index.md)

## Overview

This component is the `apps/agent` package: configuration, strict manifest loading, state
storage, the HTTPS vault client, and the join sequence. It is the only code that runs next to
a workload and the only place a join token or agent private key exists. The package exports a
small library API so tests can drive it, and a `bin` entry `ov-agent` for the container.

## Architecture

### Current Architecture

No workload-side package exists. The server accepts a join request, returns a fixed-profile
certificate, and serves the secret read on the agent listener. The agent must speak those
contracts exactly; it has no privileged server code.

### Proposed Changes

```text
apps/agent/src/
├── main.ts        # bin entry and argument parsing
├── config.ts      # environment -> AgentConfig
├── manifest.ts    # strict YAML -> AgentManifest
├── state.ts       # identity.json, managed-files.json, pending-renewal.json
├── client.ts      # HTTPS join/renew/data/heartbeat client
├── join.ts        # key/CSR generation and join orchestration
├── delivery.ts    # fetch, failure matrix, atomic writes, managed-file reconciliation
├── renewal.ts     # schedule, jitter, retry, atomic swap
├── status.ts      # status document and health command
├── socket.ts      # read-only unix socket
├── runner.ts      # run/once/wrapper lifecycle, single-flight, signals
├── logger.ts      # structured value-free events
└── errors.ts      # stable agent error codes
```

The package is `@openvault/agent`, private, ESM, NodeNext, TypeScript 7.0.2. It builds to
`dist/` and exposes `bin.ov-agent = "./dist/main.js"`. The server and agent share contracts
from `@openvault/api-contract`; they do not import each other's source.

## Implementation Details

### Configuration

`loadAgentConfig(env, options)` returns a frozen `AgentConfig`. It reads:

| Variable | Required | Default | Validation |
|---|---|---|---|
| `OPENVAULT_URL` | yes | — | Absolute `https:` URL; no credentials, path, query, or fragment |
| `OPENVAULT_CA_FILE` | yes | — | Absolute readable regular file; PEM with at least one certificate; 1 MiB bound |
| `OPENVAULT_JOIN_TOKEN` | first start | — | 43-character base64url; absent when valid state exists |
| `OPENVAULT_PROJECT` | yes | — | `projectNameSchema` |
| `OPENVAULT_SERVICE` | yes | — | `identityNameSchema` |
| `COMPOSE_PROJECT_NAME` | yes | — | 1–100 characters, `^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| `OPENVAULT_MANIFEST` | no | `/etc/openvault/manifest.yaml` | Absolute path |
| `OPENVAULT_OUTPUT_DIR` | no | `/run/secrets` | Absolute path; manifest must equal it |
| `OPENVAULT_STATE_DIR` | no | `/var/lib/openvault` | Absolute path; created `0700` |
| `OPENVAULT_STATUS_FILE` | no | `/run/openvault/status.json` | Absolute path |
| `OPENVAULT_SOCKET_PATH` | no | `/run/openvault/agent.sock` | Absolute path |

The URL host is used for SNI and certificate verification. The CA file is read once at
startup. Secrets and paths are not logged.

### Manifest

```ts
/** One delivery target. */
export type ManifestTarget =
  | { readonly kind: "file"; readonly name: string; readonly mode: 0o400 | 0o440 | 0o600 | 0o640 }
  | { readonly kind: "env"; readonly name: string };

/** One manifest entry. */
export interface ManifestEntry {
  readonly name: string;
  readonly targets: readonly ManifestTarget[];
  readonly optional: boolean;
}

/** A validated manifest. */
export interface AgentManifest {
  readonly project: string;
  readonly service: string;
  readonly refreshMs: number;
  readonly outputDir: string;
  readonly entries: readonly ManifestEntry[];
  readonly hash: string;
}
```

Rules:

- The document is a strict object with exactly `project`, `service`, optional `refresh`,
  `output_dir`, and `entries`.
- `refresh` accepts `<integer>s`, `<integer>m`, `<integer>h`, or a bare integer of seconds;
  the range is 30–86,400 seconds. Default `300s`.
- `entries` has 1–100 items. Each item is a strict object with `name`, optional `file`,
  optional `env`, optional `mode`, and optional `optional`.
- At least one of `file` or `env` is present. Both may be present in wrapper mode; both targets
  are delivered. `env` is rejected in sidecar mode.
- `name` uses the published secret-name schema and is unique within the manifest.
- `file` matches `^[A-Za-z0-9._-]+$`, is not `.` or `..`, and is unique.
- `env` matches `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, is unique, and is not on the loader denylist.
- `mode` is a string from `0400`, `0440`, `0600`, `0640`; default `0400`; rejected without a
  file target.
- `output_dir` must equal `OPENVAULT_OUTPUT_DIR`; `project` and `service` must equal the
  environment values.
- The hash is `sha256:` plus SHA-256 over the raw file bytes.
- Duplicate YAML keys, aliases that resolve to unsupported values, and non-string scalars fail
  with a stable manifest error.

### State

`AgentStateStore` owns the `0700` state directory and serializes writes.

```ts
/** Persisted identity material. */
export interface StoredIdentity {
  readonly version: 1;
  readonly identityId: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly serial: string;
  readonly notAfter: string;
  readonly joinedAt: string;
}

/** File targets the agent delivered from the previous manifest. */
export interface ManagedFiles {
  readonly version: 1;
  readonly outputDir: string;
  readonly manifestHash: string;
  readonly files: readonly string[];
}

/** In-flight renewal material reused inside the replay window. */
export interface PendingRenewal {
  readonly version: 1;
  readonly privateKeyPem: string;
  readonly csrPem: string;
  readonly createdAt: string;
}
```

- `identity.json`, `managed-files.json`, and `pending-renewal.json` are written with
  `O_CREAT|O_EXCL|O_WRONLY` to a temporary file in the same directory, `fchmod` to `0600`,
  `fsync`, `rename`, then `fsync` the directory. The directory is created `0700` and fsynced.
- On load, the directory must be a real directory owned by the current UID, not a symlink, and mode `0700` exactly.
  Each file is opened with `O_NOFOLLOW`, `fstat`ed, and checked for regular-file type, current
  UID ownership, and exact mode `0600` before its descriptor is read. A violation fails closed
  with `agent_state_insecure`; the agent does not silently rejoin or overwrite the file.
- `identity.json` is valid only when `notBefore <= now < notAfter` and the certificate/key pair
  parses. An expired or not-yet-valid identity is treated as absent; a join token is then
  required to rejoin.
- `pending-renewal.json` is deleted after a successful renewal or when older than five minutes.
- `managed-files.json` records the output root, the manifest hash, and the exact file targets
  delivered. Each name is validated with the manifest file grammar, capped at 100, and resolved
  directly under the output root; a ledger with a different output root is ignored. The
  ledger is used to remove files that a previous manifest delivered but the current manifest no
  longer targets, including a file-to-env change or a file rename. Only names recorded by the
  agent are removed.

### HTTPS client

`VaultClient` uses `node:https` with:

- `ca`: the PEM bundle from `OPENVAULT_CA_FILE`;
- `cert` and `key`: the stored identity, or absent for join;
- `rejectUnauthorized: true`, `minVersion: "TLSv1.2"`, SNI from the URL host;
- a 10-second socket timeout and a 10-second total request timeout;
- no redirect following;
- request bodies limited to 64 KiB; response bodies limited to 1 MiB;
- successful bodies parsed with `agentCertificateResponseSchema`, `secretValueResponseSchema`,
  or `agentConsumerStateResponseSchema`.

Methods:

```ts
join(input: AgentJoinRequest): Promise<AgentCertificateResponse>;
renew(input: AgentRenewRequest): Promise<AgentCertificateResponse>;
readSecret(project: string, name: string, state: ConsumerState, optional: boolean): Promise<SecretValueResponse>;
heartbeat(state: ConsumerState): Promise<void>;
```

The data read sets `X-OpenVault-Consumer-State: <state>` and
`X-OpenVault-Entry-Optional: <true|false>`. The heartbeat posts `{state}` to
`/v1/agent/consumer`.

Error model: `VaultClientError` carries `kind` (`credential`, `transient`, `not_found`,
`terminal`, `renewal_not_due`, `renewal_not_current`) and `httpStatus`/`code`. Status mapping:

| Observation | Kind |
|---|---|
| 200 with a valid body | success |
| 401/403 | `credential` |
| 404/410 | `not_found` |
| 409 with `renewal_not_due` | `renewal_not_due` |
| 409 with `renewal_not_current` | `renewal_not_current` |
| 429/5xx | `transient` |
| 1xx/3xx/204/other 4xx/malformed or oversized 200 (except heartbeat) | `terminal` |
| Heartbeat 200 `{state}` | success; heartbeat 204/3xx is terminal |
| TLS family (`ERR_TLS_*`, `ERR_SSL_*`, `CERT_*`, `UNABLE_TO_*`, self-signed/hostname codes) | `credential` |
| Socket/network family (`E*`, including `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `ECONNABORTED`) | `transient` |
| Unknown TLS error | `credential` (fail closed) |

### Join

`joinAgent({ config, store, client, logger, now })`:

1. If `store.loadIdentity()` returns a valid unexpired identity, return it without a network
   call.
2. Require `OPENVAULT_JOIN_TOKEN`; otherwise fail `agent_join_token_required`.
3. Generate an EC P-256 key pair with WebCrypto and a PKCS#10 CSR with
   `@peculiar/x509` (`CN=openvault-agent`, ECDSA-SHA-256).
4. Build consumer metadata from `COMPOSE_PROJECT_NAME`, the service name, the sanitized
   hostname, and the manifest hash.
5. Send the join request. On `transient`, retry the same request with exponential backoff
   (1s, 2s, 4s, 8s, 16s, capped at 30s) for up to five minutes. On `credential`, `terminal`,
   or `not_found`, fail immediately.
6. On success, export the private key to PKCS#8 PEM, store `identity.json` atomically, and
   return. The private key never appears in the request body or a log.
7. A lost response after the server consumes the token is unrecoverable by retry; the error
   instructs the operator to issue a new token.

### Error model

| Code | Meaning | Retry |
|---|---|---|
| `agent_config_invalid` | Missing or invalid environment/path/URL | No |
| `agent_manifest_invalid` | Schema, path, mode, duplicate, or agreement failure | No |
| `agent_state_insecure` | Symlink, owner, mode, or regular-file violation | No |
| `agent_join_token_required` | No valid state and no join token | No |
| `agent_join_failed` | Join credential or validation rejection | No |
| `agent_credential_rejected` | 401/403 or TLS certificate rejection | No; remove files and exit |
| `agent_secret_not_found` | Required 404/410 | No; remove files and exit |
| `agent_transient` | 429/5xx/network/timeout | Yes |
| `agent_request_rejected` | 3xx/204/other 4xx/malformed response | No; remove files and exit |
| `agent_renewal_terminal` | Renewal 3xx/204/other 4xx/malformed/404 | No; remove files and exit |
| `agent_renewal_not_due` | Server clock says renewal is early | Reschedule at the threshold |
| `agent_renewal_not_current` | Another certificate is newest | Reload state; stop renewal if still stale |
| `agent_state_write_failed` | State or output write failure | No |

All public errors carry only the code and a short static message. Raw parser and network text
is not copied into the response or log.

## Code Examples

### Load and validate

```ts
const config = loadAgentConfig(process.env);
const manifest = loadAgentManifest(config.manifestPath, {
  project: config.project,
  service: config.service,
  outputDir: config.outputDir,
  mode: "sidecar",
});
```

### Client call

```ts
const response = await client.readSecret(
  manifest.project,
  entry.name,
  aggregateState,
  entry.optional,
);
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Unknown manifest field | Startup failure before network | AR-5 |
| `..` or absolute file | Startup failure | AR-6 |
| Unsafe state file | Fail closed; do not overwrite or rejoin | AR-8 |
| Join token missing | Fail with an operator instruction | AR-9 |
| Expired stored identity | Require a join token and rejoin | AR-9 |
| Certificate dates unreadable | Treat state as invalid and require a rejoin | AR-10 |
| TLS certificate rejection | Credential failure path | AR-17 |
| Response outside bounds | Terminal request failure | AR-11, AR-17 |

## Testing Requirements
- Unit tests for every manifest rule and configuration bound.
- State tests for modes, ownership, symlinks, atomic replacement, pending age, and managed files.
- Real TLS tests for join success, token rejection, CSR shape, and no private-key upload.
- A captured-request test asserts the join body contains no `privateKey` field.
- No mocked TLS, filesystem, or CSR library.

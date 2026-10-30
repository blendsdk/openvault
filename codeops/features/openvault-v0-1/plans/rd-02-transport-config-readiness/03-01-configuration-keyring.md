# Configuration and Keyring: RD-02 Transport

> **Document**: 03-01-configuration-keyring.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Overview

This component validates every documented environment value before the process performs
database work or binds a socket. It also makes key material available to the server without
exposing raw key buffers through the server-facing API. The env variable contract is owned by
[RD-02 §Technical Requirements / Configuration](../../requirements/RD-02-transport-config-readiness.md#configuration);
this document specifies the implementation deltas and error behavior (AR-11, AR-12, AR-9,
AR-10).

## Architecture

```text
process.env
   │
   ▼
loadConfig(env) ── Zod schema ── file/mode/CIDR/URL checks ── OpenVaultConfig
   │
   ├── standard fields ──▶ WebApplication({ PORT, ENV_MODE, LOG_LEVEL, BODY_LIMIT, CORS:false, TRUST_PROXY:false })
   └── custom fields ───▶ typed config service (never logged)
                              │
                              ▼
                     KeyringProvider.load(config.keyringPath)
                              │
                              ▼
                     packages/core Keyring
```

The custom config is not placed in WebAFX's passthrough settings because request-scoped
services can read those settings and some values are secrets (AR-11). Only the six standard
WebAFX values cross the bridge.

## New Types and Errors

```ts
/** A validated, normalised runtime configuration. */
export interface OpenVaultConfig {
  readonly baseUrl: URL;
  readonly adminPort: number;
  readonly agentPort: number;
  readonly envMode: "production" | "development" | "test";
  readonly databaseUrl: string;
  readonly database: PostgreSQLConfig;
  readonly keyringPath: string;
  readonly keyringPassphrasePath?: string;
  readonly tlsCertPath: string;
  readonly tlsKeyPath: string;
  readonly internalCaPath: string;
  readonly oidc?: OidcConfig;
  readonly secretMaxBytes: number;
  readonly certMaxBytes: number;
  readonly softDeleteDays: number;
  readonly auditRetentionDays: number;
  readonly joinTokenTtlMs: number;
  readonly certTtlDays: number;
  readonly sessionTtlHours: number;
  readonly trustProxy: boolean;
  readonly proxyCidrs: readonly Cidr[];
  readonly logLevel: "error" | "warn" | "info" | "debug";
}

/** One validated IPv4 or IPv6 CIDR. */
export interface Cidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: "ipv4" | "ipv6";
}

/** Raised for a missing or malformed configuration value. */
export class ConfigError extends Error {
  public readonly key: string;
  public constructor(key: string, message: string);
}
```

`ConfigError` messages name the environment variable and reason but never include its value or
any file content. The startup reporter uses only `error.key` and `error.message`.

## Config Loading

### Parse pipeline

1. Read the supplied environment object (defaults to `process.env`); never mutate it.
2. Parse required values with explicit Zod transforms. Do not use a loose `z.coerce` where it
   would accept `"0"` or an empty string for a required value.
3. Validate URL schemes, integer ranges, durations, booleans, CIDRs, and `ENV_MODE`
   (`production`/`development`/`test`, default `production`). `ENV_MODE` is part of the typed
   config so the stack-trace switch cannot bypass validation.
4. Resolve and validate required file paths and file modes.
5. Reject an admin/agent port collision before any socket or database work.
6. Return a frozen `OpenVaultConfig`.
7. Build `toRedactedConfig(config)` for support output. It redacts the database password and
   OIDC client secret and never includes file contents.

### Port precedence

`OPENVAULT_ADMIN_PORT` is the canonical admin port. If it is absent, `PORT` is accepted as a
compatibility alias. If both are present and differ, startup fails with
`OPENVAULT_ADMIN_PORT: conflicts with PORT`. `OPENVAULT_AGENT_PORT` is independent and defaults
to `8444`. Both ports are validated as integers 1–65535, and `OPENVAULT_AGENT_PORT` must differ
from the resolved admin port; equality fails with a keyed `ConfigError` naming both variables
before migrations or binding. (AR-12)

### Required files

| Value | Checks |
|---|---|
| `OPENVAULT_KEYRING` | Absolute path; regular file; exact mode `0600`; readable |
| `OPENVAULT_KEYRING_PASSPHRASE_FILE` | Absolute path; regular file; mode `0600`; then fail closed as unsupported until RD-13 |
| `OPENVAULT_TLS_CERT` | Absolute path; regular file; readable; PEM certificate parsed by the TLS component |
| `OPENVAULT_TLS_KEY` | Absolute path; regular file; readable; PEM private key parsed; must match the certificate |
| `OPENVAULT_INTERNAL_CA` | Absolute path; regular file; readable; PEM CA parsed; must have `CA:TRUE` |

The keyring path is required; the documentation's older optional default is corrected in
03-04. A mode check uses `(stat.mode & 0o777) === 0o600`; group/world-readable files are
rejected even when the process owns them. (AR-10, AR-2)

### URLs, booleans, integers, durations, and CIDRs

- `OPENVAULT_BASE_URL`: absolute HTTPS URL; reject credentials, query, and fragment; keep the
  path but remove a trailing slash.
- `OPENVAULT_DB_URL`: reuse `parseDatabaseUrl` from `apps/server/src/db/url.ts`. It rejects
  non-PostgreSQL schemes, missing user/database, invalid ports, and TLS query parameters. RD-02
  uses the same fail-closed behavior. (The adapter's lack of TLS options is recorded in
  02-current-state and is not expanded in this plan.)
- `OPENVAULT_TRUST_PROXY`: exactly `true` or `false`; default `true`.
- `OPENVAULT_PROXY_CIDRS`: comma-separated IPv4/IPv6 CIDRs; reject empty entries, invalid
  prefixes, and network-address mismatches. Store normalised `Cidr` values.
- `OPENVAULT_LOG_LEVEL`: lowercase enum; convert to WebAFX `LOG_LEVEL` uppercase and pino level.
- Numeric limits use explicit integer bounds from RD-02.
- `OPENVAULT_JOIN_TOKEN_TTL` accepts `1m`…`24h` with `ms`, `s`, `m`, or `h`; store milliseconds.
- OIDC: if `OPENVAULT_OIDC_ISSUER` is absent, reject client id/secret/allowed domains; if it is
  present, require client id and secret, default the redirect URL to
  `${OPENVAULT_BASE_URL}/v1/auth/callback`, and validate HTTPS URLs and domain labels.
- `OPENVAULT_KEYRING_PASSPHRASE_FILE`: if set, fail closed with
  `OPENVAULT_KEYRING_PASSPHRASE_FILE: age-encrypted keyrings are deferred to RD-13`. (AR-2)

### WebAFX bridge

`createWebApplicationConfig(config)` returns only:

```ts
{
  PORT: config.adminPort,
  ENV_MODE: config.envMode,
  LOG_LEVEL: config.logLevel.toUpperCase(),
  BODY_LIMIT: "128kb",
  CORS: false,
  TRUST_PROXY: false,
}
```

`SecureWebApplication` overrides WebAFX's protected `loadConfiguration()` to a no-op so
`.env.js` and `.env.local.js` cannot overwrite a validated value (AR-11).

### Body-limit precedence

RD-02's transport guardrails are fixed at 64 KiB for secret routes and 128 KiB for certificate
routes (03-02). `OPENVAULT_SECRET_MAX_BYTES` and `OPENVAULT_CERT_MAX_BYTES` are validated here
because RD-02 documents them, but they are product-value limits enforced by RD-08/RD-09; they do
not widen or narrow the transport boundary. The plan states this so an operator does not expect
`OPENVAULT_SECRET_MAX_BYTES=1024` to tighten the HTTP parser in RD-02.

### Redacted support output

`toRedactedConfig(config)` returns a JSON-safe object built from an explicit allowlist:

- `baseUrl` as its `href`;
- `adminPort`, `agentPort`, `envMode`, and the non-secret scalar settings;
- `database` as `{ host, port, database, user, pass: "***" }`; the raw `databaseUrl` is never
  included, so the password exists in exactly one masked representation;
- `oidc` only when configured, with `clientSecret: "***"`;
- keyring/passphrase/TLS paths shown as paths (not contents).

It must never be called with `process.env` and must never include `OPENVAULT_DB_URL` raw. A test
serializes the result and asserts that the known database password, the known `database.pass`,
and the OIDC client secret are absent. Building from an allowlist is deliberate: a future secret
field is omitted by default rather than leaked by a spread.

## Keyring Hardening

### Core API

`packages/core/src/keyring.ts` changes from raw-buffer accessors to scoped callback access:

```ts
export class Keyring {
  public get currentId(): string;
  public has(id: string): boolean;
  public withCurrentKey<T>(action: (key: Readonly<Buffer>) => T): T;
  public withKey<T>(id: string, action: (key: Readonly<Buffer>) => T): T;
  public destroy(): void;
  public toJSON(): { version: 1; current: string; keyIds: string[] };
  public static fromJSON(value: unknown): Keyring;
  public static generate(id?: string): Keyring;
}
```

- `withCurrentKey`/`withKey` are the only key access path. They throw `KeyringError` after
  `destroy()` or for an unknown id; the callback runs synchronously and the buffer is not
  returned.
- `toJSON()` returns only the version, current key id, and key ids. It never returns base64 key
  bytes. This makes `JSON.stringify(keyring)` safe for logs.
- `[Symbol.for("nodejs.util.inspect.custom")]` returns
  `Keyring(current=<id>, keys=<count>, redacted)`.
- `destroy()` fills every internal key buffer with zero, clears the map, and is idempotent.
  Zeroization is best-effort; Node cannot wipe copies or strings.
- Key ids must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and must not be `__proto__`,
  `constructor`, or `prototype`.
- `fromJSON` requires version 1, a present current id, a non-empty key map, canonical base64
  strings that decode to exactly 32 bytes, and the current id present in the map.
- `encryptValue`/`decryptValue` in `crypto.ts` use `withCurrentKey`/`withKey`; no exported type
  carries a raw key buffer. `KeyMaterial` is removed from `packages/core/src/index.ts`.

The old round-trip test that encoded via `toJSON()` must be replaced with a base64 fixture and a
redaction test. RD-13 owns a storage/export API for backup and rotation; it is not added here
(AR-2, AR-9).

**Provisioning boundary.** `toJSON()` no longer writes key bytes, so RD-02 does not create the
initial keyring file. `ov init` (RD-11) will use the RD-13 export API to write it; the reference
stack is not bootable until that lands. RD-02 tests use temporary keyring fixtures and
`01-requirements.md` records this as a deferred dependency. Zeroization is best-effort: ST-13
asserts only the observable behavior (idempotent `destroy()`, access throws after destroy);
actual buffer wiping is a code-review gate because Node cannot guarantee it.

### Server provider

`apps/server/src/security/keyring.ts` adds `KeyringProvider`:

- `static load(path: string): Promise<KeyringProvider>` checks absolute path, regular file,
  exact mode `0600`, reads UTF-8 JSON, calls `Keyring.fromJSON`, and destroys partial state on
  any failure.
- `status()` returns `{ loaded: boolean; currentId?: string; keyCount: number }`. It never
  returns a key buffer or key bytes.
- `toJSON()` returns the same status shape, so `JSON.stringify(provider)` cannot traverse the
  private keyring object.
- `[Symbol.for("nodejs.util.inspect.custom")]` returns
  `KeyringProvider(loaded=<bool>, current=<id>, keys=<count>)`.
- `destroy()` delegates to `Keyring.destroy()`.
- It is registered as a singleton service with a dispose hook. The application shutdown path
  also calls `destroy()` defensively so zeroization happens even if plugin shutdown fails.
- The provider is never serialized beyond the redacted status; a test covers both `toJSON()` and
  `util.inspect`.

## Startup Order

`main.ts` performs, in order:

1. `loadConfig(process.env)`.
2. `KeyringProvider.load(config.keyringPath)`.
3. `TlsMaterial.load(config)` (03-02).
4. `runMigrations({ command: "up", configPath })`.
5. Create the PostgreSQL pool and secure application.
6. Bind the admin and agent listeners.

Any failure before step 6 writes a redacted error and exits non-zero without binding. Any
failure after keyring load destroys the provider. (AR-21)

## Error Handling

| Case | Result |
|---|---|
| Missing required variable | `ConfigError` names the key; exit 1 before DB/listener |
| Malformed URL/CIDR/port/duration | `ConfigError` names the key; no value echoed |
| Keyring not `0600` | `ConfigError` / `KeyringError`; exit 1 |
| Keyring malformed/wrong key length | `KeyringError`; destroy partial buffers; exit 1 |
| Passphrase file set | Unsupported-feature error until RD-13; exit 1 |
| TLS/CA malformed or key mismatch | `TlsMaterialError`; exit 1 |
| Redacted dump requested | No password, client secret, or key bytes |

## Integration Points

- 03-02 consumes `OpenVaultConfig`, `KeyringProvider`, and TLS material.
- 03-03 consumes keyring status and database config for readiness.
- RD-03/RD-05 consume the verified clock-skew constant and the same TLS material.
- RD-08 consumes the hardened keyring API through a crypto service, not raw buffers.
- RD-13 consumes the deferred age/storage work.
- RD-14 reviews key custody and transport hardening.

## Testing Requirements

- ST-1–ST-9 in [07-testing-strategy.md](07-testing-strategy.md) cover config validation,
  redaction, port precedence, and CIDR parsing.
- ST-10–ST-14 cover keyring loading, permissions, redaction, inspection, destruction, and the
  passphrase-file failure.
- Unit tests may use temporary directories but must delete them in `finally`.
- No test writes a real keyring or private key into the repository.

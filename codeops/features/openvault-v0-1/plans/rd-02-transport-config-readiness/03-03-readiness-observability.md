# Readiness and Observability: RD-02

> **Document**: 03-03-readiness-observability.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Overview

This component makes liveness and readiness truthful without leaking configuration or key
material. It also wires BlendSDK's pino logger plugin, the standard error envelopes, and the
30-second clock-skew policy used by later token and certificate validation.

The public behavior is owned by
[RD-02 §Readiness](../../requirements/RD-02-transport-config-readiness.md#readiness) and RD-02
acceptance criteria 7, 10, 11, and 14. Implementation decisions are AR-17–AR-22.

## Endpoints

| Endpoint | Listener | Behavior |
|---|---|---|
| `GET /health` | Admin and agent | WebAFX liveness; no database or keyring probe; generic body |
| `GET /ready` | Admin only | Dependency probe; 200 or 503 |
| `GET /v1/ready` | — | Removed; the root path is the contract |

WebAFX owns `/health` and returns `{ health: true, timestamp }`. It is not wrapped in the API
success envelope; RD-02 describes it as liveness only. `/ready` is a `BaseController` at the
root path and uses the WebAFX success/error envelopes.

## Readiness Service

`apps/server/src/readiness/service.ts` defines:

```ts
export interface ReadinessProbe {
  check(): Promise<void>;
}

export class ReadinessService {
  public constructor(
    private readonly database: PostgreSQLDatabase,
    private readonly keyring: KeyringProvider,
    private readonly tls: TlsMaterial,
    private readonly timeoutMs = 2_000,
  );
  public async check(): Promise<void>;
}
```

`check()` runs the following probes with a single 2 s timeout around the whole operation:

1. **PostgreSQL** — `database.executeQuery("SELECT 1")`. The pool is constructed with
   `connectionTimeoutMillis: 2_000` and `enableGracefulShutdown: false`; the service owns
   disconnect on application shutdown.
2. **Keyring** — `keyring.status()` reports loaded and a current key id. The probe never reads
   key bytes.
3. **TLS/CA** — `tls` reports parsed server certificate/key match and a CA with `CA:TRUE` and a
   valid self/CA verification. No live agent certificate is required; RD-02 checks the trust
   anchor, not a peer chain (AR-19).
4. **Audit table** — `SELECT 1 FROM audit_events LIMIT 1` is a read-only table probe. It does
   not write an audit event and does not require table ownership.
5. **Timeout** — `Promise.race` returns `ReadinessError` at 2 s. The error contains no SQL,
   host, path, or key material.

Any failure makes the controller throw:

```ts
new ApiError(503, "not_ready", "Not ready");
```

The response is the standard WebAFX error envelope with `requestId` and `path`. No internal
reason is exposed; the detailed reason is logged at `warn` with a fixed probe name and no
secret values.

## Controller

`apps/server/src/controllers/ready.ts` is registered at the root base path:

```ts
export class ReadyController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/ready")
        .handle(async (_req, res) => {
          await this.services.get<ReadinessService>("readiness").check();
          this.ok(res, { status: "ready" });
        }),
    ];
  }
}
```

The controller is mounted with `app.registerController("", ReadyController)`. The old
`/v1/ready` route and its constant body are removed.

## Logging

`apps/server/src/observability/logger.ts` uses BlendSDK `pinoLoggerPlugin`:

```ts
app.use(
  pinoLoggerPlugin({
    level: config.logLevel,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "authorization",
      "cookie",
      "set-cookie",
      "password",
      "token",
      "value",
      "privateKey",
      "*.password",
      "*.token",
      "*.value",
      "*.privateKey",
    ],
  }),
);
```

Rules:

- The pino plugin replaces WebAFX's default logger and registers `req.log`.
- Request IDs from WebAFX's request-id middleware are bound to `req.log`.
- The config object, keyring, TLS material, and raw environment are never logged.
- Startup config failures log only the environment key and a fixed reason.
- API handlers must keep credentials out of URL query strings; pino redaction is field/path
  based. RD-03/RD-05 use headers and bodies. This is recorded in AR-20.
- Structured log tests use a `Writable` destination and assert that a token, value, password,
  private key, authorization header, and set-cookie value are redacted.

## Error Handling

WebAFX's error handler remains the single renderer. The transport layer maps known parser
errors to `ApiError` (03-02). Rules:

- `ApiError` status/code/message is preserved; `details` is present only when it contains no
  secret, SQL, path, or key material.
- Unknown errors become `500 INTERNAL_SERVER_ERROR`; stack traces appear only outside
  production, and the production default is `ENV_MODE=production`.
- `413`, `415`, `503`, `404`, and validation errors use the same envelope:
  `{ success: false, error: { code, message, statusCode, timestamp, requestId, path } }`.
- No response includes a stack trace, SQL, filesystem path, key bytes, or config value.

## Clock Skew Policy

`apps/server/src/security/clock.ts` exports:

```ts
export const CLOCK_SKEW_SECONDS = 30;

export function isWithinClockSkew(
  nowMs: number,
  notBeforeMs: number,
  notAfterMs: number,
): boolean;
```

The helper accepts a 30-second early/late tolerance and is used by RD-03 token validation and
RD-05 certificate validation. RD-02 tests the boundary values with an injected clock; it does
not implement a token or agent certificate validator (RD-03/RD-05 own those flows).

## Operational Behavior

- `/health` stays 200 during a database outage; it is liveness only.
- `/ready` returns 503 during a database outage, missing keyring, malformed CA, or audit probe
  failure.
- Readiness probes do not write audit events and do not mutate configuration.
- The readiness database pool is a disposable singleton; the secure runtime closes it during
  shutdown.
- A readiness timeout is logged once with `probe: "timeout"`; repeated probes do not leak
  connection strings.

## Integration Points

- 03-01 supplies config and keyring status.
- 03-02 supplies TLS material and the secure listener lifecycle.
- RD-07 will add the audit writer and may add a write-readiness check; the read-only probe is
  intentionally allowed by RD-02.
- RD-13 uses the same `/health` and `/ready` contract.
- RD-14 tests both endpoints in release verification.

## Testing Requirements

- ST-27–ST-32 in [07-testing-strategy.md](07-testing-strategy.md) cover liveness, readiness
  success/failure/timeout, error envelopes, log redaction, and clock-skew boundaries.
- Readiness tests inject fake probes for the failure matrix and use a real migrated database
  for the success path.
- Logging tests capture pino output and assert both redaction and request correlation.
- No test logs a real key, password, or token.

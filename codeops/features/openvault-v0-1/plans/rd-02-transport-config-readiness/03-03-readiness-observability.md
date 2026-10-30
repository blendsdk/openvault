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
  readonly name: "postgresql" | "keyring" | "tls" | "audit";
  check(): Promise<void>;
}

export class ReadinessService {
  public constructor(
    private readonly probes: readonly ReadinessProbe[],
    private readonly timeoutMs = 2_000,
  );
  public async check(): Promise<void>;
}
```

`createApplication` builds the production probes from `PostgreSQLDatabase`,
`KeyringProvider`, and `TlsMaterial`; tests pass fake `ReadinessProbe` objects for the failure
matrix. No unsafe cast or `vi.spyOn` on a concrete adapter is needed.

`check()` runs the following probes with a single 2 s timeout around the whole operation. A
failed probe throws `ReadinessError`, which carries a fixed probe name and never a SQL string,
host, path, or key:

```ts
export class ReadinessError extends Error {
  public readonly probe: "postgresql" | "keyring" | "tls" | "audit" | "timeout";
  public constructor(probe: ReadinessError["probe"]);
}
```

1. **PostgreSQL** — `database.executeQuery("SELECT 1")`. The pool is constructed with
   `poolConfig: { connectionTimeoutMillis: 2_000 }` and `enableGracefulShutdown: false`; the
   application factory owns the pool's dispose hook. `connectionTimeoutMillis` is a `poolConfig`
   field, not a top-level `PostgreSQLConfig` field.
2. **Keyring** — `keyring.status()` reports loaded and a current key id. The probe never reads
   key bytes.
3. **TLS/CA** — `tls` reports parsed server certificate/key match and a CA with `CA:TRUE` and a
   valid self/CA verification. No live agent certificate is required; RD-02 checks the trust
   anchor, not a peer chain (AR-19).
4. **Audit table** — `SELECT 1 FROM audit_events LIMIT 1` is a read-only table probe. It does
   not write an audit event and does not require table ownership.
5. **Timeout** — `Promise.race` returns `ReadinessError` at 2 s. The error contains no SQL,
   host, path, or key material.

Each production probe translates an expected adapter/dependency failure into `ReadinessError`;
programming errors propagate unchanged. The controller catches only that type, logs the fixed
probe name at `warn` through `req.log`, and throws:

```ts
new ApiError(503, "not_ready", "Not ready");
```

Other errors remain 500, so an unexpected handler bug is not disguised as a dependency outage.
The response is the standard WebAFX error envelope with `requestId` and `path` nested inside
`error`. No internal reason is exposed; the logged reason contains only the fixed probe name and
no secret values.

## Controller

`apps/server/src/controllers/ready.ts` is registered at the root base path:

```ts
export class ReadyController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/ready")
        .handle(async (req, res) => {
          const readiness = await this.services.get<ReadinessService>("readiness");
          try {
            await readiness.check();
          } catch (error) {
            if (error instanceof ReadinessError) {
              await req.log.warn("readiness probe failed", { probe: error.probe });
              throw new ApiError(503, "not_ready", "Not ready");
            }
            throw error;
          }
          this.ok(res, { status: "ready" });
        }),
    ];
  }
}
```

`ServiceContainer.get()` is asynchronous; the `await` is part of the API contract, not an
optional style choice. A blanket catch would turn genuine bugs into 503s, so only
`ReadinessError` is translated.

WebAFX's `Logger` is **message-first**: `warn(message, data)`, not pino's object-first order.
The `Express.Request.log` augmentation uses the WebAFX `Logger` type, so the controller and the
pre-stack logger both call `warn("readiness probe failed", { probe })`.

The controller is mounted with `app.registerController("", ReadyController)`. The old
`/v1/ready` route and its constant body are removed.

## Logging

`apps/server/src/observability/logger.ts` uses the two-step BlendSDK pino API so the pre-stack
error logger and the request logger share one provider:

```ts
import { createLoggerPlugin, PinoLoggerProvider } from "blendsdk/webafx-pino";

const provider = new PinoLoggerProvider({
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
      "req.body.password",
      "req.body.token",
      "req.body.value",
      "req.body.privateKey",
    ],
});

app.use(createLoggerPlugin(provider));
```

Pino redaction is path-based and each `*` wildcard covers one level. The list covers the
documented top-level fields, the authorization/cookie headers, and the known one-level request
body shapes; it is not recursive.

Rules:

- The pino plugin replaces WebAFX's default logger and registers `req.log`; the pre-stack error
  logger (03-02) uses the same provider and redaction list.
- Add `apps/server/src/types/express.d.ts` with an `Express.Request.log: Logger` module
  augmentation (WebAFX declares `id` but not `log`); the pino plugin supplies the runtime value.
- Request IDs from WebAFX's request-id middleware are bound to `req.log`; a pre-stack rejection
  carries the correlation middleware's ID.
- The config object, keyring, TLS material, and raw environment are never logged.
- Startup config failures log only the environment key and a fixed reason.
- API handlers must keep credentials out of URL query strings; pino redaction is field/path
  based. RD-03/RD-05 use headers and bodies. This is recorded in AR-20.
- Handlers must not log raw request bodies, config objects, keyring/TLS objects, or arbitrary
  nested objects; log explicit fields. Pino's wildcard redaction is one level deep, so a
  handler-created nested object is outside the redaction guarantee.
- Structured log tests use a `Writable` destination and assert that a token, value, password,
  private key, authorization header, and set-cookie value are redacted, including a
  `req.body.token` field and a documented one-level `*.token` field.

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
RD-05 certificate validation. ST-38 tests the exact-30-second, 30-second-plus-1 ms, and
early/late boundaries with an injected clock; RD-02 does not implement a token or agent
certificate validator (RD-03/RD-05 own those flows).

## Operational Behavior

- `/health` stays 200 during a database outage; it is liveness only.
- `/ready` returns 503 during a database outage, missing keyring, malformed CA, or audit probe
  failure.
- Readiness probes do not write audit events and do not mutate configuration.
- The readiness database pool is a disposable singleton; the secure runtime closes it during
  shutdown.
- A readiness timeout is logged once with `probe: "timeout"`; repeated probes do not leak
  connection strings.
- The outer 2 s timeout ends the readiness response; it does not cancel an in-flight database
  query. The pool connection timeout and connection cap bound the residual work.

## Integration Points

- 03-01 supplies config and keyring status.
- 03-02 supplies TLS material and the secure listener lifecycle.
- RD-07 will add the audit writer and may add a write-readiness check; the read-only probe is
  intentionally allowed by RD-02.
- RD-13 uses the same `/health` and `/ready` contract.
- RD-14 tests both endpoints in release verification.

## Testing Requirements

- ST-27–ST-32 and ST-38 in [07-testing-strategy.md](07-testing-strategy.md) cover liveness,
  readiness success/failure/timeout, error envelopes, log redaction, and clock-skew boundaries.
- Readiness tests inject fake probes for the failure matrix and use a real migrated database
  for the success path.
- Logging tests capture pino output and assert both redaction and request correlation.
- No test logs a real key, password, or token.

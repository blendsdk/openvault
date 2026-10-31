# Contracts, Logging, and Runtime: RD-03

> **Document**: 03-04-contracts-logging-runtime.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the shared API schemas, the log sanitizer and redaction rules, and the Node
24.7+ runtime baseline. These are cross-cutting controls that keep the server, tests, and UI in
sync and keep authentication secrets out of logs.

## Architecture

### Current Architecture

`@openvault/api-contract` exports project, secret, and ULID schemas. The server logger has a fixed
redaction list but no message sanitizer. The workspace runs Node 22.23; Node 24.21 is installed
but not selected.

### Proposed Changes

1. Add `packages/api-contract/src/auth.ts` with strict Zod schemas and export it from `index.ts`.
2. Add `packages/core/src/ids.ts` `newUlid()` and tests.
3. Add a pino `hooks.logMethod` sanitizer and expand `REDACT_PATHS`.
4. Raise the Node baseline in `package.json`, `.nvmrc`, CI, `@types/node`, and docs.
5. Add the approved `openid-client` dependency to `apps/server/package.json`.

## Implementation Details

### API Contracts

```ts
export const authMethodSchema = z.enum(["local", "oidc"]);

export const authUserSchema = z.strictObject({
  id: ulidSchema,
  name: z.string().min(1).max(100),
  email: z.string().email().max(320).nullable(),
  authMethod: authMethodSchema,
});

export const loginRequestSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});

export const sessionResponseSchema = z.strictObject({
  user: authUserSchema,
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime(),
});

export const refreshResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32),
});

export const sessionEntrySchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  authMethod: authMethodSchema,
  current: z.boolean(),
});

export const sessionListSchema = z.strictObject({
  sessions: z.array(sessionEntrySchema),
});

export const metaAuthSchema = z.strictObject({
  local: z.boolean(),
  oidc: z.boolean(),
});
```

Notes:
- Zod 4 uses `z.iso.datetime()` for ISO timestamps. If the installed version does not expose it,
  use `z.string().datetime()`; confirm during implementation.
- Email in `authUserSchema` is nullable because a principal may have no email. Local users always
  have one; OIDC JIT users require one.
- `csrfToken` is base64url; `min(32)` is a lower bound, not a format assertion.
- The schemas are the source of truth for controller responses and tests. The controllers use
  `.parse()` or return values typed against the inferred types.

### ULID Generator

```ts
export function newUlid(now: number = Date.now()): Ulid;
```

- 48-bit timestamp (10 Crockford characters) + 80 bits of `randomBytes(10)` (16 characters).
- Reject a non-finite or negative timestamp.
- Tests verify the length, alphabet, sortable timestamp prefix, and two calls differ.

### Log Sanitizer

```ts
export const AUTH_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "currentPassword",
  "newPassword",
  "csrfToken",
  "token",
  "code",
  "codeVerifier",
  "nonce",
  "state",
  "idToken",
  "accessToken",
  "refreshToken",
  "value",
  "privateKey",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.csrfToken",
  "*.token",
  "*.code",
  "*.codeVerifier",
  "*.nonce",
  "*.state",
  "*.idToken",
  "*.accessToken",
  "*.refreshToken",
  "*.value",
  "*.privateKey",
  "req.body.password",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.token",
  "req.body.value",
  "req.body.privateKey",
];

export function sanitizeLogMessage(message: string): string;
export function sanitizeLogArgs(args: unknown[]): unknown[];
```

- `sanitizeLogMessage` matches the WebAFX request-log shape
  `METHOD <url> <status> <duration>ms` and removes the query string from the URL. It leaves other
  messages unchanged.
- `sanitizeLogArgs` shallow-copies an object argument with a string `url` property and strips its
  query; it sanitizes string arguments. It does not recurse into arbitrary objects.
- `createLoggerProvider` passes `hooks: { logMethod(args, method) { method.apply(this,
  sanitizeLogArgs(args)); } }` through `pinoOptions`. The provider's own `redact` remains.
- The sanitizer is defense in depth. Handlers still never log request bodies, token responses,
  passwords, or OIDC claims.

### Runtime Baseline

- `.nvmrc`: `24.21.0`.
- Root `package.json`: `"engines": { "node": ">=24.7.0" }`; root `@types/node`: `24.19.2`.
- `apps/server/package.json`: `@types/node` `24.19.2`; add `openid-client` `6.8.8`.
- `.github/workflows/ci.yml`: all three `node-version` values → `24.21.0`.
- `.github/workflows/docs.yml`: `node-version` → `24.21.0`.
- `README.md`, `CONTRIBUTING.md`, `docs/guide/getting-started.md`, `docs/guide/install.md`:
  Node.js 24.7 or newer.
- `pnpm-lock.yaml` updated by `pnpm install`.
- No Dockerfile exists in this release; RD-14 owns the image baseline. The plan notes the image
  must use Node 24.7+ when it is created.

### Application Wiring

- `createApplication` registers `createAuthPlugin({ config, database })`.
- The plugin registers:
  - `sessions` → `SessionService` with `MemoryCacheProvider({ rootKey: "openvault",
    serviceName: "sessions", cleanupIntervalMs: 60_000 })`.
  - `credentials` → `CredentialsRepository(database)`.
  - `password` → the stateless password module (or a small object with the functions).
  - `oidc` → `OidcClient` when `config.oidc` is defined.
  - `oidcState` → `OidcStateStore` when `config.oidc` is defined.
  - `oidcIdentities` → `OidcIdentityService(database)` when `config.oidc` is defined.
- The plugin installs `sessionMiddleware`, `passwordChangeGate`, and `csrfGuard`.
- `createApplication` registers `AuthController` at `/v1/auth`, `OidcController` at `/v1/auth`,
  and `MetaController` at `/v1/meta`.
- Service disposal: `sessions.destroy()`, `oidc.shutdown()`, `oidcState.destroy()`.
- Test injection: `SecureApplicationDependencies` gains optional `authOverrides` with
  `fetch`, `now`, and `cache`. Production leaves it empty. This is test seam, not a public API.

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Invalid request body | WebAFX validation envelope; 400 | AR-12 |
| Unknown response shape | Tests parse with the shared schema; a mismatch fails the test | AR-12 |
| Log hook throws | Pino hook must not throw; sanitizer handles unknown values defensively | AR-13 |
| Node version below 24.7 | Startup fails at the first Argon2 call; the README and CI prevent it | AR-18 |
| `openid-client` unavailable | Dependency install failure; no runtime fallback | AR-2 |

## Testing Requirements

- `packages/api-contract/tests/auth.spec.test.ts` for every schema: valid shape, unknown field
  rejection, boundary lengths, nullable email, ISO timestamps.
- `packages/core/tests/ids.spec.test.ts` for `newUlid`.
- `apps/server/tests/logging.spec.test.ts` extended for the sanitizer: request-log message, object
  `url`, unrelated messages, and auth fields.
- A Node baseline check in CI is implicit; the verify run under Node 24.21.0 proves it.

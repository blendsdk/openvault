# Sessions, Cookies, and CSRF: RD-03

> **Document**: 03-01-sessions-csrf.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the browser session boundary: the opaque session record, the
`__Host-ov_session` cookie, refresh rotation, list/revoke, principal-disable invalidation, the
session middleware, and CSRF with a same-origin guard. It uses the existing memory cache and the
WebAFX CSRF middleware. It adds no database table and no new dependency.

## Architecture

### Current Architecture

The server has no session concept. WebAFX installs `cookieParser()` during `initialize()`, so a
plugin can read `req.cookies`. The WebAFX cache package provides an in-memory provider with TTL,
but no enumeration or atomic take. The WebAFX CSRF middleware compares a header with an expected
token in constant time.

### Proposed Changes

1. `SessionService` owns the cache, the public-ID index, rotation, revocation, and expiry.
2. `cookie.ts` owns the cookie name and attributes.
3. `middleware.ts` resolves the session and the principal on every request and attaches
   `req.auth`.
4. `csrf.ts` wraps the WebAFX CSRF middleware and adds the origin guard.
5. `plugin.ts` creates the services and installs the middleware before controllers.

The auth plugin is registered in `createApplication` and runs after WebAFX core middleware and
before controllers. It registers the singleton services `sessions`, `credentials`, `password`,
`oidc` (when configured), and `oidcState`.

## Implementation Details

### New Types/Interfaces

```ts
/** How the current browser session authenticated. */
export type AuthMethod = "local" | "oidc";

/** A session record stored in the memory cache. Never contains an OIDC token. */
export interface SessionRecord {
  readonly publicId: string;
  readonly principalId: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authMethod: AuthMethod;
}

/** The authenticated request context attached by the session middleware. */
export interface AuthContext {
  readonly session: SessionRecord;
  readonly user: AuthUser;
  readonly mustChangePassword: boolean;
}

/** The public user shape shared with the API contract. */
export interface AuthUser {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly authMethod: AuthMethod;
}
```

`Express.Request` gains `auth?: AuthContext`.

### New Functions/Methods

```ts
export class SessionService {
  constructor(options: {
    readonly config: OpenVaultConfig;
    readonly cache: CacheProvider;
    readonly now?: () => number;
    readonly sweepIntervalMs?: number;
  });

  create(input: { principalId: string; authMethod: AuthMethod }): Promise<{
    secretId: string;
    record: SessionRecord;
  }>;

  get(secretId: string): Promise<SessionRecord | undefined>;
  rotate(secretId: string): Promise<{
    secretId: string;
    record: SessionRecord;
  } | undefined>;
  revoke(publicId: string, principalId: string): Promise<boolean>;
  revokeAllForPrincipal(principalId: string): Promise<number>;
  list(principalId: string): Promise<SessionRecord[]>;
  destroy(): Promise<void>;
}
```

- `create` generates a 32-byte secret (`base64url`) and a public ULID (`newUlid()`), a 32-byte
  CSRF token, and an absolute `expiresAt = now + config.sessionTtlHours * 3_600_000`. It stores
  `session:<sha256(secretId)>` with TTL `ceil(remaining / 1000)` and records the indexes.
- `get` hashes the secret, reads the cache, rejects an expired record (and deletes it), and
  returns the record.
- `rotate` uses a per-secret single-flight map. It reads the record, rejects if expired, creates a
  new secret and CSRF token, stores the new record with the same `publicId`, `createdAt`, and
  `expiresAt`, updates the indexes, and deletes the old key. Concurrent callers for the same old
  secret share the result. The old secret no longer resolves.
- `revoke` looks up the secret hash by public ID, verifies `principalId`, deletes the cache key,
  and removes both index entries. It returns `false` for an unknown or foreign session.
- `revokeAllForPrincipal` iterates the principal index and deletes each cache key.
- `list` returns the principal's live records sorted by `createdAt`. It never returns the secret
  or CSRF token.
- `destroy` clears the sweeper interval and shuts down the cache.
- The sweeper runs every 60 seconds and removes index entries whose `expiresAt <= now`; it is
  `unref()`'d. The cache's own TTL handles the values.

```ts
export const SESSION_COOKIE_NAME = "__Host-ov_session";

export function readSessionCookie(req: Request): string | undefined;
export function setSessionCookie(res: Response, secretId: string, maxAgeSeconds: number): void;
export function clearSessionCookie(res: Response): void;
```

Cookie attributes: `httpOnly: true`, `secure: true`, `sameSite: "lax"`, `path: "/"`, no
`domain`, `maxAge` in milliseconds. `clearSessionCookie` uses `maxAge: 0` and the same attributes.
`readSessionCookie` accepts only a base64url string that decodes to exactly 32 bytes.

```ts
export function sessionMiddleware(
  sessions: SessionService,
  credentials: CredentialsRepository,
): RequestHandler;

export function requireSession(req: Request): AuthContext;
export function passwordChangeGate(): RequestHandler;
```

- `sessionMiddleware` ignores requests without a session cookie. With a cookie, it resolves the
  session, loads the principal's `status`, `name`, `email`, and `must_change` in one query, and
  attaches `req.auth`. A missing/expired session or a non-active principal clears the cookie and
  leaves `req.auth` undefined. A non-active principal also revokes the session.
- `requireSession` throws `ApiError(401, "authentication_required", "Authentication required")`
  when `req.auth` is absent.
- `passwordChangeGate` runs on every request after `sessionMiddleware`. If `req.auth` exists and
  `mustChangePassword` is true, it allows only `GET /v1/auth/me`, `POST /v1/auth/password`,
  `POST /v1/auth/logout`, and `/v1/meta/*`; everything else gets
  `ApiError(403, "password_change_required", "Password change required")`. The path comparison uses
  the normalized path from `normalizeRequestPath`.

```ts
export function originGuard(config: OpenVaultConfig): RequestHandler;
export function csrfGuard(): RequestHandler;
```

- `originGuard` applies to unsafe methods. If `Origin` is present, it must equal
  `config.baseUrl.origin`; otherwise `Sec-Fetch-Site` must be `same-origin`; if both are absent,
  reject with `ApiError(403, "csrf_invalid", "Invalid or missing CSRF token")`. It is installed on
  the local login route and on all cookie-authenticated unsafe requests.
- `csrfGuard` wraps `csrfMiddleware({ expectedToken: req => req.auth?.session.csrfToken })`. It
  calls the wrapped middleware only when `req.auth` exists; otherwise it calls `next()`. This keeps
  future bearer/mTLS routes free of cookie CSRF checks.
- The auth plugin installs `sessionMiddleware`, `passwordChangeGate`, then `csrfGuard` before
  controllers.

### Integration Points

- `app.ts` registers the auth plugin before `createLoggerPlugin` or after; plugin priority controls
  order, not registration order. Use priority 15.
- `AuthController` resolves `sessions` and `credentials` from `req.services`.
- `OidcController` creates a session with `authMethod: "oidc"`.
- `ReadyController` is unaffected.
- `SecureWebApplication` shutdown disposes the `sessions` service, which calls `destroy()`.
- `SecureWebApplication` gains a public `getService<T>(name: string): Promise<T>` wrapper around
  the protected service container. Tests use it to create sessions directly; the container itself
  stays protected.

## Code Examples

### Setting the cookie after login

```ts
const { secretId, record } = await sessions.create({
  principalId,
  authMethod: "local",
});
setSessionCookie(res, secretId, remainingSeconds(record));
this.ok(res, {
  user: toAuthUser(record, principal),
  expiresAt: new Date(record.expiresAt).toISOString(),
  csrfToken: record.csrfToken,
  mustChangePassword: principal.mustChange,
  lastLoginAt: new Date(record.createdAt).toISOString(),
});
```

### Rotating on refresh

```ts
const rotated = await sessions.rotate(readSessionCookie(req) ?? "");
if (rotated === undefined) {
  clearSessionCookie(res);
  throw new ApiError(401, "authentication_required", "Authentication required");
}
setSessionCookie(res, rotated.secretId, remainingSeconds(rotated.record));
this.ok(res, {
  expiresAt: new Date(rotated.record.expiresAt).toISOString(),
  csrfToken: rotated.record.csrfToken,
});
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Missing session | `401 authentication_required` | AR-14 |
| Expired session | Delete it, clear the cookie, `401` | AR-6 |
| Disabled principal | Revoke the session, clear the cookie, `401` | AR-6 |
| Forced password change | `403 password_change_required` outside the allowlist | AR-17 |
| Missing/wrong CSRF token | `403 csrf_invalid` from WebAFX | AR-9 |
| Cross-origin unsafe request | `403 csrf_invalid` from the origin guard | AR-9 |
| Concurrent refresh | Single-flight; both callers receive the same rotated session | AR-6 |
| Session cache failure | Propagate a 500; never fall back to an unauthenticated context | AR-6 |

## Testing Requirements

- Unit tests for session create/get/rotate/revoke/list, expiry, index cleanup, concurrent refresh,
  and malformed secrets.
- Unit tests for cookie attributes, reading malformed cookies, and clearing.
- Unit tests for the origin guard (same-origin, cross-origin, `same-site`, missing headers).
- Integration tests for `/me`, `/refresh`, `/logout`, `/sessions`, `/sessions/:id`, the forced-change
  gate, and disable invalidation.
- Integration tests for CSRF success/failure on logout, refresh, password change, and session
  delete.

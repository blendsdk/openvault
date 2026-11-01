# Refresh, Logout, and Bearer Authentication: RD-04 CLI Authentication

> **Document**: 03-04-refresh-bearer.md
> **Parent**: [Index](00-index.md)
> **References**: [AR-2](00-ambiguity-register.md#ar-2--token-contract), [AR-4](00-ambiguity-register.md#ar-4--authentication-context), [AR-6](00-ambiguity-register.md#ar-6--refresh-serialization), [AR-18](00-ambiguity-register.md#ar-18--invalid-authorization-handling), [AR-21](00-ambiguity-register.md#ar-21--rotation-row-context-and-unique-races), [AR-23](00-ambiguity-register.md#ar-23--transaction-primitives), [AR-35](00-ambiguity-register.md#ar-35--forced-change-logout)

## Overview

This component turns the issued refresh family into a working session. Refresh rotates the
opaque token inside a transaction that locks the principal and the refresh row. Logout revokes
the family and is idempotent. Bearer middleware verifies the JWT and checks the principal and
live family before attaching a CLI auth context. Browser cookies never authorize a CLI route,
and an invalid bearer never falls back to a cookie.

## Architecture

### Current architecture

Only browser session middleware exists (`apps/server/src/auth/middleware.ts:34-77`). `AuthContext`
requires a browser `session` (`apps/server/src/auth/types.ts:46-53`). The Origin and CSRF guards
assume every attached auth context is a browser session
(`apps/server/src/auth/csrf.ts:43-46,79-94`). The `cli_sessions` table exists but has no live-row
unique index (`apps/server/migrations/20261030094203_initial.up.sql:77-87`).

### Proposed changes

1. Add CLI family operations to `apps/server/src/auth/cli-sessions.ts`.
2. Add the refresh/logout orchestration to `apps/server/src/auth/cli-auth-service.ts`.
3. Add the bearer middleware and CLI context to `apps/server/src/auth/middleware.ts` and
   `types.ts`.
4. Add `/refresh`, `/logout`, and `/me` routes to `apps/server/src/controllers/cli-auth.ts`.
5. Update the Origin, CSRF, and forced-change guards to branch on `req.auth.kind`.
6. Register the CLI controller in `app.ts`.

## Implementation Details

### CLI session repository

```ts
export interface CliFamily {
  readonly familyId: string;
  readonly principalId: string;
  readonly expiresAt: Date;
}

export interface CliRefreshRow extends CliFamily {
  readonly rowId: string;
  readonly revokedAt: Date | null;
}

export interface CliPrincipal {
  readonly principalId: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: "active" | "disabled";
  readonly mustChange: boolean;
}

export class CliSessionRepository {
  createFamily(principalId, context): Promise<{ row: CliRefreshRow; refreshToken: string }>;
  findFamilyByHash(hash: Buffer): Promise<CliRefreshRow | undefined>;
  findActiveContext(principalId, familyId): Promise<CliPrincipal | undefined>;
  rotateRefresh(hash, context): Promise<RotateResult>;
  logoutByHash(hash): Promise<void>;
  listFamilies(principalId): Promise<CliFamily[]>;
  revokeOwnedFamily(familyId, principalId): Promise<boolean>;
  cleanup(nowMs: number, batchSize: number): Promise<number>;
}
```

`hashRefreshToken(raw: string): Buffer` returns the SHA-256 bytes of the canonical 43-character
ASCII token. The raw token is never stored or logged.

`createFamily`:

1. Generate a ULID row id and family id, and 32 random bytes as base64url.
2. Insert `(id, family_id, principal_id, refresh_hash, expires_at, ip, user_agent)`.
3. Use `now() + interval '12 hours'` for `expires_at`, so the database owns the absolute
   family clock.
4. Return the inserted row and the raw refresh token.

`findActiveContext(principalId, familyId)` is the one query used by bearer authentication:

```sql
SELECT p.id, p.status, p.name, p.email,
       COALESCE(c.must_change, false) AS must_change
  FROM principals p
  JOIN cli_sessions s
    ON s.principal_id = p.id AND s.family_id = :familyId
  LEFT JOIN local_credentials c ON c.principal_id = p.id
 WHERE p.id = :principalId
   AND p.status = 'active'
   AND s.revoked_at IS NULL
   AND s.expires_at > now()
 LIMIT 1
```

If no row returns, the family is not live or the principal is not active.

### Refresh transaction

The controller first hashes the token, performs a non-locking `findFamilyByHash`, returns
`401 invalid_refresh_token` when absent, and only then consumes the family rate bucket. This
ordering lets rotation reuse the bucket.

`rotateRefresh` runs `database.withTransaction`:

1. `SELECT p.id, p.status, p.name, p.email, COALESCE(c.must_change, false) AS must_change
   FROM principals p LEFT JOIN local_credentials c ... WHERE p.id = :principalId
   FOR UPDATE OF p`. This is the per-principal lock.
2. Re-select the refresh row by hash with `FOR UPDATE`.
3. If the row is absent, return `invalid`.
4. If `revoked_at` is non-null, revoke every row in the family with
   `UPDATE cli_sessions SET revoked_at = COALESCE(revoked_at, now())
   WHERE family_id = :familyId AND revoked_at IS NULL`, then return `reuse`.
5. If `expires_at <= now()`, return `expired` without issuing a token.
6. If the principal is missing or not active, revoke the family and return `disabled`.
7. Set the old row `revoked_at = now()`, then insert a new row with the same `family_id`,
   `principal_id`, and original `expires_at`, a new row ULID, a new 32-byte token, its hash, and
   the current request's `ip`/`user_agent`. Return `rotated` with the new row and principal.
8. Commit.

The transaction returns a discriminated result, not an exception, for expected invalid cases.
A PostgreSQL unique violation (`23505`) on the live-family index is treated as reuse: a separate
revocation updates the family and the request returns `401 invalid_refresh_token`. Any other
database error propagates.

After a successful rotation, `CliAuthService` signs the new access token. If signing fails, it
revokes the family and propagates a generic 500; no token is returned.

### Logout transaction

The logout body is `{ refreshToken }`. The controller validates the body, hashes the token,
and calls `logoutByHash`:

1. Non-locking lookup. If the token is unknown, return 204; it may have been retained or
   already cleaned up.
2. In a transaction, lock the principal row, then update every row in the family to
   `revoked_at = COALESCE(revoked_at, now())`.
3. Commit. A concurrent refresh either waits and then revokes the whole family, or commits
   first and is revoked by this update.

Logout never requires a bearer token. A well-formed unknown token returns 204. A malformed
token returns 400 `validation_error` before any lookup.

### Auth context and bearer middleware

```ts
export interface BrowserAuthContext {
  readonly kind: "browser";
  readonly session: SessionRecord;
  readonly user: AuthUser;
  readonly mustChangePassword: boolean;
}

export interface CliAuthContext {
  readonly kind: "cli";
  readonly principalId: string;
  readonly familyId: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly user: AuthUser;
  readonly mustChangePassword: boolean;
}

export type AuthContext = BrowserAuthContext | CliAuthContext;

export function requireSession(req: Request): BrowserAuthContext;
export function requireCli(req: Request): CliAuthContext;
export function requirePrincipal(req: Request): AuthContext;
```

`cliAuthMiddleware(signingKeys, sessions)` runs before `sessionMiddleware`:

- No `Authorization` header: pass through.
- Header present: mark bearer intent by leaving the header in place. Parse the scheme
  case-insensitively. If the scheme is not `Bearer` or the token is empty, leave
  unauthenticated and pass through.
- Call `SigningKeyService.verifyAccessToken`. On `CliTokenError`, leave unauthenticated. On
  `SigningKeyUnavailableError`, propagate to the error handler.
- Load the active context with the one query above. If absent, leave unauthenticated.
- Attach `kind: "cli"` with the principal user (`authMethod: "local"`), family, `jti`, and
  `expiresAt = exp * 1000`.

`sessionMiddleware` skips cookie resolution when `req.auth` is already set **or** any
`Authorization` header is present. This is the no-fallback rule. It still resolves a browser
session normally when no Authorization header exists.

### Guard changes

`originGuard`:

- Safe methods pass.
- The local browser login path still requires the same-origin check.
- A browser context requires the Origin/Sec-Fetch-Site check.
- A CLI context or no context passes to route authentication.

`csrfGuard`:

- Only a browser context is checked.
- A CLI context or no context passes to route authentication.
- The session liveness check runs only for browser contexts.
- Every `/v1/auth/cli` path is exempt from both browser guards, even when a browser cookie is
  present. CLI handlers never read that cookie; route authentication returns 401 for a
  browser-only caller, and CLI refresh/logout authorize on their refresh token.
- The browser-only `/v1/auth/refresh` handler rejects any request with an Authorization
  header before reading the cookie, because the middleware no longer resolves the cookie and the
  browser guards would otherwise be bypassed.

`passwordChangeGate`:

- No auth context passes.
- A browser context allows the existing browser allowlist.
- A CLI context allows `GET /v1/auth/cli/me` and `POST /v1/auth/cli/logout`. Logout is public
  and authorizes on the refresh token, but a client may still send its access token; allowing
  the path keeps logout available in that case.
- Every other CLI path returns `403 password_change_required`.

### Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| POST | `/v1/auth/cli/login` | public + limits | Issue tokens |
| POST | `/v1/auth/cli/refresh` | refresh token + limits | Rotate tokens |
| POST | `/v1/auth/cli/logout` | refresh token | Revoke family, 204 |
| GET | `/v1/auth/cli/me` | CLI bearer | Current user + forced-change flag |
| GET | `/v1/auth/cli/sessions` | CLI bearer | Family list |
| DELETE | `/v1/auth/cli/sessions/:familyId` | CLI bearer | Revoke owned family |

The controller applies `requireCli(req)` in handlers. WebAFX's `.secure()` is not used because
the application does not register a WebAFX principal provider.

### Error handling

| Error case | Handling strategy | AR |
|---|---|---|
| Unknown/expired/reused/disabled refresh | `401 invalid_refresh_token`; reuse/disable revoke family | AR-6 |
| Concurrent refresh loser | Sees the revoked row and revokes the family; 401 | AR-6 |
| Unique live-family race | Treat as reuse, revoke family, 401 | AR-21 |
| Logout unknown token | 204 | AR-8 |
| Logout malformed token | 400 validation_error | AR-8 |
| Missing/invalid bearer | No context; protected route returns 401 authentication_required | AR-18 |
| Wrong alg/iss/aud/kid/kind/exp | Pure verifier rejects; no context | AR-22 |
| Disabled principal or revoked family | No context; 401 | AR-2 |
| Browser cookie on CLI route | `requireCli` rejects; 401 | AR-4 |
| Forced-change CLI context | `/cli/me` and logout allowed; other routes 403 | AR-4, AR-35 |
| Signing key unavailable | Generic 500; no token issued | AR-28 |

> **Traceability:** This component is governed by AR-2, AR-4, AR-6, AR-18, AR-21, AR-22,
> AR-23, AR-28, and AR-35. The RD owns the token, refresh, and bearer acceptance criteria.

## Testing Requirements

- Repository integration tests for create, lookup, rotation, revoke, active context, list,
  cleanup, and unique-race handling.
- Refresh integration tests for rotation, old-token failure, unchanged expiry, reuse,
  concurrent refresh, logout, disable, and forced-change.
- Bearer integration tests for valid token, malformed header, wrong scheme, lowercase `bearer`,
  invalid token plus valid cookie, cookie-only CLI route, wrong claims, expired token, revoked
  family, and CSRF/Origin-free CLI POST.
- Middleware unit tests for the context union, `requireSession`, `requireCli`, and the gate.

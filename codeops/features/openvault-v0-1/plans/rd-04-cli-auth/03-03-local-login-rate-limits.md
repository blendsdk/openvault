# Local Login and Rate Limits: RD-04 CLI Authentication

> **Document**: 03-03-local-login-rate-limits.md
> **Parent**: [Index](00-index.md)
> **References**: [AR-5](00-ambiguity-register.md#ar-5--shared-login-behavior), [AR-10](00-ambiguity-register.md#ar-10--refresh-limits), [AR-15](00-ambiguity-register.md#ar-15--shared-limiter-mechanism)

## Overview

This component extracts the existing browser local-login flow into one service and exposes the
same limiter objects to both browser and CLI routes. CLI login therefore shares normalization,
lockout, generic failure, dummy verification, failure/success counters, the post-success hash
recheck, and the per-IP/per-account buckets. The CLI controller only issues the token family.

## Architecture

### Current architecture

`AuthController.routes()` normalizes the identifier, looks up the credential, performs every
failure check, calls Argon2, updates counters, creates a browser session, and rechecks the
password hash (`apps/server/src/controllers/auth.ts:77-170`). The limiter middleware instances
are created inside `routes()`, so a second controller would get separate in-memory maps
(`apps/server/src/controllers/auth.ts:77-94`). `WebAFX rateLimitMiddleware` keeps its state in a
closure (`blendsdk/webafx/application/rate-limiter.js:21-55`).

### Proposed changes

1. Add `apps/server/src/auth/local-login.ts` with `LocalLoginService`.
2. Add `apps/server/src/auth/login-rate-limits.ts` with one per-app `AuthRateLimitService`.
3. Register the service in the auth plugin.
4. Refactor the browser login handler to use the service and shared middleware.
5. Add the CLI login route and controller.

## Implementation Details

### Local login service

```ts
export interface LocalLoginInput {
  readonly identifier: string;
  readonly password: string;
}

export interface LocalLoginSuccess {
  readonly principalId: string;
  readonly name: string;
  readonly email: string | null;
  readonly mustChange: boolean;
  /** Hash that was verified; the caller rechecks it after issuing its credential. */
  readonly passwordHash: string;
}

export type LocalLoginResult =
  | { readonly ok: true; readonly credential: LocalLoginSuccess }
  | { readonly ok: false };

export class LocalLoginService {
  constructor(options: { readonly credentials: CredentialsRepository });
  login(input: LocalLoginInput, log?: Logger): Promise<LocalLoginResult>;
  revalidate(principalId: string, expectedHash: string): Promise<boolean>;
}
```

`login` performs, in order:

1. Trim and lowercase the identifier.
2. Load the credential by normalized email.
3. For unknown, disabled, locked, or out-of-policy hash: perform `dummyVerify`, return
   `{ ok: false }`. A policy-hash rejection also logs `stored password hash rejected` with the
   principal id when a logger is supplied.
4. Verify the password. On mismatch, call `recordFailure(principalId, passwordHash)` and
   return `{ ok: false }`.
5. Call `recordSuccess(principalId, passwordHash)`. A false result means a concurrent password
   change or lock won; return `{ ok: false }`.
6. Return the credential fields and the verified hash.

`revalidate` loads `findByPrincipalId` and compares the current hash with the expected hash. A
missing row or a changed hash returns `false`. The browser controller uses it after session
creation; the CLI path uses the repository's lock-through-insert recheck instead.

The browser controller keeps its existing order: login, create browser session, revalidate,
revoke the session on failure. The CLI controller uses the stronger lock-through-insert rule:
`CliSessionRepository.createFamilyForLogin` takes the per-principal `FOR UPDATE` lock, re-reads
the verified hash, and inserts the family only if the hash is unchanged. A concurrent password
change therefore either waits for the login to finish and then revokes the family, or finishes
first and makes the login return `credential_changed` without a family. A post-insert re-read
alone is not used for CLI because it does not block on an uncommitted password update.

### Shared rate limits

```ts
export interface AuthRateLimitService {
  /** 5/minute per IP, shared by browser and CLI login. */
  readonly loginIp: RequestHandler;
  /** 10/hour per normalized identifier hash, shared by browser and CLI login. */
  readonly loginAccount: RequestHandler;
  /** 60/minute per IP for CLI refresh. */
  readonly refreshIp: RequestHandler;
  /** 30/minute per family, consumed after a refresh-token lookup. */
  consumeRefreshFamily(familyId: string, req: Request, res: Response): Promise<void>;
}

export function createAuthRateLimitService(): AuthRateLimitService;
```

The service creates four `rateLimitMiddleware` instances exactly once per application:

| Instance | Limit | Key |
|---|---|---|
| `loginIp` | 5 / 60s | `req.ip` |
| `loginAccount` | 10 / 3600s | `sha256("account:" + normalizedIdentifier)` |
| `refreshIp` | 60 / 60s | `req.ip` |
| `refreshFamily` | 30 / 60s | `req.cliRefreshFamilyId` |

The account key is computed by a shared exported
`accountRateKey(identifier: unknown): string`; it hashes the normalized identifier so the
limiter never stores an email.

Because route definitions are synchronous and `ServiceContainer.get` is asynchronous, the
controllers use these small wrappers:

```ts
export function loginIpLimit(): RequestHandler;
export function loginAccountLimit(): RequestHandler;
export function refreshIpLimit(): RequestHandler;
```

Each wrapper resolves `authRateLimits` from `req.services`, delegates to the named middleware,
and forwards a resolution failure to `next`. The family limiter is not a route middleware:
`consumeRefreshFamily` sets the internal `req.cliRefreshFamilyId` field for the current request
and invokes the family instance after a successful token lookup. This preserves "family bucket
checked after lookup" and prevents rotation from resetting the bucket.

The `Express.Request` augmentation adds one internal optional field:

```ts
/** CLI family id used only for the post-lookup refresh limit. */
cliRefreshFamilyId?: string;
```

### CLI login route

`POST /v1/auth/cli/login`:

1. Apply `loginIpLimit()` then `loginAccountLimit()`.
2. Parse with `cliLoginRequestSchema`; failure is `400 validation_error`.
3. Call `LocalLoginService.login`.
4. On failure, return `401 invalid_credentials` with no details.
5. Create a refresh family through `CliSessionRepository.createFamilyForLogin`, which locks
   the principal row and rechecks the verified hash before inserting.
6. If the hash changed, return `401 invalid_credentials` with no family created.
7. Sign the access token through `CliAuthService`. If signing fails, revoke the new family and
   return a generic 500.
8. Return `cliTokenResponseSchema` with the public user, `authMethod: "local"`, and
   `mustChangePassword`.
9. Never set a cookie.

IP storage uses Express's trusted `req.ip`. User-agent storage trims the header and truncates it
to 512 characters; an absent or empty header stores `null`.

### Error handling

| Error case | Handling strategy | AR |
|---|---|---|
| Unknown, wrong, disabled, locked account | One `401 invalid_credentials`; full dummy/failed verification | AR-5 |
| Policy hash rejected | Dummy verification; optional safe log; generic 401 | AR-5 |
| Success counter loses a race | Generic 401; no session or family issued | AR-5 |
| Password changed during login | Principal lock plus hash recheck returns `credential_changed`; no family issued | AR-5, AR-33 |
| Access-token signing fails after family insert | Revoke the family; generic 500; no token returned | AR-28 |
| Per-IP or per-account limit | WebAFX `429 RATE_LIMIT_EXCEEDED` | AR-5, AR-15 |
| Family limit after lookup | `429 RATE_LIMIT_EXCEEDED`; no rotation attempted | AR-10 |
| Limiter service unavailable | Propagate to the error handler; do not bypass the limit | AR-15 |
| Malformed login body | `400 validation_error` | AR-8 |

> **Traceability:** Shared login behavior and limiter sharing are governed by AR-5, AR-10, and
> AR-15. The RD owns the functional login and rate-limit criteria.

## Testing Requirements

- Unit tests for `LocalLoginService` with one fake credential lookup and real Argon2: unknown,
  disabled, locked, out-of-policy hash, wrong password, success reset, CAS failure, and
  revalidation.
- Unit tests for `accountRateKey` normalization and hashing.
- Integration tests for CLI login success, generic failures, shared lockout in both directions,
  shared per-IP and per-account buckets, forced-change login, and the password-change/login
  lock race.
- Browser login regression tests must keep passing with the refactored service and shared
  limiter wrappers.

# Local Authentication: RD-03

> **Document**: 03-02-local-auth.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns local password login, Argon2id hashing and verification, the lockout counter,
the per-IP and per-account rate limits, password change, and the forced-change gate. It reuses the
existing `principals` and `local_credentials` tables and adds no migration.

## Architecture

### Current Architecture

The schema constrains `password_hash` to the `$argon2id$` PHC prefix and stores `must_change`,
`failed_count`, `locked_until`, and `updated_at`. The config allows 1–24 hour sessions, defaulting
to 8. WebAFX provides `rateLimitMiddleware`; no custom limiter is needed. Node 22 cannot hash
Argon2; the approved Node 24.7+ baseline provides `crypto.argon2` and `crypto.argon2Sync`.

### Proposed Changes

1. `password.ts` implements PHC encoding, verification, the fixed dummy hash, and password policy.
2. `credentials.ts` owns the SQL for lookup, failed/successful attempts, password change, and
   principal status.
3. `AuthController.localLogin` orchestrates the login flow.
4. The auth routes apply the per-IP and per-account limiters before the handler.
5. `AuthController.changePassword` implements the forced-change endpoint.

## Implementation Details

### Password Hashing

```ts
export const ARGON2_MEMORY_KIB = 65_536;
export const ARGON2_PASSES = 3;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_TAG_LENGTH = 32;
export const ARGON2_SALT_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, phc: string): Promise<boolean>;
export function dummyVerify(password: string): Promise<void>;
export function validateNewPassword(password: string): void;
```

- `hashPassword` generates a 16-byte salt and calls `argon2` (the callback API wrapped in a
  Promise) with `{ message, nonce: salt, memory: 65536, passes: 3, parallelism: 1, tagLength: 32 }`.
  It returns `$argon2id$v=19$m=65536,t=3,p=1$<salt-b64>$<tag-b64>` with base64 **without**
  padding.
- `verifyPassword` parses the PHC string strictly. It accepts only `argon2id`, version 19,
  `m=65536`, `t=3`, `p=1`, a 16-byte salt, and a 32-byte tag. It derives with the stored salt and
  parameters and compares with `timingSafeEqual`. Malformed or out-of-policy hashes return
  `false`; they never throw into the request path.
- `dummyVerify` derives against a fixed, valid dummy PHC string and discards the result. It is
  used for unknown, disabled, and locked accounts so the response time is comparable.
- `validateNewPassword` rejects lengths outside 12–1024. It does not trim, normalize, or apply
  composition rules.
- Password input is never logged, trimmed, or echoed.

### Credentials Repository

```ts
export interface LocalCredential {
  readonly principalId: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: "active" | "disabled";
  readonly passwordHash: string;
  readonly mustChange: boolean;
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
  readonly updatedAt: Date;
}

export class CredentialsRepository {
  findByIdentifier(identifier: string): Promise<LocalCredential | undefined>;
  findStatus(principalId: string): Promise<{
    status: "active" | "disabled";
    name: string;
    email: string | null;
    mustChange: boolean;
  } | undefined>;
  recordFailure(principalId: string): Promise<{
    failedCount: number;
    lockedUntil: Date | null;
  }>;
  recordSuccess(principalId: string): Promise<void>;
  changePassword(principalId: string, passwordHash: string): Promise<void>;
}
```

SQL notes:

- `findByIdentifier` joins `principals p` and `local_credentials c` on `p.id = c.principal_id`
  where `p.kind = 'user'` and `lower(p.email) = :identifier`. The identifier is normalized before
  the call.
- `recordFailure` is one atomic statement:
  ```sql
  UPDATE local_credentials
  SET failed_count = CASE
        WHEN updated_at < now() - interval '15 minutes' THEN 1
        ELSE failed_count + 1
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN updated_at < now() - interval '15 minutes' THEN 1
          ELSE failed_count + 1
        END) >= 5 THEN now() + interval '15 minutes'
        ELSE locked_until
      END,
      updated_at = now()
  WHERE principal_id = :principalId
  RETURNING failed_count, locked_until
  ```
  The statement is atomic, so concurrent failures cannot lose an increment.
- `recordSuccess` sets `failed_count = 0`, `locked_until = NULL`, and `updated_at = now()`.
- `changePassword` sets `password_hash = :hash`, `must_change = false`, resets the counters, and
  updates `updated_at`.
- `findStatus` is used by the session middleware on every request. It returns `mustChange` from
  `local_credentials` when present, otherwise `false` for OIDC-only principals.

### Local Login Flow

```text
POST /v1/auth/local/login
{ "identifier": "alice@example.com", "password": "..." }
```

1. Per-IP limiter (5/min), then per-account limiter (10/hour) run before the handler.
2. Validate the body with `loginRequestSchema`; unknown fields are rejected. Normalize the
   identifier with `trim().toLowerCase()`; reject an empty or over-320-character identifier.
3. `findByIdentifier`. If absent, `await dummyVerify(password)` and return the generic 401.
4. If `status === "disabled"`, `await dummyVerify(password)` and return the generic 401.
5. If `lockedUntil !== null && lockedUntil > now`, `await dummyVerify(password)` and return the
   generic 401. Do not extend the lock.
6. `verifyPassword(password, passwordHash)`. On failure, `recordFailure` and return the generic
   401. On success, `recordSuccess`.
7. Create the session with `authMethod: "local"`, set the cookie, and return:
   ```json
   {
     "user": { "id": "01J...", "name": "Alice", "email": "alice@example.com", "authMethod": "local" },
     "expiresAt": "2026-10-31T06:00:00.000Z",
     "csrfToken": "...",
     "mustChangePassword": false,
     "lastLoginAt": "2026-10-30T22:00:00.000Z"
   }
   ```
8. The generic failure body is exactly `401 { success: false, error: { code: "invalid_credentials",
   message: "Invalid credentials", statusCode: 401, requestId } }`. Unknown, wrong password,
   disabled, and locked all use it.

### Password Change Flow

```text
POST /v1/auth/password
{ "currentPassword": "...", "newPassword": "..." }
```

1. Require a session and a valid CSRF token.
2. Validate with `passwordChangeRequestSchema`.
3. Re-read the current credential by `principalId`; verify `currentPassword`. A wrong current
   password returns the generic 401 and increments no lockout counter (rate limited separately).
4. `validateNewPassword(newPassword)`.
5. `hashPassword(newPassword)`, then `changePassword(principalId, hash)`.
6. Revoke every other session for the principal, rotate the current session, set the new cookie,
   and return `{ expiresAt, csrfToken }`.
7. The password-change route is rate limited per IP (10/min) and per session (5/min). It does not
   use the login lockout counter.

### Rate Limits

- Per-IP: `rateLimitMiddleware({ maxRequests: 5, windowMs: 60_000 })`.
- Per-account: `rateLimitMiddleware({ maxRequests: 10, windowMs: 3_600_000, keyExtractor: req =>
  "account:" + sha256(normalizeIdentifier(req.body?.identifier)) })`.
- The account extractor returns a constant `account:invalid` key for a missing or malformed
  identifier so validation still returns 400 and memory is bounded.
- Both limiters run before the controller. The per-IP limiter is registered first.
- Rate-limit failures use WebAFX `RateLimitError`: `429 RATE_LIMIT_EXCEEDED`.

### Forced-Change Gate

- The login and `/me` responses include `mustChangePassword`.
- The `passwordChangeGate` middleware allows only `/v1/auth/me`, `/v1/auth/password`,
  `/v1/auth/logout`, and `/v1/meta/*`.
- Every other authenticated route returns `403 password_change_required`.
- The change endpoint requires the current password even during the forced change.

## Code Examples

### Verifying a password

```ts
const credential = await credentials.findByIdentifier(identifier);
if (credential === undefined) {
  await dummyVerify(password);
  throw new ApiError(401, "invalid_credentials", "Invalid credentials");
}
if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > Date.now()) {
  await dummyVerify(password);
  throw new ApiError(401, "invalid_credentials", "Invalid credentials");
}
if (!(await verifyPassword(password, credential.passwordHash))) {
  await credentials.recordFailure(credential.principalId);
  throw new ApiError(401, "invalid_credentials", "Invalid credentials");
}
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Unknown identifier | Dummy verify; generic 401 | AR-4, AR-14 |
| Wrong password | Atomic failure increment; generic 401 | AR-7, AR-14 |
| Disabled principal | Dummy verify; generic 401 | AR-14 |
| Locked principal | Dummy verify; generic 401; no lock extension | AR-7, AR-14 |
| Malformed PHC | Verification returns false; generic 401; log a sanitized warning | AR-4 |
| Weak new password | `400 validation_error` (or the route validation envelope) | AR-17 |
| Wrong current password | Generic 401; no lockout increment | AR-17 |
| Rate limit | `429 RATE_LIMIT_EXCEEDED` | AR-8 |

## Testing Requirements

- Spec tests for PHC roundtrip, parameter rejection, password policy, login success, cookie
  issuance, generic failures, lockout, rate limits, password change, and the forced-change gate.
- Impl tests for malformed PHC, atomic failure increments, dummy-verify invocation, and the
  account-key hash.
- Integration tests against PostgreSQL 16 and 17 for lockout persistence, concurrent failures,
  password change, and session revocation.

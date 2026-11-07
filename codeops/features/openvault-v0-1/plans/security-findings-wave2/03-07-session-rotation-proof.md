# Session Rotation Proof: Security Findings Wave 2

> **Document**: 03-07-session-rotation-proof.md
> **Parent**: [Index](00-index.md)

## Overview

Require a second one-time proof before a rotation receipt returns the successor session secret. Use the pre-rotation CSRF token, cache only its hash, consume the receipt when it is used, and apply the same proof to the in-flight rotation shortcut.

## Architecture

### Current Behavior

`sessions.ts:133-147` returns the in-flight rotation or the receipt for any request with the old cookie hash. `:387-415` stores the full successor and the old hash; `controllers/auth.ts:269` calls `rotate(secretId)` with no proof. The old cookie does not resolve, so the browser CSRF middleware does not run.

### Proposed Changes

1. Add a binary hash helper without changing `hashSecret` (which returns a hex string used as a cache key):

   ```ts
   function hashToken(value: string): Buffer {
     return createHash("sha256").update(value, "utf8").digest();
   }
   ```

2. Store `oldCsrfHash: Buffer` in the receipt and in the in-flight entry. Capture it from the old `record.csrfToken` before `#store` deletes the old cache key.

3. Change the API:

   ```ts
   public rotate(secretId: string, proof?: string): Promise<IssuedSession | undefined>;
   ```

4. On the initial rotation, `#rotate` is authenticated by the resolved old cookie and the normal CSRF guard. It stores the old CSRF hash for a possible late retry.

5. On receipt recovery:
   - Require `proof` to be a non-empty string.
   - Compare `hashToken(proof)` with `oldCsrfHash` using `timingSafeEqual`.
   - On mismatch or absence, return `undefined`. Do not consume the receipt; the legitimate retry may still arrive.
   - On success, delete the receipt synchronously before returning, so the successor is served once.

6. On the in-flight shortcut:
   - Store `oldCsrfHash` with the promise.
   - Verify the proof before returning the shared promise. A caller with the old cookie but no proof receives `undefined`, even while a legitimate rotation is in flight.
   - A concurrent legitimate retry with the same proof may share the promise.

7. The controller reads `x-csrf-token` and passes it:

   ```ts
   const proof = req.headers["x-csrf-token"];
   const rotated = await sessions.rotate(
     secretId,
     typeof proof === "string" ? proof : undefined,
   );
   ```

8. The web client already sends `x-csrf-token` on refresh (`session-api-provider.tsx:63-67`), so normal retries work. The scheduler’s `/me` fallback is a pre-existing availability gap and is not changed here.

9. Revocation, password change, expiry, and supersession continue to invalidate the receipt through the existing `#liveReceipt` checks.

## Failure Behavior

| Condition | Result |
|---|---|
| Old cookie, no proof | `undefined` → 401, no `Set-Cookie` |
| Old cookie, wrong proof | `undefined` → 401, no `Set-Cookie`; receipt retained |
| Old cookie, correct pre-rotation proof | 200, same successor once |
| Second recovery with the same proof | 401; receipt consumed |
| In-flight rotation, old cookie, no proof | `undefined` → 401 |
| In-flight rotation, old cookie, correct proof | 200, shared successor |
| Revoked, password-changed, expired, superseded | 401 |
| Normal authenticated refresh | 200; receipt stored for a possible retry |
| Lost recovery response | Receipt is consumed; the operator must reauthenticate. Documented residual |

## Tests

`apps/server/tests/integration/auth.sessions.test.ts`:

- Update the existing late-refresh test to send the old CSRF token and assert 200 with the same successor.
- Add: old cookie without the header → 401, no `Set-Cookie`.
- Add: old cookie with a wrong header → 401, no `Set-Cookie`.
- Add: wrong proof then correct proof → the correct one still recovers.
- Add: repeat the correct recovery → 401.
- Add: revoke, change password, and expire the session; each invalidates the receipt.

`apps/server/tests/auth/sessions.impl.test.ts`:

- Update the sequential and concurrent rotation tests to pass `created.record.csrfToken`.
- Add: in-flight rotation with no proof → `undefined`; with the proof → successor.
- Add: concurrent correct-proof recovery returns one successor and one 401.

`apps/server/tests/auth/sessions.spec.test.ts`:

- Update the two-caller concurrency test to pass the old CSRF token to both callers.
- Add a no-proof concurrent caller and assert it does not receive the successor.

## Acceptance

See `07-testing-strategy.md` ST-38…ST-44 and `01-requirements.md` R7.

# Signing Keys and JWT: RD-04 CLI Authentication

> **Document**: 03-02-signing-keys-jwt.md
> **Parent**: [Index](00-index.md)
> **References**: [AR-3](00-ambiguity-register.md#ar-3--signing-key-storage), [AR-17](00-ambiguity-register.md#ar-17--key-overlap-and-retirement), [AR-22](00-ambiguity-register.md#ar-22--jwt-implementation-and-testing), [AR-28](00-ambiguity-register.md#ar-28--signing-key-failure)

## Overview

This component owns Ed25519 key material and the access-token format. The private seed is
generated once, wrapped by the current KEK, and stored in `signing_keys`. The public key stays in
clear. The current key signs; the current and a non-due previous key verify. A retired key or a
previous key outside the overlap window is rejected. No controller or route receives raw KEK
bytes.

## Architecture

### Current architecture

`packages/core/src/keyring.ts` holds 32-byte AES KEKs and exposes them only inside synchronous
callbacks. `apps/server/src/security/keyring.ts` wraps that class for the server and exposes
status only. `packages/core/src/crypto.ts` has an envelope format bound to project/object/version
AAD; that AAD is deliberately **not** reused for signing keys.

### Proposed changes

1. Add scoped `KeyringProvider.withCurrentKey` and `withKey` callbacks and a `currentId` getter.
2. Add `apps/server/src/security/signing-keys.ts` with seed generation, AES-256-GCM wrap/unwrap,
   key rows, ensure, rotate, retire-due, sign, and verify.
3. Add `apps/server/src/auth/cli-jwt.ts` with pure sign/verify functions.
4. Run key ensure and maintenance from the production bootstrap.

## Implementation Details

### Keyring callback

```ts
// apps/server/src/security/keyring.ts
public get currentId(): string | undefined;

public withCurrentKey<T>(action: (key: Readonly<Buffer>) => T): T;
public withKey<T>(id: string, action: (key: Readonly<Buffer>) => T): T;
```

Both methods throw `KeyringError` when the provider is not loaded, and `withKey` throws when
the named key is missing. The callback contract is the same as the core class: do not retain or
mutate the buffer. Controllers never import these methods.

### Seed wrapping

```text
seed          = 32 random bytes from the Ed25519 private JWK
nonce         = randomBytes(12)
aad           = "ov:jwt:v1:" + kid
wrapped_seed  = AES-256-GCM(KEK, nonce, seed, aad)
wrap_tag      = authentication tag (16 bytes)
kek_id        = keyring.currentId at wrap time
```

Unwrap uses `keyring.withKey(row.kek_id, ...)`, sets the same AAD, verifies the tag, and
returns bytes only inside the callback. Any authentication failure throws
`SigningKeyUnavailableError`; the error message never includes the seed, KEK, ciphertext, or
tag. Buffers are zeroed in `finally` blocks where possible.

### Key generation

```ts
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const seed = Buffer.from(jwk.d, "base64url");   // exactly 32 bytes
const rawPublic = Buffer.from(jwk.x, "base64url"); // exactly 32 bytes
```

Validate both lengths before inserting. Import the seed with `jose.importJWK` for signing, or
reconstruct a `KeyObject` if a future Node release removes JWK export. Never store the seed in a
string.

### Repository and service

`SigningKeyRepository` owns the SQL and uses `PostgreSQLDatabase.withTransaction`:

- `findCurrent(): Promise<SigningKeyRow | undefined>`
- `findPrevious(): Promise<SigningKeyRow | undefined>`
- `ensureCurrent(now): Promise<SigningKeyRow>` — advisory lock, select current, generate and
  insert only when absent
- `rotate(now): Promise<{ current: SigningKeyRow; previous: SigningKeyRow }>` — advisory lock,
  guard, retire old previous, demote current, insert new current
- `retireDue(now): Promise<number>` — mark a due previous `retired`

`SigningKeyService` owns key material and presents these methods:

```ts
ensure(): Promise<void>;
rotate(): Promise<{ kid: string }>;
retireDue(): Promise<number>;
signAccessToken(input: {
  principalId: string;
  familyId: string;
  nowMs: number;
}): Promise<{ token: string; expiresAt: number }>;
verifyAccessToken(token: string): Promise<CliAccessClaims>;
```

The service caches current and previous metadata and imported `CryptoKey` objects. It reloads
after ensure, rotate, and retire-due. A first sign/verify lazily calls `ensure()` when no
current key is loaded, so a missed production bootstrap cannot issue an unsigned token.

### Ensure and rotation rules

- `ensure()` runs `pg_advisory_xact_lock(hashtext('openvault:signing_keys'))` inside a
  transaction. If a current row exists, return it. Otherwise generate a key, wrap the seed, and
  insert one `current` row.
- Startup and `ov init` are idempotent; both may call `ensure()` without creating two current
  keys. The partial unique index is the backstop.
- `rotate()` is allowed when no previous row exists, or when
  `now >= current.activated_at + 15 minutes + CLOCK_SKEW_SECONDS`. Otherwise it throws
  `SigningKeyRotationError` with a stable message.
- On rotation: old previous becomes `retired` with `retired_at = now`, old current becomes
  `previous`, and the new key becomes `current` with `activated_at = now`.
- `retireDue()` retires a previous row when the same overlap predicate is true. It is called by
  the production bootstrap and by `rotate()`.
- Verification accepts a previous key only while the predicate is false. A due previous key is
  rejected even if its row still says `previous`.
- No HTTP route exposes rotate in this plan. RD-13 owns KEK re-wrap and any operator command.

### JWT format

```json
{
  "iss": "openvault",
  "aud": "openvault-cli",
  "sub": "01J...",
  "sid": "01J...",
  "jti": "01J...",
  "iat": 1760000000,
  "exp": 1760000900,
  "kind": "user"
}
```

Header: `alg: "EdDSA"`, `kid: "<ULID>"`. Lifetime: 900 seconds. Signing uses the current key.
The `sub`/`sid`/`jti` values are ULIDs. The token carries no roles, permissions, name, or email.

### Pure verification function

```ts
export interface CliAccessClaims {
  readonly iss: "openvault";
  readonly aud: "openvault-cli";
  readonly sub: string;
  readonly sid: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly kind: "user";
}

export type CliKeyResolver = (kid: string) => Promise<CryptoKey | undefined>;

export async function verifyCliAccessToken(
  token: string,
  resolveKey: CliKeyResolver,
  nowMs: number,
): Promise<CliAccessClaims>;
```

Rules:

- Reject a missing or malformed `kid` before resolving a key.
- Pin `algorithms: ["EdDSA"]`, exact `issuer`, exact `audience`, and
  `clockTolerance: CLOCK_SKEW_SECONDS`.
- Validate the payload with a strict schema: ULID `sub`, `sid`, `jti`; integer `iat` and `exp`;
  `exp > iat`; `iat <= now + skew`; `kind === "user"`.
- Reject any extra claim, wrong `kind`, wrong issuer, wrong audience, unknown `kid`, retired
  key, or due previous key.
- Throw a stable `CliTokenError`; the middleware maps it to `401 authentication_required`.

### Error handling

| Error case | Handling strategy | AR |
|---|---|---|
| No current key at first use | `ensure()` generates one under the advisory lock | AR-3, AR-16 |
| Two processes call ensure | Advisory lock plus partial unique index; only one inserts | AR-3, AR-23 |
| Seed unwrap fails | `SigningKeyUnavailableError`; no token issued | AR-28 |
| Rotation would retire a live previous | `SigningKeyRotationError`; no state change | AR-17 |
| Previous key outside overlap | Verification rejects; maintenance retires the row | AR-17 |
| Missing/wrong JWT header or claim | `CliTokenError`; caller returns 401 | AR-22 |
| Key operation fails | Generic 500; log a stable code and safe identifiers only | AR-28 |

> **Traceability:** Every key and JWT design choice above cites AR-3, AR-17, AR-22, or AR-28.
> The RD owns the token and rotation acceptance criteria.

## Testing Requirements

- Unit tests for wrap/unwrap round trip, wrong AAD, tampered tag, wrong KEK, and seed
  zeroization intent.
- Repository/service tests for ensure idempotence, concurrent ensure, rotation guard, previous
  verification inside/outside the overlap, retired rejection, and no raw seed column.
- Pure JWT tests for valid claims, wrong alg, issuer, audience, `kid`, `kind`, missing claims,
  future `iat`, expired `exp`, and malformed signature.
- Integration test that the JWT header `kid` matches the current row and that the database stores
  a 32-byte wrapped seed, not the raw seed.

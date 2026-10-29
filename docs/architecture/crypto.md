# Cryptography

## Key hierarchy

```text
KEK (32 bytes, keyring file, outside the database)
 ├── wraps per-version DEK (32 bytes, random per version)
 │      └── AES-256-GCM encrypts the value
 ├── wraps audit HMAC key (32 bytes)
 ├── wraps internal CA private key (EC P-256)
 └── wraps JWT signing key (Ed25519)
```

The KEK is never written to PostgreSQL. The keyring file is mode `0600` and can be
age-encrypted with a passphrase.

## Envelope encryption

```text
DEK          = randomBytes(32)
nonce        = randomBytes(12)
aad          = "ov:v1:" + projectId + ":" + objectId + ":" + version
ciphertext   = AES-256-GCM(DEK, nonce, plaintext, aad)

wrapNonce    = randomBytes(12)
wrapAad      = "ov:dek:v1:" + kekId + ":" + objectId + ":" + version
wrappedDek   = AES-256-GCM(KEK, wrapNonce, DEK, wrapAad)
```

Both authentication tags are verified on read. The AAD binds ciphertext to its object and
version, so moving a value to another secret fails authentication.

The core implementation lives in [`packages/core/src/crypto.ts`](https://github.com/blendsdk/openvault/blob/main/packages/core/src/crypto.ts)
and is covered by round-trip, tamper, wrong-AAD, and cross-object tests.

## Audit chain

```text
canonical = stableStringify(event without hash and hmac)
hash      = SHA-256(prevHash || canonical)
hmac      = HMAC-SHA256(auditKey, hash)
```

Audit inserts take a transaction-scoped advisory lock, read the previous hash, compute, and
insert. The chain is global and ordered by the event sequence.

The audit key is wrapped by the KEK and stored in PostgreSQL. KEK rotation re-wraps it; the
HMAC key itself does not change, so old events remain verifiable.

## KEK rotation

1. Generate a new key and make it current.
2. Re-wrap every data key, the audit key, the CA key, and the JWT key.
3. Update `kek_id` in the same transaction as each re-wrap.
4. Remove the old key after the job and verification reads succeed.

Values are never re-encrypted.

## Memory handling

- Use `Buffer` from input to ciphertext and back.
- Zero buffers in `finally` blocks.
- Avoid converting plaintext to a JavaScript string until the final response boundary.
- Do not expose the inspector or heap dumps.

Node cannot guarantee zeroization. This is recorded as a known limitation.

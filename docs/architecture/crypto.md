# Cryptography

## Key hierarchy

```text
KEK (32 bytes, keyring file, outside the database)
 ├── wraps per-version DEK (32 bytes, random per version)
 │      └── AES-256-GCM encrypts the value
 ├── wraps audit HMAC key (32 bytes)
 ├── wraps CA signing key (EC P-256, `ca_keys`)
 └── wraps JWT signing key (Ed25519)
```

The KEK is never written to PostgreSQL. The keyring file is mode `0600`. Age encryption
and the passphrase-file flow are deferred to a later release; the server rejects a passphrase
file instead of falling back to plaintext.

The JWT signing key is stored in `signing_keys`. The current key signs; the previous key
remains valid for verification until the maximum access-token lifetime plus 30 seconds of
clock skew have passed. At that boundary it is no longer accepted even if its row is still
marked previous; startup and the next rotation retire the row. At most one current and one
previous key exist. Each process refreshes its current/previous snapshot when it is older than
30 seconds, so a rotation in another process is observed within that bound.

The workload CA key is stored in `ca_keys` as a 32-byte P-256 scalar wrapped by the current
KEK. `OPENVAULT_INTERNAL_CA` is the matching public certificate. The CA profile is EC P-256,
self-signed, 10 years, `CA:TRUE`, `pathlen:0`, and `keyCertSign`. The deployment provisioner
creates it once; re-running the provisioner does not rotate it. A `CaSigner` is the only
component that unwraps the key for signing. Startup fails closed if the key is missing, expired,
or does not match the public certificate. `/ready` uses the loaded signer without re-reading the
row. The encrypted backup includes the wrapped `ca_keys` row and the public certificate, never
the raw key. v1.0 has no online CA rotation; a suspected CA compromise requires a fresh
deployment and new workload identities.

## Envelope encryption

```text
DEK          = randomBytes(32)
nonce        = randomBytes(12)
aad          = "ov:v2:" + objectType + ":" + projectId + ":" + objectId + ":" + version
ciphertext   = AES-256-GCM(DEK, nonce, plaintext, aad)

wrapNonce    = randomBytes(12)
wrapAad      = "ov:dek:v2:" + kekId + ":" + objectType + ":" + projectId + ":" + objectId + ":" + version
wrappedDek   = AES-256-GCM(KEK, wrapNonce, DEK, wrapAad)
```

`objectType` is `secret` or `certificate`. Both authentication tags are verified on read. The
AAD binds ciphertext to its object family, project, object, and version, so moving a value to
another secret or a certificate row fails authentication.

Base64 fields must be canonical. The envelope validator rejects unknown fields, wrong lengths,
non-ULID identifiers, and ciphertext above the caller's limit (65,536 bytes for secrets,
131,072 for certificates). The crypto primitive supports an authenticated empty ciphertext; the
secret API rejects empty values before encryption.

Certificate private keys are PKCS#8 DER encrypted with `objectType=certificate` and the
certificate's project, id, and version. The public leaf and intermediate chain are stored as
text in `chain_pem`; they are public material and are not encrypted. A certificate private-key
read decrypts with the same 131,072-byte limit and writes an error outcome if authentication
fails. Moving a certificate envelope into a secret row fails because the object type is part of
both the value and DEK-wrap AAD.

The v2 domain is a one-way change for this pre-release repository. Before first boot, both
`secret_versions` and `certificate_versions` must be empty. A database with v1 rows needs a
migration or restore plan.

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
2. Re-wrap every data key, the audit key, the `ca_keys` CA key, and the JWT key.
3. Update `kek_id` in the same transaction as each re-wrap.
4. Remove the old key after the job and verification reads succeed.

Values are never re-encrypted.

## Memory handling

- Use `Buffer` from input to ciphertext and back.
- Zero buffers in `finally` blocks.
- Avoid converting plaintext to a JavaScript string until the final response boundary.
- Do not expose the inspector or heap dumps.

Node cannot guarantee zeroization. This is recorded as a known limitation.

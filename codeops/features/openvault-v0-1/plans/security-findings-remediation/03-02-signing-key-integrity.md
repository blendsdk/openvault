# Signing Key Integrity: Security Findings Remediation

> **Document**: 03-02-signing-key-integrity.md
> **Parent**: [Index](00-index.md)

## Overview

Authenticate the `previous` JWT signing key before importing it and enforce a strict signing-key lifecycle transition matrix. This removes the runtime-role path that installs or resurrects an arbitrary Ed25519 verification key.

## Previous-Key Authentication

`#reloadNow` currently imports the current row with `#importCurrentKeys` and the previous row with `#importPublicKey`. Replace the previous path with `#importPreviousKey`:

1. `unwrapSigningSeed(this.#keyring, row)` authenticates the AES-GCM ciphertext and AAD.
2. Derive the Ed25519 public key from the seed.
3. Compare the derived raw 32-byte key with `row.publicKey` using `timingSafeEqual`.
4. Zero the seed in `finally`.
5. Return `undefined` on any failure; leave `#previous` undefined. Current-key signing and verification continue; previous-key tokens fail closed with 401.
6. Invoke an optional `onPreviousKeyRejected(kid)` callback so the auth plugin can log a structured warning. Add the option to `SigningKeyServiceOptions`; tests can inject a spy.

Derivation:

```ts
const privateKey = createPrivateKey({
  key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url") },
  format: "jwk",
});
const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const raw = spki.subarray(spki.length - 32);
```

Assert `raw.length === 32` before comparing.

## Lifecycle Transition Matrix

Add a manual migration with two checks:

**Immutable fields:** `kid`, `public_key`, `wrapped_seed`, `wrap_nonce`, `wrap_tag`, `kek_id`, `created_at`, `activated_at` never change.

**Allowed status transitions only:**

| Old | New | Retired timestamp |
|---|---|---|
| `current` | `previous` | must be `NULL` |
| `previous` | `retired` | must be non-`NULL` |
| same status | same status | must not change |

Reject `current→retired`, `retired→current`, `previous→current`, `retired→previous`, and any status rollback. The existing unique partial indexes still enforce one current and one previous row.

```sql
CREATE FUNCTION signing_keys_guard_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kid <> OLD.kid
     OR NEW.public_key <> OLD.public_key
     OR NEW.wrapped_seed <> OLD.wrapped_seed
     OR NEW.wrap_nonce <> OLD.wrap_nonce
     OR NEW.wrap_tag <> OLD.wrap_tag
     OR NEW.kek_id <> OLD.kek_id
     OR NEW.created_at <> OLD.created_at
     OR NEW.activated_at <> OLD.activated_at THEN
    RAISE EXCEPTION 'signing key material and lifecycle timestamps are immutable';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'current' AND NEW.status = 'previous' AND NEW.retired_at IS NULL)
      OR (OLD.status = 'previous' AND NEW.status = 'retired' AND NEW.retired_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'invalid signing key status transition';
    END IF;
  ELSIF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'retired_at cannot change without a status transition';
  END IF;
  RETURN NEW;
END;
$$;
```

`rotate()` changes `status` and `retired_at` together, so it passes. `ops/kek.ts` and `ops/restore.ts` disable USER triggers while running as the table owner; confirm that path still works in the integration test.

## KEK Rotation Guard

`apps/server/src/ops/kek.ts` currently refuses to rotate when an `openvault_app` session is connected. Extend the guard to reject any non-migrator runtime session, at minimum `openvault_app` and `openvault_auth`. Update `docs/guide/rotation.md` and the CLI reference.

## Failure Behavior

- Bad previous key: not imported; current key works; previous tokens 401; callback logs a warning.
- Bad current key: unchanged — `SigningKeyUnavailableError` fails closed.
- App role attempts to change key material or timestamps: trigger raises, transaction rolls back.
- App role attempts an illegal status transition: trigger raises.
- App role inserts a `previous` row with a mismatched seed: row can be inserted, but the service refuses to import it.

## Acceptance

See `07-testing-strategy.md` ST-7…ST-10 and `01-requirements.md` R2.

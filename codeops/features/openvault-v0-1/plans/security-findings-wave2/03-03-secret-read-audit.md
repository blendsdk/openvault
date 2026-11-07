# Secret Read Audit: Security Findings Wave 2

> **Document**: 03-03-secret-read-audit.md
> **Parent**: [Index](00-index.md)

## Overview

Record a secret-read `allow` only after the selected envelope authenticates, decrypts, and encodes. Every integrity or keyring failure writes an authenticated `error` event for the selected version. This matches `CertificateService.readPrivate`.

## Architecture

### Current Behavior

`secrets/service.ts:587-589` writes the allow decision with the version id. `:590-608` then decrypts; the catch maps `KeyringError` to 503 and other errors to an integrity error, but writes no audit event.

### Proposed Changes

1. Move the version selection and expiry checks before the allow write (already the case).
2. Decrypt the envelope.
3. On decryption failure:
   - Write one `error` decision via `#recordError` with `secret_integrity_failed`.
   - Return 503 for `KeyringError`, 500 for an integrity failure (existing mapping).
4. Encode the response value.
5. Look up capabilities.
6. Build the complete response object, including `this.#version(version)`.
7. Write one `allow` decision with `details.version`.
8. Return the prebuilt response.

The allow write must be the last side effect before the return. If capability lookup fails with `PolicyUnavailableError`, preserve the 503 and record `policy_unavailable`, not `secret_integrity_failed`. If encoding or response construction fails, record `secret_integrity_failed`. Do not write allow in either case.

## Error Event Shape

`#recordError(actorId, decision, "secret.read", projectId, secretId, reason, context, versionId)` already exists. Use `secret_integrity_failed` for envelope, keyring, decode, or capability failures. The selected version id is included when known.

## Failure Behavior

| Condition | Result |
|---|---|
| Malformed newest version | 500/503; one `error`; no `allow` |
| Bad keyring / KEK | 503; one `error`; no `allow` |
| Response construction failure | 500; one `error`; no `allow` |
| Policy/capability outage | 503; one `policy_unavailable` error; no `allow` |
| Valid read | 200; exactly one `allow` with version |
| Version not found or expired | Existing error event and 404/410 |

## Tests

- Insert a schema-valid malformed newest version and read the secret: exactly one `secret.read` `error`, zero `allow`.
- Valid read: exactly one `allow`, and it is written after decryption (assert via a decrypt failure spy or by checking the no-allow case).
- Keyring failure: one `error` and 503.
- Policy outage during capability lookup: one `policy_unavailable` error, 503, zero `allow`.
- Parity with the certificate private-read integrity failure, defined as “allow only after decrypt/key export,” not “identical ordering relative to capability lookup.”

## Acceptance

See `07-testing-strategy.md` ST-13…ST-16 and `01-requirements.md` R3.

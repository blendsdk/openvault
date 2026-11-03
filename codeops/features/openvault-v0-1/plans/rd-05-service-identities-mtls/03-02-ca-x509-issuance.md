# CA and X.509 Issuance: RD-05

> **Document**: 03-02-ca-x509-issuance.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the internal CA key lifecycle, the `CaSigner`, CSR validation, the fixed agent
certificate profile, and the readiness probe. It is the only place that unwraps or uses the CA
private key. Controllers and repositories never receive key material.

The CA public certificate is `OPENVAULT_INTERNAL_CA`; the private key is a KEK-wrapped P-256 scalar
in `ca_keys`. `ov init`/RD-13 provisions the row and certificate in production. This plan loads an
existing row, fails closed if it is missing or mismatched, and uses an EC test fixture for
acceptance. [AR-3, AR-12, AR-17, AR-24]

## Architecture

### Current Architecture

`TlsMaterial` parses `OPENVAULT_INTERNAL_CA` and verifies it is a current, self-signed CA. The
keyring exposes scoped KEK access. `signing_keys` demonstrates 32-byte seed wrapping, AAD binding,
and current-key selection. There is no CA-key table, signer, CSR parser, or certificate generator.

### Proposed Changes

1. Add `apps/server/src/security/x509.ts` as the single `@peculiar/x509` boundary. It imports
   `reflect-metadata` before the library, parses/verifies CSRs, issues fixed-profile certificates,
   and performs the CA probe.
2. Add `apps/server/src/security/ca.ts` for `CaKeyRow`, scalar wrapping, `CaSigner.load()`,
   public-key/certificate matching, and delegation to the X.509 boundary.
3. Add a `ca` readiness probe and wire the signer into production startup and readiness.
4. Add an EC test CA fixture and seed helper for integration tests.
5. Add `ca_keys` schema/migration work from [03-01](03-01-contracts-schema-authorization.md#schema-and-migration).

## Implementation Details

### X.509 dependency boundary

`apps/server/src/security/x509.ts` is the only module that imports `@peculiar/x509`. It starts with
the required polyfill import:

```ts
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
```

The package and its ASN.1 peer are exact-pinned in `apps/server/package.json`; no other server
module imports the library. This keeps the dependency review, import-order requirement, and API
surface in one reviewed file. [AR-12]

### CSR parsing and validation

```ts
export interface AgentCsr {
  readonly publicKey: x509.PublicKey;
  readonly publicKeySha256: string;
}

export class CsrValidationError extends Error {
  public readonly reason:
    | "malformed"
    | "bad_signature"
    | "not_p256"
    | "extensions_not_allowed";
  // ...
}

export async function parseAgentCsr(csrPem: string): Promise<AgentCsr>;
```

Validation order:

1. Reject empty or oversized input; the HTTP body limit is the outer bound and the ASN.1 parser
   adds resource limits.
2. Parse `new x509.Pkcs10CertificateRequest(csrPem)`; malformed input becomes `CsrValidationError`.
3. `await request.verify()`; a false result is proof-of-possession failure.
4. Export the public key to SPKI and use Node `createPublicKey` to check
   `asymmetricKeyType === "ec"` and `asymmetricKeyDetails.namedCurve === "prime256v1"`.
5. Reject any CSR extension. The agent's generated CSR has none; accepting attacker-controlled
   SAN/basicConstraints/keyUsage/EKU/unknown critical extensions is unnecessary. An arbitrary or
   empty subject is accepted and ignored.
6. Return the public key and SHA-256 of the DER public key for replay-keying.

The CSR subject is never copied. The agent does not need to know its principal id before join.
[AR-4]

### Certificate profile

`issueAgentCertificate()` takes the verified CSR public key, principal id, CA certificate, CA
signing `CryptoKey`, TTL days, and clock.

| Field | Value |
|---|---|
| Subject | `CN=<principal id>` |
| Issuer | internal CA subject |
| Public key | CSR public key (EC P-256) |
| Signature | ECDSA with SHA-256 |
| `notBefore` | `now - 30 seconds` |
| `notAfter` | `notBefore + ttlDays` (configured total lifetime) |
| Serial | 128 random bits, lowercase hex |
| Basic constraints | critical, `CA:FALSE` |
| Key usage | critical, `digitalSignature` |
| Extended key usage | `clientAuth` |
| SAN | exactly one URL: `openvault://identity/<principal id>` |
| Fingerprint | SHA-256 over DER, lowercase hex |

The generator call is conceptually:

```ts
const cert = await x509.X509CertificateGenerator.create({
  serialNumber,
  subject: `CN=${principalId}`,
  issuer: caCertificate.subject,
  notBefore,
  notAfter,
  signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  publicKey: csr.publicKey,
  signingKey: caSigningKey,
  extensions: [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
    new x509.SubjectAlternativeNameExtension(
      [{ type: x509.URL, value: `openvault://identity/${principalId}` }],
      false,
    ),
  ],
});
```

Return `{ certificatePem, serial, fingerprint, notBefore, notAfter }`. The chain PEM is the CA
certificate PEM. The agent private key never enters this module. Serial collisions are retried at
most three times against the unique `workload_certs.serial` index; a repeated collision is a 503,
never a certificate with a different subject. [AR-4, AR-17, AR-24]

### CA row and wrapping

`ca_keys` is defined in [03-01](03-01-contracts-schema-authorization.md#schema-and-migration). The
private key is a 32-byte P-256 scalar. The public key is the 65-byte uncompressed point
`0x04 || x || y`.

```ts
export interface CaKeyRow {
  readonly id: string;
  readonly certPem: string;
  readonly publicKey: Buffer;   // 65 bytes
  readonly wrappedKey: Buffer;  // 32 bytes
  readonly wrapNonce: Buffer;   // 12 bytes
  readonly wrapTag: Buffer;     // 16 bytes
  readonly kekId: string;
  readonly status: "current" | "retired";
  readonly createdAt: Date;
  readonly activatedAt: Date;
  readonly retiredAt: Date | null;
}

export interface WrappedCaKey {
  readonly wrappedKey: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
  readonly kekId: string;
}

export function wrapCaScalar(
  keyring: KeyringProvider,
  id: string,
  scalar: Buffer,
): WrappedCaKey;
```

Use AES-256-GCM with a 12-byte nonce, a 16-byte tag, and AAD
`ov:ca:v1:<ca_keys.id>`. The AAD prevents moving wrapped material between rows. The scalar is
validated as 32 bytes before wrapping and is zeroed after use by the caller. [AR-3, AR-17]

### `CaSigner.load()`

```ts
export interface CaSignerOptions {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly caPem: string;
  readonly now?: () => number;
  /** Test-only deterministic serial source; production uses random 128-bit hex. */
  readonly serialSource?: () => string;
}

export class CaSigner {
  static async load(options: CaSignerOptions): Promise<CaSigner>;
  issueClientCertificate(
    csr: AgentCsr,
    principalId: string,
    ttlDays: number,
    serialSource?: () => string,
  ): Promise<IssuedCertificate>;
  // The returned serial is parsed from the generated certificate, not the requested source.
  probe(): Promise<void>;
  destroy(): void;
}
```

Load steps:

1. Find the row where `status='current'`; a missing row is `CaSignerUnavailableError`. The unique
   current index makes two current rows impossible; the schema test asserts that invariant.
2. Check the row’s byte lengths and `kek_id`.
3. Unwrap the scalar with the recorded KEK and AAD; any authentication failure is
   `CaSignerUnavailableError` and never includes ciphertext.
4. Build the JWK from the raw public point and scalar; import it as an ECDSA P-256 `CryptoKey`
   with `extractable:false` and `["sign"]` usage.
5. Parse `OPENVAULT_INTERNAL_CA` with `@peculiar/x509`; read
   `getExtension(BasicConstraintsExtension)` and `getExtension(KeyUsagesExtension)` rather than
   relying on removed `X509Certificate.ca`/`pathLength`/`keyUsages` fields. Check `CA:TRUE`,
   `pathlen:0`, `keyCertSign`, a valid self-signature, and that its public key matches both
   `ca_keys.public_key` and the private key’s derived public key. Compare the row’s `cert_pem`
   DER with `OPENVAULT_INTERNAL_CA`; a mismatch fails startup.
6. Zero the mutable scalar and temporary DER buffers and drop the JWK `d` reference. The JWK `d`
   is a JavaScript string and cannot be zeroed; record that limitation instead of claiming
   zeroization. Retain only the non-extractable `CryptoKey`, CA certificate, and sanitized row
   metadata.

`issueClientCertificate()` never returns or exposes the CA key. `destroy()` drops references; the
process must be restarted to reload a different row. The CA key is not copied into the keyring
file or a log. [AR-3, AR-17]

### Readiness probe

`CaSigner.probe()`:

1. Generates an ephemeral P-256 key pair.
2. Issues a short test certificate with the same fixed profile and a synthetic principal id.
3. Parses the certificate, verifies it against the CA public key, and checks the profile.
4. Discards the certificate and key pair.

The probe tests the loaded signer's signing path. It does not re-read `ca_keys` and cannot observe
later row corruption; load failures are tested by corrupting the row before `CaSigner.load()`.
The production `/ready` probe is added in Phase 4 only when an agent runtime/CA signer is present;
the admin-only test path omits it. `/ready` returns 503 with `not_ready` when the CA probe is
present and the probe fails. Startup loads the signer after migrations and before binding the
listeners; a missing/mismatched row aborts startup. [AR-3]

### Startup wiring

Production order:

```text
load config and keyring
load TLS/CA material (public CA file)
run migrations
open database
create identity/agent runtime, including CaSigner.load()
create application/controllers/readiness
prepare application
bootstrap auth and agent maintenance
bind listeners
```

The runtime is created once and registered as a singleton. The CA signer is available to the agent
join/renew service and to readiness. Tests can inject a test runtime before transport binding; the
production path never falls back to a missing signer.

### Error handling

| Error case | Handling | AR |
|---|---|---|
| `ca_keys` missing, duplicate current, or wrong status | Startup fails; `/ready` 503; no listener binds | AR-3 |
| KEK cannot unwrap scalar | `CaSignerUnavailableError`; no key bytes in message | AR-3 |
| CA public key/certificate mismatch | Startup/readiness failure; no signing | AR-3, AR-17 |
| Malformed CSR | 422 `validation_error`; no token consumed | AR-4 |
| CSR signature fails | 422 `validation_error`; no token consumed | AR-4 |
| Non-P-256 or RSA key | 422 `validation_error`; no token consumed | AR-4 |
| CSR contains any extension | 422 `validation_error`; no token consumed | AR-4 |
| Certificate generation or unique-serial exhaustion | 503 `ca_unavailable`; transaction rolls back | AR-3, AR-4 |
| Probe failure | `/ready` 503 with probe name `ca`; no secret detail | AR-3 |

### Test fixture

`apps/server/tests/integration/helpers/agent-tls.ts` imports `reflect-metadata` before
`@peculiar/x509` and generates a disposable EC P-256 CA. The single-import boundary applies to
production modules; the fixture is an explicit test-only exception. It provides:

- self-signed CA, 10-year validity, `CA:TRUE`, `pathlen:0`, `keyCertSign`;
- a server certificate/key for the test listener, signed by the CA;
- a client certificate/key for transport tests, signed by the CA;
- an expired, self-signed, and wrong-CA client certificate for the negative cases;
- the CA public point and scalar (or JWK `d`) for seeding `ca_keys`.

`seedCaKey(database, keyring, fixture)` wraps the scalar and inserts the current row. The fixture
directory is removed in `finally`. The existing RSA TLS fixture remains for unrelated transport
tests; RD-05 tests that require the internal CA use the EC fixture. The product path never invokes
OpenSSL. [AR-12, AR-22]

## Testing Requirements

- Wrap/unwrap round trip; wrong AAD, wrong KEK, flipped nonce/tag, and truncated scalar fail
  without plaintext.
- `CaSigner.load()` accepts a matching row; rejects missing current, wrong public point,
  mismatched certificate, and unwrap failure. The schema rejects a second current row.
- Issued certificate has the exact subject, SAN, CA:FALSE, key usage, EKU, normalized serial,
  fingerprint, and configured lifetime; it verifies against the CA.
- CSR rejects malformed input, bad signature, RSA/P-384, any extension, and oversized input.
- Probe passes with a valid loaded signer; readiness 503 is tested with a fake failing `ca` probe;
  load failures are tested with a corrupted row before load.
- Captured logs and errors contain no scalar, wrapped key bytes, or CA private key; the JWK-string
  zeroization limitation is documented.

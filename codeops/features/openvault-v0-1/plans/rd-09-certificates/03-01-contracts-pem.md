# Contracts and PEM: RD-09 Certificates

> **Document**: 03-01-contracts-pem.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the public certificate contracts and the strict PEM/key/chain validation
and generation layer. It is the security boundary: every byte that reaches the X.509 parser or
the envelope crypto has already passed the rules in this document.

**Governing decisions:** AR-1, AR-3, AR-4, AR-5, AR-6, AR-7, AR-8, AR-9, AR-10, AR-25,
AR-28, AR-31, AR-34.

## Architecture

### Current Architecture

`packages/api-contract/src/ids.ts` exports `secretNameSchema`, whose pattern is identical to
the certificate name check. `packages/api-contract/src/rbac.ts` exports
`capabilityFlagsSchema`. `packages/core/src/crypto.ts` exports `encryptValue`, `decryptValue`,
`EnvelopeAad`, `EnvelopeKeyring`, and the object-type union. `@peculiar/x509` is a server
dependency and is used for the internal CA.

### Proposed Changes

Add `packages/api-contract/src/certificates.ts` and export it from the package index. Add
`apps/server/src/certificates/pem.ts` for parsing/validation and
`apps/server/src/certificates/generate.ts` for self-signed generation. No core crypto change
is needed.

## Implementation Details

### Public Contracts

```ts
// certificates.ts
export const certificateNameSchema = secretNameSchema;
export const certificateTagsSchema = secretTagsSchema;

export const CERTIFICATE_KEY_TYPES = ["rsa-2048", "rsa-3072", "ec-p256"] as const;
export const certificateKeyTypeSchema = z.enum(CERTIFICATE_KEY_TYPES);

export const certificateSanSchema = z
  .string()
  .min(4)
  .max(2_048)
  .refine((value) => !/\p{Cc}/u.test(value))
  .refine((value) => /^(DNS|IP|URI|email):/.test(value), "SAN must use a typed prefix");

export const certificateSubjectSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/\p{Cc}/u.test(value))
  .refine((value) => value.includes("="), "subject must be an RFC 4514 distinguished name");

export const certificateGenerateSanSchema = certificateSanSchema;

export const certificateWarningSchema = z.strictObject({
  code: z.enum([
    "expired",
    "not_yet_valid",
    "missing_intermediate",
    "expired_intermediate",
    "not_yet_valid_intermediate",
  ]),
  message: z.string().min(1).max(256),
});

export const certificateImportRequestSchema = z.strictObject({
  name: certificateNameSchema,
  certificatePem: z.string().min(1).max(262_144),
  chainPem: z.string().max(262_144).optional(),
  privateKeyPem: z.string().min(1).max(65_536),
  allowNotYetValid: z.boolean().default(false),
  expectedVersionId: ulidSchema.optional(),
  tags: certificateTagsSchema.optional(),
});

export const certificateGenerateRequestSchema = z.strictObject({
  name: certificateNameSchema,
  subject: certificateSubjectSchema,
  sans: z.array(certificateGenerateSanSchema).min(1).max(100),
  keyType: certificateKeyTypeSchema.default("ec-p256"),
  validityDays: z.number().int().min(1).max(825).default(365),
  expectedVersionId: ulidSchema.optional(),
  tags: certificateTagsSchema.optional(),
});

export const certificateVersionSchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  createdBy: ulidSchema,
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  serial: z.string().min(1).max(128),
});

export const certificateMetadataSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: certificateNameSchema,
  tags: certificateTagsSchema,
  status: z.enum(["active", "expired", "deleted"]),
  subject: z.string().max(1_024),
  sans: z.array(certificateSanSchema),
  issuer: z.string().max(1_024),
  serial: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  daysToExpiry: z.number().int(),
  chainLength: z.number().int().min(1),
  version: certificateVersionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  purgeAfter: z.iso.datetime().nullable(),
  purgeProtected: z.boolean(),
  capabilities: capabilityFlagsSchema,
});

export const certificateWriteResponseSchema = certificateMetadataSchema.extend({
  certificatePem: z.string().min(1),
  chainPem: z.string(),
  warnings: z.array(certificateWarningSchema),
});

export const certificatePublicResponseSchema = certificateMetadataSchema.extend({
  certificatePem: z.string().min(1),
  chainPem: z.string(),
});

export const certificatePrivateKeyResponseSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: certificateNameSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  privateKeyPem: z.string().min(1),
  version: certificateVersionSchema,
  capabilities: capabilityFlagsSchema,
});

export const certificateReadQuerySchema = z.strictObject({
  version: ulidSchema.optional(),
});

export const certificateListQuerySchema = z
  .strictObject({
    q: z.string().min(1).max(1_024).refine((value) => !/\p{Cc}/u.test(value)).optional(),
    san: certificateSanSchema.optional(),
    expiresBefore: z.iso.datetime().optional(),
    expiresAfter: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .refine(
    (value) =>
      value.expiresBefore === undefined ||
      value.expiresAfter === undefined ||
      Date.parse(value.expiresAfter) <= Date.parse(value.expiresBefore),
    { path: ["expiresAfter"], message: "expiresAfter must not be after expiresBefore" },
  );

export const certificateListSchema = z.strictObject({
  certificates: z.array(certificateMetadataSchema),
  nextCursor: z.string().nullable(),
});

export const certificateMetadataUpdateRequestSchema = z
  .strictObject({
    tags: certificateTagsSchema.optional(),
    purgeProtected: z.boolean().optional(),
  })
  .refine(
    (value) => value.tags !== undefined || value.purgeProtected !== undefined,
    "at least one field is required",
  );
```

`certificateWriteResponseSchema` is used for import, generate, and renewal. The `warnings`
array is empty on generation unless a generated certificate is already expired (it cannot be).

### PEM Parsing

`apps/server/src/certificates/pem.ts` exposes:

```ts
export interface PemBlock {
  readonly label: string;
  readonly body: string;
  readonly pem: string;
}

export function parsePemBlocks(
  input: string,
  options: { readonly maximumBytes: number; readonly labels: readonly string[] },
): readonly PemBlock[];

export interface ParsedCertificateMaterial {
  readonly leafPem: string;
  readonly certificateChainPem: string;
  readonly chainLength: number;
  readonly warnings: readonly CertificateWarning[];
  readonly subject: string;
  readonly sans: readonly string[];
  readonly issuer: string;
  readonly serial: string;
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly privateKeyPem: string;
  readonly privateKeyBytes: Buffer;
  readonly privateKeyType: "rsa-2048" | "rsa-3072" | "ec-p256";
}

export function parseCertificateMaterial(input: {
  readonly certificatePem: string;
  readonly chainPem?: string;
  readonly privateKeyPem: string;
  readonly allowNotYetValid: boolean;
  readonly now: number;
  readonly maximumBytes: number;
}): ParsedCertificateMaterial;
```

Rules:

1. Reject input above the supplied byte bound before parsing.
2. Normalize CRLF to LF. Reject NUL and any non-whitespace text outside PEM blocks.
3. Every block must match `-----BEGIN <LABEL>-----` with a matching `-----END <LABEL>-----`.
   Labels are case-sensitive uppercase identifiers.
4. The leaf field must contain exactly one `CERTIFICATE` block. The chain field may contain
   zero or more `CERTIFICATE` blocks. The key field must contain exactly one `PRIVATE KEY`
   block; `RSA PRIVATE KEY`, `EC PRIVATE KEY`, and `ENCRYPTED PRIVATE KEY` are rejected.
5. The body must be canonical base64 after whitespace is removed. Reject non-canonical
   padding. The decoded DER must parse with `@peculiar/x509`.
6. The leaf and chain fields are each bounded by the request schema; their combined normalized PEM text must fit `OPENVAULT_CERT_MAX_BYTES` (131,072 bytes). The private key is separately bounded at 16,384 bytes.
7. Decode the key body to DER and parse it with `createPrivateKey({ key: der, format: "der",
   type: "pkcs8" })`; this rejects a traditional PKCS#1 body even under a `PRIVATE KEY` label.
   Reject anything that is not RSA 2048/3072 or EC P-256, including RSA-PSS, EC P-384,
   RSA 4096, and encrypted keys.
8. Compare the leaf public key and private key as SPKI DER:
   `createPublicKey(privateKey).export({ type: "spki", format: "der" })` against
   `Buffer.from(certificate.publicKey.rawData)`. `KeyObject.equals` is not used because it
   requires two KeyObjects of the same type. A mismatch returns 422.
9. Validate chain links cryptographically with `signatureOnly: true`, so certificate dates do
   not affect chain verification (leaf dates are checked separately):
   - If `chain[0]` verifies the leaf, verify each subsequent link `chain[i]` with
     `chain[i+1]`. A used chain certificate must have `BasicConstraints CA=true` and, when
     KeyUsage is present, `keyCertSign`; otherwise reject 422.
   - If `chain[0]` does not verify the leaf and `chain[0].subject` matches the leaf's issuer
     name, the chain claims to be the issuer but the signature is false: reject 422.
   - If `chain[0]` does not verify the leaf and the issuer name does not match, the chain is
     not the leaf's issuer: drop the unusable chain blocks, add `missing_intermediate`, and
     import the valid leaf.
   - If the usable chain's top is not self-signed, add `missing_intermediate` and keep the
     verified prefix. No chain at all adds the same warning unless the leaf is self-signed.
   Do not require exact `issuer`/`subject` string equality for verified links, because
   equivalent DNs can serialize differently; use the signature and the issuer-name check only
   for the missing-intermediate decision.
10. Extract the leaf subject, issuer, serial (lowercase hex), SHA-256 DER fingerprint
    (lowercase hex), `notBefore`, `notAfter`, and canonical typed SANs. Use
    `certificateSanSchema` as the typed allowlist, then perform the precise DNS/IP/URI/email
    checks; an unsupported type or malformed value is 422. Validate the extracted
    metadata before encryption: subject and issuer at most 1,024 characters, serial 1–128,
    `notAfter > notBefore`, at most 100 SANs, and total normalized SAN text at most 8,192
    characters. A violation is 422, not a database check failure.
11. `notBefore > now` rejects 422 unless `allowNotYetValid`; then add `not_yet_valid`.
    `notAfter <= now` adds `expired`. For each used chain certificate, an expired date adds
    `expired_intermediate` and a not-yet-valid date adds `not_yet_valid_intermediate`; these
    are warnings because the chain signature is still cryptographically valid.
12. The returned `certificateChainPem` is the normalized leaf plus every non-leaf block that
    was actually used, in order. `chainPem` responses return every non-leaf block (including a
    supplied self-signed root); `chainLength = 1 + non-leaf count`. `privateKeyBytes` is the
    DER buffer and must be zeroed by the caller after encryption.

### SAN Canonicalization

Input and output use the same typed string form:

| Prefix | Validation |
|---|---|
| `DNS:` | DNS name or `*.` wildcard; 1–253 characters; lowercase labels; no trailing dot |
| `IP:` | `isIP` returns 4 or 6; canonical text via `new URL` not used |
| `URI:` | Any absolute URI scheme (including `openvault://`), no credentials, max 2,048 |
| `email:` | Local part and domain with a conservative ASCII pattern; max 320 |

Duplicates are removed case-insensitively. At least one SAN is required for generation; import
may have zero. `@peculiar/x509` SAN types are `dns`, `ip`, `url`, and `email`; `URI:` maps to
`url`. A certificate containing a SAN type outside that set (for example `otherName`) is
rejected with 422 rather than stored with a lossy representation; the supported set is
documented in the limitations. Generation accepts only the four typed forms through
`certificateGenerateSanSchema`.

### Generation

`apps/server/src/certificates/generate.ts` exposes:

```ts
export interface GeneratedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly privateKeyBytes: Buffer;
  readonly keyType: CertificateKeyType;
  readonly subject: string;
  readonly sans: readonly string[];
  readonly serial: string;
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export async function generateSelfSignedCertificate(input: {
  readonly subject: string;
  readonly sans: readonly string[];
  readonly keyType: CertificateKeyType;
  readonly validityDays: number;
  readonly now: number;
}): Promise<GeneratedCertificate>;
```

Rules:

- Import `reflect-metadata` before `@peculiar/x509` (the library's decorators require it).
- RSA: `crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048|3072,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign","verify"])`.
  The exponent must be a `Uint8Array`, not a plain number array.
- EC: `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true,
  ["sign","verify"])`.
- Validate the subject with `new x509.Name(subject)`; require at least one attribute and a
  non-empty string. A malformed subject returns 422. Do not pass an unchecked string to the
  generator, because the library can silently produce an empty Name.
- `notBefore = now - 30_000`, `notAfter = notBefore + validityDays * 86_400_000`. The
  backdating absorbs a client with a few seconds of clock lag; the effective validity is still
  the requested number of days from the backdated start.
- `serialNumber = randomBytes(16).toString("hex")` normalized to lowercase without `0x`.
- `X509CertificateGenerator.createSelfSigned({ name: subject, keys, serialNumber,
  notBefore, notAfter, extensions })`.
- Extensions: `BasicConstraintsExtension(false, undefined, true)`,
  `KeyUsagesExtension(digitalSignature | keyEncipherment for RSA, true)`,
  `ExtendedKeyUsageExtension([serverAuth, clientAuth], false)`,
  `SubjectAlternativeNameExtension(names, false)`.
- Export the private key as PKCS#8 DER with `crypto.subtle.exportKey("pkcs8", privateKey)`,
  convert it with `createPrivateKey({ key: der, format: "der", type: "pkcs8" })`, and use
  Node's `export({ format: "pem", type: "pkcs8" })` to produce the armored PEM. Do not embed
  the private-key armor literal in source: `pnpm check:artifacts` scans the built output for
  private-key markers. Return both the PEM and the DER buffer; the caller zeroes the DER
  buffer after encryption.
- Only the public certificate and metadata are returned to the client.

### Error Taxonomy

| Error case | HTTP | Code | AR Ref |
|---|---|---|---|
| Malformed PEM, label, base64, key type, key match, chain signature, SAN, subject, dates | 422 | `validation_error` | AR-6..AR-10 |
| Certificate or chain field above the configured bound | 413 | `certificate_too_large` | AR-6 |
| Certificate name used by a deleted row | 409 | `certificate_name_conflict` | AR-12 |
| Certificate or version missing in an active project | 404 | `certificate_not_found` / `certificate_version_not_found` | AR-23 |
| Expired current version read without `?version=` | 410 | `certificate_expired` | AR-23 |
| Version limit reached | 409 | `certificate_version_limit` | AR-11 |
| Stale `expectedVersionId` | 409 | `certificate_version_conflict` | AR-2 |
| Protection disable attempt | 409 | `purge_protection_locked` | AR-14 |
| Purge before retention | 409 | `certificate_retention_active` | AR-14 |
| Purge while not deleted | 409 | `certificate_not_deleted` | AR-14 |
| Recover after retention | 409 | `certificate_not_recoverable` | AR-14 |
| Private-key decrypt/GCM failure | 500 | `certificate_integrity_failed` | AR-25 |
| Policy, audit, keyring, or purge unavailable | 503 | `service_unavailable` | AR-21 |
| Rate limit | 429 | `RATE_LIMIT_EXCEEDED` | AR-22 |

## Integration Points

- `packages/api-contract/src/index.ts` re-exports every schema and type.
- `apps/server/src/certificates/pem.ts` is consumed by the service and tests.
- `apps/server/src/certificates/generate.ts` is consumed by the service and tests.
- The envelope uses `encryptValue`/`decryptValue` with `objectType: "certificate"`.
- RD-11 consumes the contracts; RD-13 backs up the rows.

## Testing Requirements

- Contract tests for defaults, bounds, unknown fields, SAN shape, tags, the expiry-window
  refinement, and the reachable 413 path (the schema ceiling is above the parser bound).
- PEM tests for every label, canonical base64, multiple blocks, surrounding text, size, key
  type, key match, a PKCS#1 body under a `PRIVATE KEY` label, RSA-PSS, EC P-384, RSA 4096,
  chain signature, expired/not-yet-valid intermediate warnings, leaf+root missing intermediate,
  not-yet-valid, expiry, unsupported SAN types, long/inverted metadata, and SAN grammar.
- Generation tests for RSA 2048/3072 and EC P-256, SAN round-trip, self-signature, validity
  bounds, and the private-key export.
- A test that a certificate envelope does not decrypt as a secret.

# Contracts and Crypto: RD-08 Projects and Secrets

> **Document**: 03-01-contracts-crypto.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the public request/response contracts and the cryptographic envelope
changes required by RD-08: object-type and project binding in the AAD, strict base64, exact
field sets, identifier validation, and ciphertext bounds. It also defines the shared error
taxonomy used by the project and secret controllers.

**Governing decisions:** AR-4, AR-5, AR-6, AR-7, AR-9, AR-10, AR-11, AR-16, AR-22, AR-25,
AR-31.

## Architecture

### Current Architecture

`packages/api-contract/src/ids.ts` already exports `projectNameSchema`, `secretNameSchema`,
and `ulidSchema`. `packages/api-contract/src/rbac.ts` exports `capabilityFlagsSchema` and
`CapabilityFlags`. There are no project or secret request, response, or query schemas.
`packages/core/src/crypto.ts` encrypts bytes with a fresh DEK; its value AAD binds project,
object, and version, and its DEK-wrap AAD omits the project. `decodeField` uses a lenient
base64 decode. The server has `KeyringProvider`, which exposes `currentId` as
`string | undefined` and the same `withKey`/`withCurrentKey` callbacks as the core `Keyring`.

### Proposed Changes

Add `projects.ts` and `secrets.ts`, export them, add a narrow `EnvelopeKeyring` interface that
both `Keyring` and `KeyringProvider` satisfy, and extend the envelope with object type and
project in both AAD domains. Add an `EnvelopeLimits` argument so secret decryption rejects
ciphertext above 65,536 bytes while RD-09 can pass 131,072.

## Implementation Details

### Project Contracts

```ts
// projects.ts
export const projectCreateRequestSchema = z.strictObject({
  name: projectNameSchema,
});

export const projectUpdateRequestSchema = z.strictObject({
  name: projectNameSchema,
});

export const projectSchema = z.strictObject({
  id: ulidSchema,
  name: projectNameSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

export const projectListSchema = z.strictObject({
  projects: z.array(projectSchema),
});
```

`displayName` is not exposed because RD-08 does not require it (AR-4). The schema column stays
unused.

### Secret Contracts

```ts
// secrets.ts
export const secretEncodings = ["utf8", "base64"] as const;
export const secretEncodingSchema = z.enum(secretEncodings);
export const secretContentTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{Cc}/u.test(value));

export const secretTagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/\p{Cc}/u.test(value));
export const secretTagValueSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value));
export const secretTagsSchema = z
  .record(secretTagKeySchema, secretTagValueSchema)
  .refine((value) => Object.keys(value).length <= 15);

export const secretVersionSchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  createdBy: ulidSchema,
  expiresAt: z.iso.datetime().nullable(),
});

export const secretVersionSummarySchema = secretVersionSchema.extend({
  status: z.enum(["active", "expired"]),
  isCurrent: z.boolean(),
});

export const secretConsumerSummarySchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  lastSeen: z.iso.datetime(),
});

export const secretMetadataSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: secretNameSchema,
  tags: secretTagsSchema,
  contentType: secretContentTypeSchema,
  status: z.enum(["active", "deleted"]),
  currentVersion: secretVersionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  purgeAfter: z.iso.datetime().nullable(),
  purgeProtected: z.boolean(),
  consumers: z.array(secretConsumerSummarySchema),
  capabilities: capabilityFlagsSchema,
});

export const secretWriteResponseSchema = secretMetadataSchema.extend({
  version: secretVersionSchema,
});

export const secretCreateRequestSchema = z.strictObject({
  name: secretNameSchema,
  value: z.string(),
  encoding: secretEncodingSchema.default("utf8"),
  contentType: secretContentTypeSchema.default("text/plain"),
  tags: secretTagsSchema.default({}),
  expiresAt: z.iso.datetime().optional(),
});

export const secretValueWriteRequestSchema = z.strictObject({
  value: z.string(),
  encoding: secretEncodingSchema.default("utf8"),
  expiresAt: z.iso.datetime().optional(),
});

export const secretMetadataUpdateRequestSchema = z
  .strictObject({
    tags: secretTagsSchema.optional(),
    contentType: secretContentTypeSchema.optional(),
    purgeProtected: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.tags !== undefined ||
      value.contentType !== undefined ||
      value.purgeProtected !== undefined,
  );

export const secretReadQuerySchema = z.strictObject({
  version: ulidSchema.optional(),
});

export const secretListQuerySchema = z
  .strictObject({
    q: z
      .string()
      .min(1)
      .max(127)
      .refine((value) => !/\p{Cc}/u.test(value))
      .optional(),
    tagKey: secretTagKeySchema.optional(),
    tagValue: secretTagValueSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .refine((value) => value.tagValue === undefined || value.tagKey !== undefined, {
    path: ["tagKey"],
    message: "tagKey is required when tagValue is supplied",
  });

export const secretListSchema = z.strictObject({
  secrets: z.array(secretMetadataSchema),
  nextCursor: z.string().nullable(),
});

export const secretValueResponseSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: secretNameSchema,
  value: z.string(),
  encoding: secretEncodingSchema,
  contentType: secretContentTypeSchema,
  tags: secretTagsSchema,
  version: secretVersionSchema,
  capabilities: capabilityFlagsSchema,
});

export const secretVersionListSchema = z.strictObject({
  versions: z.array(secretVersionSummarySchema),
});

export const secretConsumerListSchema = z.strictObject({
  consumers: z.array(secretConsumerSummarySchema),
});
```

### Crypto Change

```ts
export type EnvelopeObjectType = "secret" | "certificate";

export interface EnvelopeAad {
  readonly objectType: EnvelopeObjectType;
  readonly projectId: string;
  readonly objectId: string;
  readonly version: string;
}

export interface EnvelopeLimits {
  /** Maximum accepted ciphertext bytes. */
  readonly maxCiphertextBytes: number;
}

export interface EnvelopeKeyring {
  readonly currentId: string | undefined;
  readonly destroyed: boolean;
  withCurrentKey<T>(action: (key: Readonly<Buffer>) => T): T;
  withKey<T>(id: string, action: (key: Readonly<Buffer>) => T): T;
}

function valueAad(aad: EnvelopeAad): Buffer {
  return Buffer.from(
    `ov:v2:${aad.objectType}:${aad.projectId}:${aad.objectId}:${aad.version}`,
    "utf8",
  );
}

function wrapAad(kekId: string, aad: EnvelopeAad): Buffer {
  return Buffer.from(
    `ov:dek:v2:${kekId}:${aad.objectType}:${aad.projectId}:${aad.objectId}:${aad.version}`,
    "utf8",
  );
}
```

`encryptValue` and `decryptValue` accept `EnvelopeKeyring`. `decryptValue` takes an
`EnvelopeLimits` argument. `assertAad` validates:

- `objectType` is exactly `secret` or `certificate`;
- `projectId`, `objectId`, and `version` match `^[0-9A-HJKMNP-TV-Z]{26}$`;
- the envelope has exactly the seven documented keys;
- every base64 field is canonical (decoding and re-encoding reproduces the exact string);
- `nonce`/`wrapNonce` are 12 bytes, `tag`/`wrapTag` are 16 bytes, `wrappedDek` is 32 bytes;
- `ciphertext` is at most `maxCiphertextBytes`; zero length is allowed by the primitive because RD-08 requires an authenticated empty ciphertext, while the API rejects empty values before encryption.

`encryptValue` checks `currentId !== undefined`; otherwise it throws `KeyringError`. A `KeyringError` from an unloaded or destroyed provider maps to 503 `service_unavailable`, not an integrity 500.
`KeyringProvider` gains a `destroyed` getter. The v2 change is a one-way pre-release deploy;
the release checklist rejects a database with non-empty `secret_versions` or
`certificate_versions` before first boot (AR-7).

### Error Taxonomy

| Error case | HTTP | Code | AR Ref |
|---|---|---|---|
| Invalid body, query, name, tag, content type, expiry, cursor, or idempotency key | 422 | `validation_error` | AR-9, AR-10, AR-11 |
| Project name already active | 409 | `project_name_conflict` | AR-4 |
| Project does not exist or is deleted | 404 | `project_not_found` | AR-2 |
| Caller has no grant anywhere for the action | 403 | `access_denied` | AR-3 |
| Caller has the action but not on this project/object | 404 | `project_not_found` / `secret_not_found` | AR-3 |
| Secret name already used by an active or deleted row | 409 | `secret_name_conflict` | AR-19 |
| Secret or version does not exist in an active project | 404 | `secret_not_found` / `secret_version_not_found` | AR-8 |
| Value above 65,536 decoded bytes | 413 | `secret_too_large` | AR-25 |
| Expired version with no active fallback | 410 | `secret_expired` | AR-8 |
| Version limit reached | 409 | `secret_version_limit` | AR-12 |
| Same key, different request/path, or rotated KEK | 409 | `idempotency_conflict` | AR-11, AR-30 |
| Recover a non-deleted secret | 409 | `secret_not_deleted` | AR-13 |
| Recover after retention | 409 | `secret_not_recoverable` | AR-13 |
| Purge before retention | 409 | `secret_retention_active` | AR-13 |
| Disable protection | 409 | `purge_protection_locked` | AR-13 |
| Purge credential missing/invalid | 503 | `service_unavailable` | AR-14, AR-28 |
| Policy, audit, or keyring unavailable | 503 | `service_unavailable` | AR-17 |
| Decrypt or GCM integrity failure | 500 | `secret_integrity_failed` | AR-22 |

## Integration Points

- `packages/api-contract/src/index.ts` re-exports every new schema and type.
- `apps/server/src/security/keyring.ts` implements `EnvelopeKeyring`.
- `apps/server/src/secrets/envelope.ts` calls the crypto functions with secret limits.
- RD-09 passes `objectType: "certificate"` and a 131,072-byte limit.

## Testing Requirements

- Contract tests for every schema: accepted shape, unknown field, bounds, defaults, and
  cross-field refinements.
- Crypto tests for round-trip, wrong object type, wrong project/object/version, non-canonical
  base64, unknown envelope field, wrong length, wrong KEK, and over-limit ciphertext.
- A provider-based test proves `KeyringProvider` satisfies `EnvelopeKeyring`.
- No value is present in the metadata schema.

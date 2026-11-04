# Certificates: RD-09 Certificates

> **Document**: 03-02-certificates.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns certificate persistence and the write/read surface: import, generation,
renewal, public reads, private-key reads, metadata lists, search, and capabilities.

**Governing decisions:** AR-1, AR-2, AR-3, AR-4, AR-5, AR-6, AR-7, AR-8, AR-9, AR-10,
AR-11, AR-12, AR-21, AR-22, AR-23, AR-24, AR-25, AR-28, AR-31, AR-34.

## Architecture

### Current Architecture

`certificates` and `certificate_versions` exist with the required columns, foreign keys, and
triggers. The current-version pointer is deferrable, so a create can insert the parent, the
version, and the pointer in one transaction. `certificate_versions` is immutable by trigger.
`certificates` has a partial unique index on `(project_id,name)` where `deleted_at IS NULL`.
The policy repository resolves certificates as objects and hides object-scope assignments tied
to a deleted project.

### Proposed Changes

```text
GET    /v1/data/:project/certificates                     certificate.list
POST   /v1/data/:project/certificates/import              certificate.write
POST   /v1/data/:project/certificates/generate            certificate.write
GET    /v1/data/:project/certificates/:name               certificate.read
GET    /v1/data/:project/certificates/:name/private-key   certificate.read_private
PATCH  /v1/data/:project/certificates/:name               certificate.write
```

The PATCH route is the only addition beyond the published table; AR-15 justifies it with
RD-09 acceptance 10. No certificate route accepts an agent principal (AR-27). A same-project agent certificate reaches the controller and receives 401 from `requirePrincipal`; a certificate whose project differs is rejected 403 by the existing agent project guard before the controller. No certificate data is returned either way.

### Modules

| Module | Responsibility |
|---|---|
| `apps/server/src/certificates/repository.ts` | SQL for certificates, versions, list, and expiry |
| `apps/server/src/certificates/envelope.ts` | Map the v2 envelope columns |
| `apps/server/src/certificates/service.ts` | Import/generate/renew, public/private read, list |
| `apps/server/src/certificates/lifecycle.ts` | Metadata update, delete, recovery, purge |
| `apps/server/src/certificates/errors.ts` | Stable domain errors |
| `apps/server/src/audit/actions.ts` | Certificate policy detail allowlist (`mode`, `renewal`, `version`) |
| `apps/server/src/certificates/rate-limits.ts` | The 30/min private-read and 10/min write limiters |
| `apps/server/src/certificates/runtime.ts` | Compose the repository, services, and limiter |
| `apps/server/src/controllers/certificates.ts` | Route parsing, listener selection, envelopes |

## Implementation Details

### Repository

```ts
export interface CertificateRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly currentVersionId: string | null;
  readonly purgeProtected: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
}

export interface CertificateVersionRecord {
  readonly id: string;
  readonly certificateId: string;
  readonly chainPem: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
  readonly kekId: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly sans: readonly string[];
  readonly issuer: string;
  readonly serial: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface CertificateListRow extends CertificateRecord {
  readonly currentVersion: CertificateVersionMetadata | null;
}

export interface CertificateVersionMetadata {
  readonly id: string;
  readonly certificateId: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly sans: readonly string[];
  readonly issuer: string;
  readonly serial: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export class CertificateRepository {
  findCertificateByName(tx, projectId, name): Promise<CertificateRecord | undefined>;
  findActiveCertificateByName(tx, projectId, name): Promise<CertificateRecord | undefined>;
  lockActiveProject(tx, projectId): Promise<boolean>;
  lockCertificateName(tx, projectId, name): Promise<void>;
  lockCertificate(tx, id): Promise<CertificateRecord | undefined>;
  insertCertificate(tx, input): Promise<CertificateRecord>;
  insertVersion(tx, input): Promise<CertificateVersionRecord>;
  updateCurrentVersion(tx, certificateId, versionId): Promise<void>;
  updateMetadata(tx, id, input): Promise<CertificateRecord | undefined>;
  softDelete(tx, id, retentionDays): Promise<CertificateRecord | undefined>;
  recover(tx, id): Promise<CertificateRecord | undefined>;
  countVersions(tx, certificateId): Promise<number>;
  findVersion(tx, certificateId, versionId): Promise<CertificateVersionRecord | undefined>;
  findVersionMetadata(tx, certificateId, versionId): Promise<CertificateVersionMetadata | undefined>;
  findCurrentVersion(tx, certificate): Promise<CertificateVersionRecord | undefined>;
  listActiveCertificates(tx, projectId, filters): Promise<readonly CertificateListRow[]>;
}
```

The list query joins the current version, filters `c.deleted_at IS NULL`, applies the optional
`subject ILIKE` search with escaped wildcards, the optional exact SAN predicate using
`jsonb_array_elements_text(v.sans)`, the optional `v.not_after` window, the keyset cursor
`(c.name, c.id) > (:name, :id)`, orders by name and id, and uses `LIMIT :limit + 1`.

The JSONB `sans` column is read as `unknown`; the repository narrows it with a guard that
accepts only an array of bounded strings. A malformed row maps to a policy-unavailable or
integrity error, never to unchecked values.

### Envelope

`apps/server/src/certificates/envelope.ts` maps the stored columns to/from `EncryptedValue`.
It uses the same column names as `certificate_versions`:

```ts
export function toStoredCertificateEnvelope(encrypted: EncryptedValue): {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
  readonly kekId: string;
};

export function fromStoredCertificateEnvelope(
  row: CertificateVersionRecord,
): EncryptedValue;
```

Encryption and decryption always pass:

```ts
{
  objectType: "certificate",
  projectId: certificate.projectId,
  objectId: certificate.id,
  version: versionId,
}
```

Decryption uses `{ maxCiphertextBytes: 131_072 }`. A `KeyringError` maps to 503; a
`CryptoInputError` or `CryptoIntegrityError` maps to 500 `certificate_integrity_failed`.

### Import

1. Validate the request shape in the controller.
2. Resolve the active project by name. A missing project is 404 `project_not_found`.
3. Pre-authorize `certificate.write` at project scope with audit disabled. A denial writes one
   deny before any parsing or key generation, so an unauthorized caller cannot force X.509
   parsing or RSA-3072 work. A scope mismatch is 404; `no_assignment` is 403.
4. Parse and validate the material with `parseCertificateMaterial` (03-01), or generate it.
   This happens after the pre-check so malformed input and generation cannot probe names. The
   returned `privateKeyBytes` buffer is held in a `try/finally`; it is zeroed on every exit,
   including a denial after parsing and a transaction that never starts. The PEM string cannot
   be zeroed and is treated as a short-lived response-construction value.
5. Resolve the certificate row by name including deleted rows.
6. Authorize `certificate.write` on `{ type: "certificate", id: existing?.id ?? generatedId,
   projectId }` with audit disabled. A denial writes one independent deny.
7. In one transaction:
   - take the audit chain lock first;
   - lock the active project `FOR SHARE` and return 404 if it disappeared;
   - take the `(project,name)` advisory lock;
   - re-read the row by name;
   - if a deleted row exists, throw 409 `certificate_name_conflict`;
   - if `expectedVersionId` is supplied, require an active row whose current version id equals
     it; otherwise throw 409 `certificate_version_conflict`;
   - if an active row exists, lock it and enforce the 1,000 retained-version limit;
   - if no active row exists, insert the certificate parent with the generated id, project id,
     name, and tags before inserting the version;
   - resolve the final certificate id (the existing row id or the generated id), encrypt the
     private key DER with the certificate AAD for that id, then zero the DER buffer;
   - insert the version, move `current_version_id`, set `updated_at`, and update tags if the
     request supplied them; keep the existing tags otherwise;
   - write one joined `certificate.write` allow with details
     `{ version, mode: "import", renewal: 0|1 }`. The detail allowlist for certificate policy
     actions gains `mode` and `renewal`; other policy actions keep their existing set.
9. The encryption happens inside the transaction so a concurrent create cannot make the
   envelope bind the wrong certificate id. The service returns `{ created, response }`; the
   controller uses 201 for `created` and 200 for a renewal. The response includes the
   normalized `certificatePem`, `chainPem`, and the warnings.
10. A unique violation maps to 409 `certificate_name_conflict`; a failure after authorization
   writes one independent error outcome.

### Generation

The flow is identical to import, with `generateSelfSignedCertificate` in place of parsing.
The generated private key DER is encrypted and zeroed. The response includes the generated
public certificate. `mode` is `"generate"`.

### Visibility Before Existence

Certificate names must not be enumerable by a caller with no access.

- For import/generate and every lifecycle route, pre-authorize the action at **project scope**
  with audit disabled before parsing, generating, or resolving the certificate name. A denial
  writes one deny and returns 403 for `no_assignment` or 404 for a scope mismatch. The object
  decision is then recorded for the final event.
- For public reads, call `hasAny(actor, "certificate.read", context, { audit: false })` first.
  If the caller has the action nowhere, write one deny and return 403 before resolving the
  name. If the caller has some read capability, resolve the certificate and authorize on the
  object; every denial (including `no_assignment`) maps to 404 so a caller with partial access
  cannot distinguish an existing name from a missing one.
- For private reads, call `hasAny(actor, "certificate.read", context, { audit: false })` first.
  A caller with no public-read capability anywhere gets 403 before the name lookup. After the
  object `read_private` decision, a denial returns 403 only when `certificate.read` on the same
  object is allowed (the acceptance-6 case); otherwise it returns 404.
- List already authorizes at project scope through `authorizeList`; a missing project is 404
  and an out-of-scope project list is 403/404 per the policy reason.

### Public Read

1. Resolve the active project and the certificate by name including deleted rows.
2. A missing or deleted certificate is 404 `certificate_not_found`.
3. Authorize `certificate.read` with audit disabled. A denial writes one deny and maps every
   read denial to 404 `certificate_not_found` (after the `hasAny` pre-check above).
4. Resolve `?version=` or the current version. A missing version is 404
   `certificate_version_not_found`.
5. If no explicit version was requested and `notAfter <= now`, write one error outcome and
   return 410 `certificate_expired`.
6. Write one allow event with `{ version }` detail before returning the public chain.
7. Return metadata plus `certificatePem` (the first PEM block) and `chainPem` (every non-leaf
   block, including a supplied root; empty when none).

The 410 body carries no version id. A client that needs the explicit-version escape reads the
list metadata first, which includes the current `version.id`.

### Private-Key Read

The flow matches the public read with these changes:

- Authorize `certificate.read_private`, not `certificate.read`. A caller with only
  `certificate.read` on the object receives 403; a caller that cannot read the public object
  receives 404.
- Decrypt the envelope first, without returning anything. On failure, write one independent
  error outcome and return 500 `certificate_integrity_failed`.
- On success, write one allow event with `{ version }`, then return `{ id, projectId, name,
  fingerprint, privateKeyPem, version, capabilities }`. If the evidence write fails, zero the
  decrypted buffer and return 503; no value is returned.
- Zero the decrypted buffer after converting it to a PEM string. AR-21 records the one-outcome
  rule; this is the one read that decrypts before writing its allow so a tampered envelope is
  reported as an error, not an allow.
- The route has a 30/min per-principal limiter in addition to the shared 600/min data limiter.

### List and Search

1. Resolve the active project.
2. Call `authorizeList(actor, "certificate.list", { type: "project", id }, context)`.
   `scope_mismatch`/`expired_assignment` maps to 404 `project_not_found`; `no_assignment` to
   403. An object-scope-only reader receives 403.
3. Query active certificates with the filters.
4. Load one actor snapshot with `capabilitiesForMany` for the page.
5. Return `{ certificates, nextCursor }`.

Metadata items contain no PEM and no private key. For `?version=`, the entire response metadata
(top-level subject, SANs, issuer, serial, fingerprint, dates, `daysToExpiry`, `chainLength`,
and `version`) describes the **selected version**; the parent fields (`tags`, `createdAt`,
`updatedAt`, `deletedAt`, `purgeAfter`, `purgeProtected`) describe the certificate. `status` is
`deleted` when the parent is soft-deleted, `expired` when the selected version's
`notAfter <= now`, otherwise `active`. `daysToExpiry` is
`ceil((notAfter - now) / 86_400_000)` and may be negative. `chainLength` counts the PEM blocks
in `chain_pem`.

### Renewal

An active name is renewed by import or generation. The parent row id is stable, the new
version becomes current, and the old version remains readable by `?version=`. Tags supplied on
the renewal replace the parent tags; absent tags keep the current tags. Purge protection is
not changed by import/generate; it is changed by PATCH (03-03).

### Capabilities

`PolicyService.capabilitiesForMany(actorId, resources)` already accepts certificate
resources. Every metadata, write, public-read, and private-read response includes the five
flags. The list computes them from one snapshot.

### Controller and Listener Behavior

`apps/server/src/controllers/certificates.ts` mirrors `SecretsController`:

- Parse `certificateImportRequestSchema`, `certificateGenerateRequestSchema`,
  `certificateMetadataUpdateRequestSchema`, `certificateReadQuerySchema`, and
  `certificateListQuerySchema`.
- Validate `:project` with `projectNameSchema` and `:name` with `certificateNameSchema`.
- Require a browser or CLI principal on every route. There is no agent branch.
- Map domain errors to `ApiError`.
- Return 201 for a new certificate, 200 for a renewal/read/patch, and 204 for delete/purge.
- Register `/import` and `/generate` before `/:name`.

### Project Certificate Count

RD-09's Must Have requires the UI to show a certificate count. Add
`certificateCount: z.number().int().min(0)` to the project **list item** contract
(`projectListItemSchema`), not to the single-project contract. `ProjectRepository.listVisible`
returns a `ProjectListRecord extends ProjectRecord` with a correlated `COUNT(*)` over active
certificates, `ProjectService.list` returns the list item type, and `ProjectsController.list`
serializes it. Create/get/update keep the existing `projectSchema`. RD-12 renders the count and
the CLI link; RD-09 supplies the data.

### Rate Limits

The shared `/v1/data` limiter (600/min, keyed by the authenticated principal, exposed by
`apps/server/src/secrets/rate-limits.ts` as the `secretRateLimits` service) applies to every
certificate route. `apps/server/src/certificates/rate-limits.ts` adds a 30/min per-principal
bucket for the private-key route and a 10/min per-principal bucket for import/generate, so a
write principal cannot exhaust the 1,000-version bound in one minute. PATCH uses the shared
bucket. All keys use the authenticated user id; a certificate route never accepts an agent.

### Log Redaction

`apps/server/src/observability/logger.ts` gains `req.body.privateKeyPem` and
`req.body.keyPem` redaction paths. A sentinel private key in a request body must not appear in
the captured logs.

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Invalid PEM, key, chain, SAN, subject, dates | 422 `validation_error` | AR-6..AR-10 |
| Public or private field above the configured bound | 413 `certificate_too_large` (the parser enforces the bound; the contract max is a transport ceiling) | AR-6 |
| Deleted name | 409 `certificate_name_conflict` | AR-12 |
| Missing/deleted certificate | 404 `certificate_not_found` | AR-23 |
| Caller can read the public object but not `read_private` | 403 `access_denied` | AR-22 |
| Caller cannot read the public object or has no access anywhere | 404 `certificate_not_found` / 403 before lookup | AR-22 |
| Missing version | 404 `certificate_version_not_found` | AR-23 |
| Expired current version | 410 `certificate_expired` | AR-23 |
| Version limit | 409 `certificate_version_limit` | AR-11 |
| Stale `expectedVersionId` | 409 `certificate_version_conflict` | AR-2 |
| Private-key decrypt failure | 500 `certificate_integrity_failed` | AR-25 |
| Policy/audit/keyring failure | 503 `service_unavailable` | AR-21 |
| Rate limit | 429 `RATE_LIMIT_EXCEEDED` | AR-22 |

## Integration Points

- The policy service authorizes every route; the audit writer records one outcome.
- The envelope uses the existing v2 AAD and keyring port.
- RD-10 does not receive certificate routes.
- RD-11 consumes the contracts and stable errors.
- RD-13 backs up the parent, versions, and notification rows.

## Testing Requirements

- Specification tests for import, generation, renewal, public/private reads, list/search,
  capabilities, expiry, and audit.
- Implementation tests for PEM smuggling, chain links, key types, key mismatch, cursor
  continuation, wildcard search, concurrent renewal, version limit, and AAD separation.

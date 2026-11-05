# Current State: RD-09 Certificates

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The database schema already models every RD-09 object. `certificates` has a project foreign
key, a validated name, a deferrable current-version pointer, JSONB tags, one-way purge
protection, timestamps, and a retention timestamp. `certificate_versions` stores the chain
PEM, the AES-GCM envelope columns, the leaf's subject, SANs, issuer, serial, fingerprint,
validity dates, creator, and creation time. The table has an update-rejection trigger and a
delete trigger that only the dedicated `openvault_purger` session can pass after retention and
with protection off. The parent has the same delete protection.

The v2 envelope in `packages/core` already binds `objectType`, project, object, and version,
and accepts `objectType: "certificate"`. The server keyring provider satisfies the
`EnvelopeKeyring` port. The policy engine evaluates all seven certificate actions and
`capabilitiesForMany` computes certificate flags. The audit writer, the persistent policy
adapter, the chain lock, and the request context are complete. The project lifecycle, the
data-plane project-name resolution, the rate limiter, and the dedicated purger are complete
from RD-08.

`@peculiar/x509` is already a direct server dependency and is used to generate and verify the
internal agent CA. The configuration already exposes `OPENVAULT_CERT_MAX_BYTES` and
`OPENVAULT_CERT_TTL_DAYS`; the latter is the agent certificate TTL and is not the data-plane
certificate validity.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/database/schema.ts` | Certificate tables | Add one notification table and a `not_after` index |
| `apps/server/migrations/20261030094213_triggers-and-seed.up.sql` | Immutability, purge, and protection triggers | No trigger change |
| `packages/core/src/crypto.ts` | v2 envelope | Reuse; no change |
| `apps/server/src/security/keyring.ts` | `EnvelopeKeyring` implementation | Reuse; no change |
| `apps/server/src/security/x509.ts` | X.509 generation and verification helpers | Reuse the library; no change |
| `apps/server/src/secrets/*` | RD-08 repository/service/lifecycle patterns | Reuse; generalize the purger |
| `apps/server/src/secrets/purge.ts` | Dedicated purger | Move to `purge/vault-purger.ts` and generalize |
| `apps/server/src/rbac/{policy-service,policy-repository}.ts` | Certificate actions, capabilities, object visibility | Reuse; no change |
| `apps/server/src/audit/{actions,audit-writer}.ts` | Audit catalog and writer | Add the expiry-warning action/details |
| `apps/server/src/config/{types,loader,redact}.ts` | Configuration | Add expiry settings; clamp the cert size |
| `apps/server/src/controllers/secrets.ts` | Data-plane controller pattern | Mirror for certificates |
| `apps/server/src/app.ts` | Composition | Register the certificate runtime and scheduler |
| `apps/server/tests/integration/helpers/purger.ts` | Disposable purge role | Grant the certificate tables |
| `docs/guide/certificates.md` | Target documentation | Replace with implemented behavior |
| `docs/reference/api.md` | Published certificate routes | Add examples, PATCH, and behavior |

### Code Analysis

- `certificates.name` already enforces the same pattern as secrets.
- `certificates.current_version_id` is deferrable, so a create can insert the certificate,
  insert the version, and move the pointer in one transaction.
- `certificate_versions.chain_pem` is capped at 131,072 characters and the envelope
  ciphertext at 131,072 bytes.
- `certificate_versions` has no `private_key` column; the ciphertext is the only place the
  PKCS#8 material can live.
- `certificate_versions` has no separate leaf column; `chain_pem` is the only public text.
- The policy repository already resolves certificates as objects and filters object-scope
  assignments by the parent project.
- `OPENVAULT_CERT_MAX_BYTES` currently allows 1,024–2,097,152, but the schema caps the stored
  chain and ciphertext at 131,072. The loader must be clamped to 131,072.
- There is no notification table, scheduler, or webhook code.
- There is no certificate route, contract, repository, service, or PEM validator.

## Gaps Identified

### Gap 1: No certificate product surface

**Current Behavior:** The schema and policy exist, but no certificate request can be served.

**Required Behavior:** Contract-validated import, generation, public/private reads, list,
search, lifecycle, and stable errors.

**Fix Required:** Add contracts, PEM/key/chain validation, generation, a repository, services,
controllers, runtime wiring, and tests.

### Gap 2: No expiry job or durable notification state

**Current Behavior:** No code reads `certificate_versions.not_after` and no table can record a
sent threshold.

**Required Behavior:** A daily scan records days-to-expiry and sends at most one warning per
version and threshold, with retry after a failed delivery.

**Fix Required:** Add the notification table, the scheduler, the webhook client, and the
expiry audit action.

### Gap 3: The purger is secret-only

**Current Behavior:** `SecretPurger` verifies and deletes only `secrets` and
`secret_versions`.

**Required Behavior:** The same verified session must purge certificates and their versions,
and remove notification rows.

**Fix Required:** Generalize the purger while preserving the RD-08 secret behavior and tests.

### Gap 4: The certificate size limit is inconsistent

**Current Behavior:** The loader accepts up to 2 MiB, while the schema and ciphertext checks
cap at 131,072.

**Required Behavior:** A value accepted by the loader must be storable.

**Fix Required:** Clamp `OPENVAULT_CERT_MAX_BYTES` to 131,072 and add the private-key PEM bound.

### Gap 5: No certificate audit action for expiry warnings

**Current Behavior:** The audit catalog has no action for an expiry warning.

**Required Behavior:** RD-09 requires expiry warnings in the audit log.

**Fix Required:** Add `certificate.expiry_warning` and its bounded details allowlist.

## Dependencies

### Internal Dependencies
- RD-06 policy engine, certificate actions, and capabilities.
- RD-07 audit writer and chain lock.
- RD-08 envelope, lifecycle, retention, purger, controller, and test patterns.
- Existing schema and triggers.

### External Dependencies
- Node.js 24 crypto and WebCrypto.
- `@peculiar/x509` 3.1.0 (already a dependency).
- PostgreSQL 16 and 17.
- Existing Vitest, WebAFX, and BlendSDK patterns. No new package.

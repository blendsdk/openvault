# Testing Strategy: RD-09 Certificates

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Contracts and PEM/key/chain validation | 95% |
| Generation | 95% |
| Repository, service, and lifecycle | 90% |
| Expiry job, scheduler, webhook | 90% |
| Controllers and wiring | 85% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL, the real keyring, real AES-GCM, real
  `@peculiar/x509`, and a local HTTP webhook. Only time and the purge-role availability may be
  substituted.
- Every specification case below is derived from RD-09, the component documents, or the
  Ambiguity Register. Expectations are not derived from the implementation.

## 🚨 Specification Test Cases

### Contracts

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | `certificateImportRequestSchema.parse({ name, certificatePem, privateKeyPem })` | `allowNotYetValid` is false; `chainPem` and `tags` are absent | AR-6 |
| ST-2 | `certificateGenerateRequestSchema.parse({ name, subject, sans })` | `keyType` is `ec-p256`; `validityDays` is 365 | AR-10 |
| ST-3 | A generate request with `validityDays: 826` | Fails the 1–825 bound | AR-10 |
| ST-4 | An import request with an unknown field | Fails; strict object | AR-6 |
| ST-5 | `certificateMetadataSchema.safeParse` with a `certificatePem` or `privateKeyPem` key | Fails; metadata has no PEM | AR-4 |
| ST-6 | `certificateListQuerySchema.parse({})` | `limit` is 50 | AR-24 |
| ST-7 | `certificateListQuerySchema.safeParse({ limit: 0 })` and `{ limit: 101 }` | Both fail | AR-24 |
| ST-8 | `certificateListQuerySchema.safeParse({ expiresAfter: later, expiresBefore: earlier })` | Fails the ordering refinement | AR-24 |
| ST-9 | A SAN value without a typed prefix or with a control character | Fails | AR-10 |
| ST-9a | A certificate containing an unsupported SAN type (for example `otherName`) | Import returns 422; no row; the limitation is documented | AR-6 |
| ST-9b | SAN grammar table: `DNS:example.com`, `DNS:*.example.com`, `IP:127.0.0.1`, `IP:::1`, `URI:openvault://x`, `email:a@b.example` valid; `DNS:foo.*.com`, `IP:999.1.1.1`, `URI:relative`, `email:not-an-email` invalid | The canonicalizer accepts/rejects exactly these | AR-10 |
| ST-10 | 16 certificate tags | Fails the shared 15-pair bound | AR-6 |

### PEM, Key, and Chain Validation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-11 | Valid RSA 2048 leaf and matching PKCS#8 key | Parses; key type `rsa-2048`; subject/SAN/serial/fingerprint/dates populated | RD-09 acceptance 1 |
| ST-12 | Valid EC P-256 leaf and matching key | Parses; key type `ec-p256` | RD-09 acceptance 1 |
| ST-13 | A traditional PKCS#1 key label (`RSA PRIVATE KEY`) or a traditional EC label | 422; no row | AR-7 |
| ST-14 | `-----BEGIN ENCRYPTED PRIVATE KEY-----`, a PKCS#1 body under a `PRIVATE KEY` label, RSA-PSS, EC P-384, or RSA 4096 | 422; no row | AR-7 |
| ST-15 | Ed25519 or RSA 1024 key | 422; no row | AR-7 |
| ST-16 | Leaf public key does not match the private key | 422; no certificate or version row | RD-09 acceptance 2 |
| ST-17 | Leaf with a valid intermediate chain | Imports; `chainLength` is 2; public read returns both PEM parts | RD-09 acceptance 1 |
| ST-18 | Chain whose first certificate has the leaf's issuer name but a signature that does not verify | 422; no row | AR-8 |
| ST-19 | Leaf plus a root that is not its issuer (missing intermediate) | Imports with `missing_intermediate`; only the leaf is stored | RD-09 Should Have |
| ST-19a | A valid chain whose intermediate is expired or not yet valid | `signatureOnly` verifies the signature; import succeeds with `expired_intermediate` or `not_yet_valid_intermediate` | AR-8 |
| ST-19b | Chain whose top is not self-signed | Imports with `missing_intermediate`; the verified prefix is stored | RD-09 Should Have |
| ST-20 | Used intermediate with `CA=false` or without `keyCertSign` | 422; no row | AR-8 |
| ST-21 | Not-yet-valid leaf without `allowNotYetValid` | 422; no row | RD-09 acceptance 3 |
| ST-21a | A leaf whose DN exceeds 1,024 characters, whose serial is empty, or whose `notAfter <= notBefore` | 422 before encryption; no row | AR-6 |
| ST-22 | Not-yet-valid leaf with `allowNotYetValid` | Imports with `not_yet_valid` warning | RD-09 acceptance 3 |
| ST-23 | Expired leaf | Imports with `expired` warning | AR-9 |
| ST-24 | Two leaf blocks, a `CERTIFICATE` in the key field, or non-whitespace outside blocks | 422; no row | AR-6 |
| ST-25 | Non-canonical base64 or a truncated PEM body | 422; no row | AR-6 |
| ST-26 | Leaf PEM above the configured bound (131,073 bytes) but within the contract ceiling | 413 `certificate_too_large` at the route or parser; no row | AR-6 |
| ST-27 | Private-key PEM above the parser bound (16,385 bytes) but within the contract ceiling | 413 `certificate_too_large`; no row | AR-6 |

### Generation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-28 | Generate `rsa-2048`, `rsa-3072`, and `ec-p256` with subject and SANs | 201; the certificate verifies against its own public key; SANs and subject match | RD-09 acceptance 4 |
| ST-29 | Generated certificate has `CA=false`, serverAuth and clientAuth EKU, and the expected key usage | RSA uses digitalSignature+keyEncipherment; EC uses digitalSignature only; extensions match the profile | AR-10 |
| ST-30 | Generated private key is used to verify the certificate signature and matches the public key | Match succeeds | RD-09 acceptance 4 |
| ST-31 | Generate with `validityDays` 1 and 825 | Both accepted; `notBefore` is 30 seconds before the service clock; dates match | AR-10 |
| ST-32 | Generate response | Contains `certificatePem` and no `privateKeyPem` anywhere | RD-09 acceptance 5 |
| ST-33 | Generate with an empty SAN list or an invalid SAN | 422; no row | AR-10 |
| ST-34 | Generate with an invalid subject | 422; no row | AR-10 |

### Import, Renewal, and Name Lifecycle

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-35 | Import a new name | 201; one certificate row, one version, current pointer set; one joined `certificate.write` allow with `mode: "import"` and `renewal: 0` | AR-2, AR-21 |
| ST-36 | Import an existing active name | 200; a second version; current pointer moves; the first version is readable by `?version=` | AR-2 |
| ST-37 | Generate an existing active name | 200; a second version; current pointer moves | AR-2 |
| ST-38 | Import/generate a soft-deleted name | 409 `certificate_name_conflict`; the deleted row is unchanged | AR-12 |
| ST-39 | Create 1,000 retained versions and renew again | 409 `certificate_version_limit`; no row or allow event | AR-11 |
| ST-40 | Two concurrent renewals of the same name | Two versions; both commits succeed or one retries; the current pointer is one of them | AR-12 |
| ST-40a | Renew with an `expectedVersionId` that is no longer current | 409 `certificate_version_conflict`; no version inserted | AR-2 |
| ST-40b | Renew with the current `expectedVersionId` | 200; the new version becomes current | AR-2 |
| ST-41 | A failed import after authorization | No certificate, version, or allow event remains; one error outcome exists | AR-21 |

### Public and Private Reads

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-42 | Public read of an active certificate | 200; metadata plus `certificatePem` and `chainPem`; no private key | RD-09 acceptance 5 |
| ST-43 | Private read with `certificate.read_private` | 200; the returned key matches the certificate; one `certificate.read_private` allow | RD-09 acceptance 6–7 |
| ST-43a | Import/generate/private-read request bodies containing a sentinel private key | The sentinel is absent from captured logs; `req.body.privateKeyPem` and `req.body.keyPem` are redacted | AR-6 |
| ST-43b | A tampered stored private-key envelope | 500 `certificate_integrity_failed`; exactly one `error` outcome and no allow | AR-21 |
| ST-44 | Private read with only `certificate.read` | 403 `access_denied`; no key | RD-09 acceptance 6 |
| ST-45 | Private read audit event and logs | No private key, PEM body, or key id present | RD-09 acceptance 7 |
| ST-46 | Decrypt a stored certificate envelope with the certificate's own project/object/version but `objectType: "secret"`, then also copy the columns into a secret version row and read it | The direct decrypt throws `CryptoIntegrityError`; the secret read returns 500 `secret_integrity_failed`; no value | RD-09 acceptance 8 |
| ST-47 | Read an expired current version | 410 `certificate_expired`; one error outcome; no PEM | AR-23 |
| ST-48 | Read an expired version with `?version=<id>` | 200 with that version's chain; top-level subject/SANs/issuer/serial/fingerprint/dates/version all describe the selected version | AR-23 |
| ST-49 | Read an expired current version's private key without `?version=` | 410; no key | AR-23 |
| ST-50 | Missing certificate or version | 404 `certificate_not_found` / `certificate_version_not_found` | AR-23 |
| ST-51 | Certificate in a deleted project | 404 on public/private read; hidden from list; no allow value returned | AR-27 |
| ST-52 | Agent listener request to any certificate route with a valid same-project agent certificate, and with a project-mismatched certificate | 401 `authentication_required` for the same-project case; 403 from the existing agent project guard for the mismatch; no certificate data in either case | AR-27 |
| ST-53 | Public read without `.read` but with `.list` | 403; no chain | AR-22 |

### List, Search, and Capabilities

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-54 | List certificates | Items have metadata, status, daysToExpiry, chainLength, version, capabilities; no PEM body | AR-4, AR-34 |
| ST-55 | `q` with `%` or `_` | Literal subject search; wildcards escaped | AR-24 |
| ST-56 | `san` filter | Returns only certificates whose current version contains the SAN | AR-24 |
| ST-57 | `expiresBefore`/`expiresAfter` | Filters the current version's `not_after` | AR-24 |
| ST-58 | First page with `limit=1`, then the returned cursor | The second page starts after the first name/id | AR-24 |
| ST-59 | Malformed cursor | 422 `validation_error` | AR-24 |
| ST-60 | Object-scope-only `certificates.reader` reads its certificate and lists | Read succeeds; list returns 403 | AR-22 |
| ST-61 | Org admin, project admin, certificates officer, certificates reader, and auditor list | Capability flags match the policy evaluator; one actor snapshot for the page | AR-22 |

### Lifecycle

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-62 | PATCH tags | Metadata changes; version count is unchanged; one joined allow event | AR-15 |
| ST-62a | PATCH/delete/recover/purge success, denial, and rollback | Exactly one allow/deny/error outcome per attempt; no allow on rollback | AR-21 |
| ST-63 | PATCH `{ purgeProtected: true }` then delete and age past retention, then purge | Enable 200; delete 204; purge 409 `purge_protection_locked` | RD-09 acceptance 10 |
| ST-64 | PATCH `{ purgeProtected: false }` when already false | 200 no-op; version count unchanged | AR-14 |
| ST-65 | PATCH `{ purgeProtected: false }` when true | 409 `purge_protection_locked` | AR-14 |
| ST-66 | DELETE an active certificate | 204; read/list hide it; `deleted_at`/`purge_after` use the retention value | RD-09 acceptance 10 |
| ST-67 | Recover before retention | 200; public read works again; columns are null | RD-09 acceptance 10 |
| ST-68 | Recover after retention | 409 `certificate_not_recoverable` | AR-14 |
| ST-69 | Purge before retention | 409 `certificate_retention_active`; no rows deleted | AR-14 |
| ST-70 | Purge after retention without protection | 204; versions and parent gone; notification rows gone; the name can be recreated | RD-09 acceptance 10 |
| ST-71 | Purge without `OPENVAULT_PURGE_DB_URL` or with the application role/wrong database | 503 `service_unavailable`; no rows deleted; one error outcome | AR-13 |
| ST-72 | Purge while the project is soft-deleted | 404 `project_not_found`; no rows deleted | AR-27 |
| ST-73 | A protected deleted certificate's name | Import/generate returns 409 forever | AR-12, AR-14 |
| ST-74 | RD-08 secret purge after the `VaultPurger` refactor | Same success/failure behavior as before | AR-13 |

### Expiry Job

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-75 | Certificates ending in 30, 14, and 7 days | One webhook call and one `certificate.expiry_warning` allow per threshold; each event has the `version` detail | RD-09 acceptance 9 |
| ST-75a | Remaining times of 30d+1ms, 14d+1ms, 14d, 7d+1ms, and 7d | Thresholds 30, 30, 14, 14, and 7; no stale 30-day warning at 14 days | AR-17 |
| ST-76 | A certificate ending in 10 days | Only the 14-day warning is sent; no 30 or 7 call | AR-17 |
| ST-77 | Run the job twice | The second run sends nothing; the claim rows remain `sent` | RD-09 acceptance 9 |
| ST-77a | Simulate a crash after claim but before send; run again after the lease | The stale `pending` row is reclaimed and the warning is delivered | AR-20 |
| ST-77b | Mark-sent fails; run again after the lease | The row is reclaimed and the warning is retried | AR-20 |
| ST-77c | The audit event for `audit_event_id` already exists | The service skips the duplicate audit write and still marks sent | AR-21 |
| ST-78 | Webhook returns 500 on the first run and 200 on the second | First run audits an error and deletes the claim; second run sends and marks sent | AR-20 |
| ST-79 | Webhook payload | Contains the stable eventId and public metadata; no PEM, private key, or key id | AR-19 |
| ST-80 | Webhook with a configured secret | `X-OpenVault-Timestamp` is present and `X-OpenVault-Signature` is the correct HMAC over `<timestamp>.<rawBody>` | AR-19 |
| ST-81 | No webhook configured | No network call; audit `webhook: "skipped"`; claim marked sent | AR-19 |
| ST-82 | Deleted certificate, deleted project, non-current version, or expired certificate | No warning and no claim | AR-17 |
| ST-82a | Delete or renew a certificate between `listExpiring` and `claim` | The claim's active-state recheck returns no row; no webhook and no claim | AR-17 |
| ST-83 | Two `runOnce()` calls concurrently | One claim, one send | AR-18 |
| ST-84 | `nextRunAt` before and after the configured hour | Returns today or tomorrow at the configured hour | AR-16 |
| ST-85 | Webhook timeout or redirect | Delivery fails; claim is retried | AR-19 |
| ST-85a | `runOnce` rejects | The scheduler logs, and still schedules the next run in `finally` | AR-16 |
| ST-85b | Production config with a credential URL, fragment, or link-local/metadata address | Config load fails; the URL is absent from redacted config and logs | AR-26 |

### HTTP and Wiring

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-86 | Import/generate/PATCH/delete/recover/purge without CSRF | Rejected by the existing browser mutation guard | RD-09 security |
| ST-87 | Invalid JSON or unknown field | 400/422 stable envelope; no PEM/key in the error | AR-6 |
| ST-88 | 31 private-key reads in a minute from one principal | The last request returns 429 | AR-22 |
| ST-88a | 11 import/generate requests in a minute from one principal | The last request returns 429 | AR-22 |
| ST-89 | A certificate import body with a 128 KiB escaped chain | Passes the `/v1/data` body guard and stores the chain | AR-6, AR-26 |
| ST-90 | A sentinel private-key body after import/read/delete/purge/deny/error | The sentinel is absent from responses, audit events, request bodies, and captured logs | RD-09 acceptance 5, 7 |
| ST-91 | Route × principal matrix: import/generate/PATCH/delete/recover/purge × reader, officer, object-scope reader, auditor, wrong-project admin, and a valid same-project agent certificate | Each denied request returns the mapped status, changes no state, and writes one deny; a same-project agent gets 401, a project-mismatched certificate gets 403 | AR-27 |
| ST-92 | Two projects with the same certificate name; a project-A reader requests project B for read/private/write/delete/recover/purge/list | 404 with no data; no allow event; the project-A certificate is unaffected | AR-1, AR-22 |
| ST-93 | Purger called with a certificate id from one project and a different project id/name | 404/503; no rows deleted | AR-13 |
| ST-94 | Purger role is a member of an object-table owner or a superuser role | 503; no rows deleted | AR-13 |
| ST-95 | Private read succeeds decrypting but the audit write fails | 503; no value; the decrypted buffer is zeroed | AR-21 |
| ST-96 | A 131,073-byte public PEM at the HTTP route | 413 `certificate_too_large`; no row | AR-6 |
| ST-97 | A public read whose audit/evidence write fails | 503 `service_unavailable`; no `certificatePem` or `chainPem` in the response | AR-21 |
| ST-98 | Project list after creating two active and one deleted certificate | `certificateCount` is 2 on the project list item; single-project responses keep the existing shape | AR-35 |

## Test Categories

### Specification Tests

| Test file | ST cases | Component |
|---|---|---|
| `packages/api-contract/tests/certificates.spec.test.ts` | ST-1..10 | Contracts |
| `packages/api-contract/tests/projects.spec.test.ts` | ST-98 | Project list count contract |
| `apps/server/tests/integration/certificates-pem.spec.test.ts` | ST-9a, ST-9b, ST-11..27, ST-19a..b, ST-21a | PEM, key, chain, SAN grammar |
| `apps/server/tests/integration/certificates-generate.spec.test.ts` | ST-28..34 | Generation |
| `apps/server/tests/integration/certificates-write.spec.test.ts` | ST-35..41, ST-40a, ST-40b | Import, renewal, name lifecycle |
| `apps/server/tests/integration/certificates-read.spec.test.ts` | ST-42..61, ST-43a, ST-43b, ST-48, ST-95, ST-97 | Public/private read, list, search, capabilities, AAD, redaction |
| `apps/server/tests/integration/certificates-lifecycle.spec.test.ts` | ST-62..74, ST-62a, ST-93, ST-94 | Lifecycle, audit, and purge guards |
| `apps/server/tests/integration/certificates-expiry.spec.test.ts` | ST-75..85, ST-75a, ST-77a..c, ST-82a, ST-85a, ST-85b | Expiry job, boundaries, lease, and webhook |
| `apps/server/tests/integration/certificates-http.spec.test.ts` | ST-86..92, ST-88a, ST-96 | Routes, CSRF, rate limits, leakage, authorization matrix, tenant isolation |
| `apps/server/tests/integration/projects-http.impl.test.ts` | ST-98 | Project list count |

### Implementation Tests

| Test file | Description | Priority |
|---|---|---|
| `packages/api-contract/tests/certificates.impl.test.ts` | SAN grammar, bounds, unknown fields, JSONB edge cases | High |
| `apps/server/tests/integration/certificates-pem.impl.test.ts` | PEM smuggling, chain edge cases, key types, metadata bounds, generation bounds | High |
| `apps/server/tests/integration/certificates-write.impl.test.ts` | Concurrent renewal, rollback, version limit, `expectedVersionId` | High |
| `apps/server/tests/integration/certificates-read.impl.test.ts` | AAD separation, wildcard search, cursor continuation, agent listener, rate limit, read-evidence failure | High |
| `apps/server/tests/integration/certificates-lifecycle.impl.test.ts` | Purger guards, notification cleanup, name reservation, concurrent delete/recover | High |
| `apps/server/tests/integration/certificates-expiry.impl.test.ts` | Claim races, HMAC, timeout, redirect, scheduler math, malformed claims | High |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Certificate import chain | PEM, crypto, repository, audit | Real RSA/EC chains and key matching |
| AAD separation | Crypto, repository | A certificate envelope fails as a secret |
| Purger family switch | Purger, triggers, lifecycle | Secret and certificate purges share one verified session |
| Expiry delivery | Expiry, webhook, audit | Real HTTP server, claims, retries, HMAC |
| Project hide chain | Projects, certificates, policy | Delete a project and verify every certificate surface is hidden |

### End-to-End Tests

N/A — the CLI and UI are RD-11 and RD-12. The HTTPS integration suite is the end-to-end
boundary for this plan.

## Test Data

### Fixtures Needed

- A migrated disposable database per test file and a real keyring.
- A `certificate-fixtures.ts` helper that generates:
  - self-signed RSA 2048/3072 and EC P-256 leaves with configurable subject, SANs, notBefore,
    and notAfter;
  - a root -> intermediate -> leaf chain;
  - a mismatched key pair;
  - a chain with an invalid signature;
  - a chain with a non-CA intermediate;
  - a not-yet-valid and an expired leaf;
  - PKCS#1 (body and label), encrypted, Ed25519, RSA 1024, RSA-PSS, EC P-384, and RSA 4096 keys.
  - Expired and not-yet-valid intermediates.
  - A leaf with an oversized DN or inverted validity dates.
- An org admin, project admin, certificates officer, certificates reader (project and
  object scope), auditor, plain reader, and a service identity.
- A valid agent certificate issued by the test CA for the agent-listener denial test.
- Two projects with the same certificate name for the cross-tenant matrix.
- A second purge role that is a member of an object-table owner for the guard test.
- Two projects, one soft-deleted project, and one soft-deleted certificate.
- A local `http.createServer` webhook that records bodies/headers and can return 200, 500, a
  redirect, or hang.
- A disposable `openvault_purger` with the six table grants.

### Mock Requirements

- No crypto, X.509, or database mocks. The clock, webhook URL, and purge URL may be injected.
- The audit writer may be wrapped only to force a storage failure in rollback tests.
- The app logger may capture records through the existing `loggerDestination` seam.

## Verification Checklist

- [ ] All specification cases (ST-*) are defined with concrete input/output pairs.
- [ ] Every ST case traces to an RD, spec doc, or AR entry.
- [ ] Specification tests are written before implementation.
- [ ] The red phase is recorded for every phase.
- [ ] All specification tests pass after implementation.
- [ ] Implementation tests cover edge cases and internals.
- [ ] `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, and the docs build pass.
- [ ] The integration suite passes on PostgreSQL 16 and 17.
- [ ] No regressions in the RD-06, RD-07, or RD-08 suites.

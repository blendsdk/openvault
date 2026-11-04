# RD-09 Certificates Implementation Plan

> **Feature**: Certificate import, self-signed generation, immutable versions, public-chain/private-key separation, expiry warnings, and the RD-08 lifecycle.
> **Status**: Plan Preflighted
> **Created**: 2026-11-04 20:05
> **Implements**: openvault-v0-1/RD-09
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault already has the certificate tables, their append-only triggers, the v2 envelope
crypto with `objectType: "certificate"`, the policy matrix for the seven certificate actions,
the audit chain, the project lifecycle, the secret service patterns, and a dedicated purge
role. What is missing is the certificate product surface: no contract, route, repository,
service, PEM validator, generator, expiry job, or purge path exists. The published API
reference describes the routes; the schema already contains `certificates` and
`certificate_versions`.

This plan adds the data-plane certificate lifecycle. A certificate is a named object in a
project with immutable versions. A version holds the public leaf and intermediate chain as
text, the leaf metadata, and an AES-256-GCM envelope over the PKCS#8 private key. Import
validates PEM shape, key type, key match, dates, and every provided chain signature.
Generation creates a self-signed RSA or EC certificate with typed SANs. Public reads return
the chain; private reads require `certificate.read_private`, are audited, and are rate
limited. Import and generation are create-or-renew by name: an existing active name gets a
new immutable version. The lifecycle mirrors RD-08: soft delete, recovery, one-way purge
protection, retention, and guarded purge. A daily job records days-to-expiry and sends one
webhook warning per current version at the 30, 14, and 7-day thresholds, with a durable claim table
for idempotency.

RD-09 does not implement a CA, ACME, OCSP/CRL, HSM keys, the web UI, agent certificate
delivery, CLI commands, or backup/rotation. Those belong to RD-10 through RD-13.

## Minimum-Sufficient Baseline

**Original goal:** Store a certificate chain and its private key safely, generate a
self-signed certificate, separate public and private reads, warn before expiry, and reuse the
secret lifecycle.

**Smallest viable design:** Add strict contracts, one PEM/key/chain/generation module, one
certificate repository, one service (import/generate/read/list) plus a narrow lifecycle
service, one controller, one generalized purge class, one additive notification table, one
in-process daily scheduler, and one webhook sender. Reuse the existing schema, crypto, policy,
audit, project, rate-limit, and test patterns. Add no new dependency, queue, external cron, or
second datastore.

**Excluded machinery:** A generic X.509 framework, a CA/trust-store implementation, a
certificate cache, a job queue, a second scheduler, a UI, agent delivery, certificate
consumers, a versions-list route, and idempotency-key replay for import/generate. See AR-2,
AR-13, AR-16, AR-27, AR-28, and AR-31.

**Approved complexity:** One additive table and one in-process timer. The table is required
for durable per-threshold idempotency; the timer is the smallest way to run one daily job
without a deployment dependency. Both are recorded in AR-16, AR-18, and AR-30.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded quality audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-09 |
| 02 | [Current State](02-current-state.md) | Existing schema, crypto, policy, and gaps |
| 03-01 | [Contracts and PEM](03-01-contracts-pem.md) | Public contracts, PEM parsing, key match, chain validation |
| 03-02 | [Certificates](03-02-certificates.md) | Repository, import/generate, read/list, private read |
| 03-03 | [Lifecycle and Purge](03-03-lifecycle-purge.md) | Metadata, delete, recovery, protection, purge |
| 03-04 | [Expiry](03-04-expiry.md) | Notification table, scheduler, webhook, audit |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases and verification |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Import

```http
POST /v1/data/payments/certificates/import
{
  "name": "tls-server",
  "certificatePem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "chainPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "allowNotYetValid": false,
  "tags": { "owner": "payments" }
}
-> 201 {
     "id": "01J...", "name": "tls-server", "subject": "CN=...", "sans": ["DNS:..."],
     "issuer": "...", "serial": "...", "fingerprint": "...",
     "notBefore": "...", "notAfter": "...", "daysToExpiry": 364, "chainLength": 2,
     "version": { "id": "01J...", ... }, "certificatePem": "...", "chainPem": "...",
     "warnings": [], "capabilities": { ... }
   }
```

### Generate

```http
POST /v1/data/payments/certificates/generate
{ "name": "tls-server", "subject": "CN=payments.internal",
  "sans": ["DNS:payments.internal", "DNS:api.payments.internal"],
  "keyType": "ec-p256", "validityDays": 365 }
-> 201 { ...metadata..., "certificatePem": "...", "chainPem": "", "warnings": [] }
```

### Read

```http
GET /v1/data/payments/certificates/tls-server
-> 200 { ...metadata..., "certificatePem": "...", "chainPem": "..." }

GET /v1/data/payments/certificates/tls-server/private-key
-> 200 { "privateKeyPem": "-----BEGIN PRIVATE KEY-----...", "version": { ... },
          "fingerprint": "...", "name": "tls-server" }
```

### Lifecycle

```http
PATCH  /v1/data/payments/certificates/tls-server   { "purgeProtected": true }
DELETE /v1/data/payments/certificates/tls-server
POST   /v1/data/payments/certificates/tls-server/recover
POST   /v1/data/payments/certificates/tls-server/purge
```

### Expiry

```http
POST https://hooks.example.com/openvault
X-OpenVault-Timestamp: 2026-11-04T12:00:00.000Z
X-OpenVault-Signature: sha256=<hmac>
{
  "event": "certificate.expiry_warning",
  "eventId": "01J...:01J...:30",
  "certificateId": "01J...", "projectId": "01J...", "name": "tls-server",
  "versionId": "01J...", "fingerprint": "...", "notAfter": "...",
  "daysToExpiry": 30, "thresholdDays": 30, "occurredAt": "..."
}
```

## Key Decisions

| Decision | Outcome | AR Ref |
|---|---|---|
| Project selector | Data routes use the active project name | AR-1 |
| Create vs renew | Import/generate create or append a version by name; optional `expectedVersionId` precondition | AR-2 |
| Chain storage | One normalized `chain_pem`; leaf first | AR-3 |
| Response shapes | Metadata has no PEM; public read adds leaf/chain | AR-4 |
| Identifiers | Bare lowercase hex fingerprint, lowercase serial | AR-5 |
| PEM input | Strict labels, canonical base64, size bounds | AR-6 |
| Key material | PKCS#8, RSA 2048/3072 or EC P-256, SPKI match | AR-7 |
| Chain trust | Verify signatures with `signatureOnly`; warn on missing intermediate | AR-8 |
| Dates | Not-yet-valid gate; expired import warning | AR-9 |
| Generation | SHA-256 self-signed, notBefore backdated 30s, CA false, server+client auth | AR-10 |
| Version growth | 1,000 retained versions, then 409 | AR-11 |
| Name lifecycle | Reserved until purge; per-name advisory lock | AR-12 |
| Purge | Generalized `VaultPurger` over one pool | AR-13 |
| Protection | Same semantics as RD-08; PATCH enables it | AR-14, AR-15 |
| Expiry schedule | In-process daily job, disabled in tests | AR-16 |
| Thresholds | Current version; 30/14/7 nearest | AR-17 |
| Notification state | Additive table with leases and stable audit event ids | AR-18 |
| Webhook | Optional HTTPS, timestamped HMAC, stable event id, redacted URL | AR-19 |
| Webhook failure | Delete claim or reclaim a stale lease; at-least-once | AR-20 |
| Audit | One outcome per attempt; expiry business action | AR-21 |
| Private reads | `certificate.read_private` plus 30/min; writes 10/min | AR-22 |
| Expired reads | 410 unless `?version=` | AR-23 |
| Search | Subject, SAN, expiry window, name/id cursor | AR-24 |
| Envelope | v2 AAD with `objectType: "certificate"` | AR-25 |
| Config | Expiry hour/webhook; cert max clamped | AR-26 |
| Agent access | None in v0.1 | AR-27 |
| Idempotency | No key; `expectedVersionId` stale-write guard | AR-28 |
| Tests | Real X.509, crypto, PostgreSQL, webhook | AR-29 |
| Migration | Generated additive table | AR-30 |
| Version selector | `?version=` only | AR-31 |
| Specialist | None | AR-32 |
| Verification | Full repository gate plus PG16/PG17 | AR-33 |
| Derived values | `daysToExpiry` computed; `chainLength` counted | AR-34 |

## Cross-RD Acceptance Ownership

| Item | This plan | Remaining owner |
|---|---|---|
| RD-06 certificate actions and capabilities | Every certificate route authorizes the fixed action; metadata/write/read responses include flags | None |
| RD-07 audit of certificate operations | Import/generate/read/private/delete/recover/purge/expiry events | None |
| RD-08 lifecycle and envelope | Reuses retention, protection, purge, advisory locks, and v2 AAD | None |
| RD-10 agent delivery | No certificate route on the agent listener | RD-10 |
| RD-11 CLI | Contracts and stable errors ready for `ov cert` | RD-11 |
| RD-12 web UI | Project list items return `certificateCount` | RD-12 renders the count and CLI link |
| RD-13 backup/rotation | Certificate rows and keys are backed up; renewal is a new version | RD-13 |

## Specialist Agents

**None** — the repository's correctness and security/concurrency lenses cover X.509 parsing,
private-key handling, expiry delivery, and lifecycle.

_Detection evidence: `@peculiar/x509` is already a reviewed dependency used by the internal CA
(`apps/server/src/security/x509.ts:1-8`, `apps/server/src/security/ca.ts:287-288`); the
certificate tables and triggers already exist (`apps/server/src/database/schema.ts:344-409`);
the policy matrix and audit chain are established (`apps/server/src/rbac/roles.ts:44-150`,
`apps/server/src/audit/`). No repeated X.509 or key-handling rework exists._

## Related Files

| File | Change |
|---|---|
| `packages/api-contract/src/{certificates,projects}.ts` | Certificate contracts and the project list certificate count |
| `apps/server/src/projects/{repository,service}.ts`, `apps/server/src/controllers/projects.ts` | Project list certificate count |
| `packages/api-contract/src/index.ts` | Export the certificate contracts |
| `packages/api-contract/src/audit.ts` | Add `certificate.expiry_warning` |
| `apps/server/src/database/schema.ts` | Add `certificate_expiry_notifications` |
| `apps/server/migrations/` | Generated additive migration and snapshot |
| `apps/server/src/database/{generated-types,ctypes}.ts` | Regenerated row and CType types |
| `apps/server/src/certificates/{pem,generate,envelope,repository,service,lifecycle,errors,rate-limits,runtime}.ts` | Certificate parsing, generation, envelopes, persistence, reads, lifecycle, and limiters |
| `apps/server/src/certificates/expiry/{repository,scheduler,webhook,service}.ts` | Daily expiry scan, durable claims, webhook delivery |
| `apps/server/src/purge/{vault-purger,errors}.ts` | Generalized dedicated purger and stable error type |
| `apps/server/src/secrets/{runtime,service}.ts` | Use the generalized purger |
| `apps/server/src/controllers/certificates.ts` | Certificate routes |
| `apps/server/src/audit/actions.ts` | Certificate policy and expiry-warning detail allowlists |
| `apps/server/src/observability/logger.ts` | Request-body private-key redaction |
| `apps/server/src/config/{types,loader,redact}.ts` | Expiry settings and the cert size clamp |
| `apps/server/src/app.ts` | Wire the certificate runtime, scheduler, and purger |
| `apps/server/src/transport/secure-application.ts` | `disableBackgroundJobs` dependency |
| `apps/server/tests/integration/helpers/{certificate-fixtures,purger,webhook}.ts` | Real X.509 and webhook fixtures |
| `apps/server/tests/integration/certificates*.test.ts` | Specification and implementation tests |
| `packages/api-contract/tests/certificates.*.test.ts` | Contract tests |
| `docs/reference/api.md` | Certificate examples and PATCH route |
| `docs/guide/certificates.md` | Implemented behavior, expiry, webhook, private keys |
| `docs/guide/audit.md` | `certificate.expiry_warning` |
| `docs/reference/configuration.md` | Expiry settings and the cert size clamp |
| `docs/architecture/crypto.md` | Certificate private-key envelope |
| `docs/security/limitations.md` | Chain trust, webhook, private-key memory, no idempotency |
| `docs/changelog.md`, `.changeset/certificates.md` | Release note |

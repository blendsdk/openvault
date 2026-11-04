# Requirements: RD-09 Certificates

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-09](../../requirements/RD-09-certificates.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan
- RD-09 certificate import of a PEM leaf, optional intermediates, and a PKCS#8 private key.
- Key/type/match validation and chain-signature validation.
- RD-09 self-signed generation for RSA 2048/3072 and EC P-256 with subject and SANs.
- Immutable versions, create-or-renew semantics, and a 1,000-version safety bound.
- Public metadata, public-chain reads, and separated private-key reads.
- `certificate.read` vs `certificate.read_private`, per-object capabilities, and audit.
- RD-09 soft delete, recovery, one-way purge protection, retention, and guarded purge.
- A daily expiry scan with durable per-threshold claims and an optional webhook.
- Certificate search by subject, SAN, and expiry window.
- A certificate count on project list items for RD-12.
- The additive notification table and generated migration/types.

### Deferred / out of this plan
- RD-09 Won't Have: public CA issuance, ACME, DNS/HTTP challenges, HSM keys,
  non-exportable keys, a certificate UI, a rotation wizard, and OCSP/CRL serving.
- RD-10 agent delivery of certificate files. v0.1 agent delivery is secrets only.
- RD-11 `ov cert` CLI implementation.
- RD-12 certificate UI.
- RD-13 backup, KEK rotation, production role provisioning, and operational runbooks.
- Certificate consumers and a versions-list route (AR-31).

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Project selector | Active project name in `/v1/data/:project` | AR-1 |
| Create vs renew | Import/generate create or append a version; `expectedVersionId` guard | AR-2 |
| Chain storage | Normalized leaf + intermediates in `chain_pem` | AR-3 |
| Metadata vs public read | Metadata has no PEM; public read adds leaf/chain | AR-4 |
| Key rules | PKCS#8, RSA 2048/3072, EC P-256, SPKI match | AR-6, AR-7 |
| Chain trust | Verify signatures with `signatureOnly`; warn on missing intermediate | AR-8 |
| Dates | Not-yet-valid gate; expired import warning | AR-9 |
| Generation | SHA-256 self-signed, CA false, server+client auth | AR-10 |
| Version growth | 1,000 retained versions | AR-11 |
| Names | Reserved until purge; per-name lock | AR-12 |
| Purge | Generalized `VaultPurger` | AR-13 |
| Protection | RD-08 semantics; PATCH enables it | AR-14, AR-15 |
| Expiry job | In-process daily scheduler; disabled in tests | AR-16 |
| Thresholds | Current version; 30/14/7 nearest | AR-17 |
| Notification state | New additive table with a one-hour lease | AR-18 |
| Webhook | Optional HTTPS, HMAC, stable event id | AR-19, AR-20 |
| Audit | One outcome; `certificate.expiry_warning` | AR-21 |
| Private reads | `certificate.read_private`, 30/min; writes 10/min | AR-22 |
| Expired reads | 410 unless `?version=` | AR-23 |
| Search | Subject, SAN, expiry window, cursor | AR-24 |
| Envelope | v2 AAD with `objectType: "certificate"` | AR-25 |
| Config | Expiry hour/webhook; cert max 131,072 | AR-26 |
| Agent access | None in v0.1 | AR-27 |
| Idempotency | No key; optional `expectedVersionId` precondition | AR-28 |
| Tests | Real X.509, crypto, PostgreSQL, webhook | AR-29 |
| Migration | Generated additive table | AR-30 |
| Version selector | `?version=` only | AR-31 |
| Verification | `pnpm verify`, type/db/changeset/docs, PG16+17 | AR-33 |
| Project list count | `certificateCount` on list items only | AR-35 |

## Acceptance Criteria

The RD owns its acceptance criteria. This plan adds these executable criteria:

1. Every RD-09 acceptance criterion is covered by at least one specification test in
   [07-testing-strategy.md](07-testing-strategy.md), except role provisioning owned by RD-13.
2. `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, the docs build, and the
   integration suite pass on PostgreSQL 16 and 17 before the plan is marked done.
3. No private key, PEM body, or key material appears in metadata, lists, audit events, logs,
   errors, or the expiry webhook.
4. A certificate private-key envelope moved into a secret row fails authentication.
5. A certificate request on the agent listener is denied: a same-project agent receives 401, a project-mismatched certificate is rejected 403 by the existing agent guard, and no certificate data is returned.
6. Certificate import/generate/renew writes no allow event when the transaction rolls back,
   and a read writes no value when its evidence write fails.
7. Expiry warnings fire at most once per `(version, threshold)` in normal operation, and a
   failed delivery is retried on the next run.
8. A soft-deleted certificate hides from reads, lists, private reads, and expiry scans but
   remains purgeable; a soft-deleted project hides its certificates from those surfaces and
   from purge.
9. Project list items include the active certificate count.

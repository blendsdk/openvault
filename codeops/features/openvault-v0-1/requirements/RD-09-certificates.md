# RD-09: Certificates

> **Document**: RD-09-certificates.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-08
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines certificate storage: importing a PEM chain and private key, generating
self-signed certificates, exposing public metadata, separating public-chain and private-key
access, tracking expiry, and mirroring the secret lifecycle. v0.1 is not a certificate
authority; it does not issue publicly trusted certificates, run ACME, or provide a
certificate UI.

## Functional Requirements

### Must Have

- [ ] `POST /v1/data/:project/certificates/import` accepts a PEM chain and a PKCS#8 private
  key.
- [ ] Import validates that the certificate public key matches the private key; mismatch
  returns 422.
- [ ] Import supports RSA and EC keys and an optional intermediate chain.
- [ ] Import rejects not-yet-valid certificates unless `allowNotYetValid` is true; expired
  certificates import with a warning.
- [ ] `POST /v1/data/:project/certificates/generate` creates a self-signed certificate with
  RSA 2048/3072 or EC P-256, a configurable subject, and SANs.
- [ ] Metadata includes subject, SANs, issuer, serial, SHA-256 fingerprint, not-before,
  not-after, chain length, and version.
- [ ] `certificate.read` returns the public chain only.
- [ ] `certificate.read_private` returns the private key, is audited as a sensitive read, and
  is never included in metadata or list responses.
- [ ] Import, generation, and renewal create immutable versions.
- [ ] A daily job records days-to-expiry and calls a configured webhook once at 30, 14, and 7
  days.
- [ ] Certificates support soft delete, recovery, opt-in purge protection, and purge.
- [ ] Certificate private keys use the same envelope encryption with
  `objectType=certificate`.
- [ ] v0.1 exposes certificates through API and CLI only; the UI shows a count and CLI link.

### Should Have

- [ ] Chain validation reports a missing intermediate without rejecting a valid leaf.
- [ ] Certificate search by subject, SAN, and expiry window.

### Won't Have (Out of Scope)

- Public CA issuance, ACME, or DNS-01/HTTP-01 challenges.
- HSM-backed keys or non-exportable private keys.
- Certificate UI and rotation wizard (v0.2).
- OCSP/CRL serving.

## Technical Requirements

### Import payload

```json
{
  "certificatePem": "-----BEGIN CERTIFICATE-----...",
  "chainPem": "-----BEGIN CERTIFICATE-----...",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----...",
  "allowNotYetValid": false,
  "tags": { "owner": "payments" }
}
```

Validation:

1. Parse exactly one leaf certificate and zero or more chain certificates.
2. Parse a PKCS#8 private key.
3. Compare the leaf public key with the private key.
4. Reject key types other than RSA 2048/3072 and EC P-256.
5. Reject a chain whose signatures do not verify.
6. Store the chain as text; encrypt the private key with a fresh DEK.

### Generation

- RSA 2048 or 3072, or EC P-256.
- Subject and SANs required for non-empty generation.
- Validity default 365 days, maximum 825 days.
- Self-signed with SHA-256.
- Private key encrypted; only the public certificate is returned.

### Lifecycle

- Same soft-delete and purge-protection semantics as RD-08.
- A certificate version stores `notBefore` and `notAfter`; reads return 410
  `certificate_expired` for expired versions unless explicitly requested.
- Expiry job runs daily at a configured hour and is idempotent per threshold.

## Integration Points

- RD-06 enforces certificate actions and object scope.
- RD-07 audits import, generate, public read, private read, delete, recover, purge, and expiry
  warnings.
- RD-08 supplies the lifecycle and envelope patterns.
- RD-10 may deliver certificate files to agents in a later phase; v0.1 agent delivery is
  secrets only.
- RD-11 exposes CLI commands.
- RD-13 backs up certificate rows and keys.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| CA | Internal CA / ACME / import only | Import + self-signed | Smallest useful v0.1 | AR-25 |
| Private key read | Same as public / separate action | `certificate.read_private` | Least privilege and audit | AR-25 |
| UI | v0.1 / v0.2 | v0.2 | Scope control | AR-24 |
| Key types | RSA/EC / any | RSA 2048/3072, EC P-256 | Predictable support | AR-25 |
| Expiry alerts | None / webhook | Webhook at 30/14/7 | Operational safety | AR-25 |

## Security Considerations

- **Data sensitivity:** certificate private keys are highest sensitivity; chains are public.
- **Input validation:** PEM size limits, key type, signature chain, dates, SAN syntax.
- **Authentication & authorization:** `certificate.read` vs `certificate.read_private`;
  project scope.
- **Injection risks:** X.509 parser is a vetted library; no shell; no PEM in logs.
- **Encryption needs:** private key envelope with object-type AAD; TLS.
- **Rate limiting:** import/generate are admin actions; private reads are audited and rate
  limited.
- **Infrastructure:** private keys never written to disk in plaintext outside the encrypted
  DB row; no private key in list responses.

## Acceptance Criteria

1. [ ] A valid RSA or EC certificate and matching PKCS#8 key import successfully.
2. [ ] A mismatched key returns 422 and writes no certificate row.
3. [ ] A not-yet-valid certificate is rejected without `allowNotYetValid`; with it, import
   succeeds with a warning.
4. [ ] A generated self-signed certificate verifies against its own public key and has the
   requested SANs.
5. [ ] Metadata contains no private key and no PEM body.
6. [ ] `certificate.read` succeeds without `certificate.read_private`; the private-key route
   returns 403 without it.
7. [ ] A private-key read creates a `certificate.read_private` audit event with no key
   material.
8. [ ] Moving a certificate private-key envelope into a secret row fails authentication.
9. [ ] The expiry job fires 30/14/7-day warnings once per threshold.
10. [ ] Soft delete, recovery, purge protection, and purge behave like RD-08.
11. [ ] Security requirements verified: key match, private-key isolation, AAD domain
    separation, audit.

# RD-05: Service Identities and mTLS

> **Document**: RD-05-service-identities-mtls.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-02, RD-03
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines non-human principals, one-time join tokens, the internal certificate
authority, agent client certificates, renewal, revocation, and consumer registration. It
replaces static API keys with short-lived mTLS credentials.

## Functional Requirements

### Must Have

- [ ] A service identity is a principal with no password, owned by exactly one OpenVault
  project.
- [ ] Only org administrators and the owning project's administrators can create, read, or
  revoke a service identity.
- [ ] A join token is 32 random bytes, shown once, stored hashed, single use, bound to the
  service identity and project, and expires after 15 minutes by default (max 24 hours).
- [ ] `POST /v1/agent/join` accepts a join token, a PKCS#10 CSR, and consumer metadata.
- [ ] The CSR public key must be EC P-256; the subject CN is the principal id; the SAN URI is
  `openvault://identity/<id>`.
- [ ] The server signs a 30-day certificate with the internal CA and stores only serial and
  fingerprint.
- [ ] `POST /v1/agent/renew` requires the current certificate and is allowed after two thirds
  of the lifetime.
- [ ] Revocation is immediate: the next connection fails within 5 seconds.
- [ ] The agent listener verifies the chain against the internal CA, fingerprint, expiry, and
  revocation.
- [ ] The internal CA is EC P-256, self-signed, 10-year lifetime, generated at init, and
  stored encrypted under the KEK.
- [ ] Consumer metadata is bound to the authenticated service identity and stored in
  `consumers`.
- [ ] Join and renew are rate limited.

### Should Have

- [ ] `GET /v1/admin/identities/:id` includes certificate serial, expiry, and last seen
  consumer metadata.
- [ ] Bulk revocation of all certificates for a disabled identity.

### Won't Have (Out of Scope)

- Static API keys or client secrets for workloads.
- OIDC client-credentials for workloads.
- Cross-host certificate federation or external mTLS CAs.

## Technical Requirements

### Identity and ownership

- `principals.kind = 'service'` requires `owner_project_id`.
- A service identity cannot be granted control-plane actions (enforced in RD-06).
- A project administrator can manage only identities owned by that project.
- An org administrator can manage every identity.

### Join sequence

```text
operator -> POST /v1/admin/identities/:id/join-tokens
server   -> returns token once, stores hash + expiry
agent    -> generates EC P-256 key + CSR + consumer metadata
agent    -> POST /v1/agent/join { token, csr, consumer }
server   -> validates token, signs cert, stores serial/fingerprint, marks token used
agent    -> stores cert + key mode 0600, connects with mTLS
```

### Certificate profile

| Field | Value |
|---|---|
| Key | EC P-256 |
| Signature | ECDSA-SHA256 |
| Validity | 30 days |
| Subject | CN = principal id |
| SAN | `openvault://identity/<principal id>` |
| Renewal | after 20 days (two thirds) |
| Revocation | database row + 5-second cache |

### Consumer metadata

```json
{
  "composeProject": "payments",
  "composeService": "api",
  "hostname": "b7c1...",
  "manifestHash": "sha256:..."
}
```

The server stores one consumer row per service identity and updates `last_seen` on renew or
refresh. The agent cannot change its principal or project through this metadata.

## Integration Points

- RD-02 provides the agent listener and internal CA path.
- RD-03 supplies admin authentication and project scoping.
- RD-06 enforces the service-identity action ceiling.
- RD-07 audits join, renew, revoke, and consumer changes.
- RD-10 uses the certificate for fetch and refresh.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Workload auth | Static key / mTLS / OIDC | mTLS + join token | Short-lived and revocable | AR-6 |
| Certificate lifetime | 7 / 30 / 90 days | 30 days | Balance rotation and availability | AR-6 |
| CA | Public CA / internal CA / HSM | Internal EC P-256 CA | Self-hosted, no external dependency | AR-6 |
| Join token TTL | 5 / 15 / 60 minutes | 15 minutes | Short exposure | AR-14 |
| Project ownership | Global / project-owned | Project-owned | Prevents cross-project identity abuse | AR-16 |
| Renewal | Manual / automatic | Automatic after two thirds | Avoid expiry outages | AR-6 |

## Security Considerations

- **Data sensitivity:** private keys, join tokens, certificate fingerprints.
- **Input validation:** token format, CSR key type, subject/SAN, metadata length.
- **Authentication & authorization:** join token is the only unauthenticated credential;
  renew requires mTLS; admin routes require RBAC.
- **Injection risks:** CSR parsing via a vetted library; no shell.
- **Encryption needs:** CA key wrapped by KEK; private keys never returned; TLS/mTLS.
- **Rate limiting:** join 10/min per IP; renew per certificate.
- **Infrastructure:** agent state volume mode `0600`; no Docker socket.

## Acceptance Criteria

1. [ ] Creating a service identity without an owner project fails with 422.
2. [ ] A join token is returned once, stored hashed, and fails on a second exchange.
3. [ ] An expired or wrong-project join token fails with 401 and is audited.
4. [ ] A valid CSR returns a certificate with the expected CN, SAN, 30-day validity, and
   internal CA signature.
5. [ ] A non-P-256 CSR is rejected with 422.
6. [ ] The agent listener rejects a missing, expired, revoked, self-signed, or wrong-CA
   certificate.
7. [ ] Revocation causes the next mTLS connection to fail within 5 seconds.
8. [ ] Renewal before two thirds of lifetime is rejected; after two thirds it succeeds and
   does not invalidate the old certificate until it expires.
9. [ ] Consumer metadata is stored once per identity and updated on renew/refresh.
10. [ ] A project administrator cannot create or revoke an identity owned by another project.
11. [ ] A service identity cannot be granted a control-plane action.
12. [ ] Security requirements verified: token hashing, CSR validation, revocation, CA key
    protection.

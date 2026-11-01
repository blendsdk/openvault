# RD-05: Service Identities and mTLS

> **Document**: RD-05-service-identities-mtls.md
> **Status**: Preflighted
> **Created**: 2026-10-29
> **Preflight**: [00-preflight-report-RD-05.md](00-preflight-report-RD-05.md) — passed after re-scan
> **Project**: OpenVault
> **Depends On**: RD-02, RD-03
> **Initialization Prerequisite**: RD-11/RD-13 provide CA generation and backup/rotation
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines non-human principals, single-use join tokens, the internal certificate
authority, agent client certificates, renewal, revocation, and consumer registration. It
replaces static API keys with short-lived mTLS credentials.

The server owns service-identity metadata, join-token consumption, certificate issuance, and
the authorization check on every agent request. The agent runtime, certificate/key storage,
renewal scheduling, and consumer refresh belong to RD-10. The full RBAC evaluator belongs to
RD-06; RD-05 uses a narrow identity-authorization helper until that evaluator lands. RD-07 owns
the persisted audit chain; RD-07 records the events RD-05 generates.

## Functional Requirements

### Must Have

- [ ] A service identity is a principal with no password, no local credential, no OIDC
  identity, and no browser or CLI session, owned by exactly one OpenVault project.
- [ ] Administrators can create, read, list, revoke, and issue join tokens for service
  identities through the admin API.
- [ ] `identity.create`, `identity.revoke`, and `identity.join_token` are limited to
  `org.admin` or `project.admin` at org or project scope; a project-scoped assignment covers
  only owned identities. `identity.read` also allows `auditor` at org or project scope.
- [ ] A join token is 32 random bytes encoded as 43-character base64url, shown once, stored as
  a SHA-256 hash, single use, bound to the service identity and project, and expires after 15
  minutes by default (maximum 24 hours).
- [ ] `POST /v1/agent/join` accepts a join token, a PKCS#10 CSR, and consumer metadata and
  returns the issued certificate.
- [ ] The agent listener permits only `POST /v1/agent/join` without a verified client
  certificate. Every other agent route requires a verified certificate from the internal CA,
  a live `workload_certs` row, an active principal, and an active project.
- [ ] The server derives the certificate subject and identity from the token, not from the
  CSR. The CSR proves possession of an EC P-256 key; requested subject, SANs, and extensions
  are not copied into the issued certificate.
- [ ] The issued certificate has CN = principal id, exactly one SAN URI
  `openvault://identity/<id>`, `CA:FALSE`, `digitalSignature`, and `clientAuth` usage.
- [ ] The server signs a certificate with the internal CA and stores its principal, serial,
  SHA-256 fingerprint, validity, and revocation state. It never stores or returns the agent
  private key.
- [ ] `POST /v1/agent/renew` requires the current certificate and a fresh CSR, and is allowed
  after two thirds of the issued lifetime.
- [ ] Only the newest unexpired, unrevoked certificate for an identity may renew. Older
  certificates remain valid for data until expiry but cannot renew.
- [ ] Revocation is atomic: disabling an identity revokes every unexpired certificate and
  every unused join token in one transaction. No request on a revoked identity succeeds more
  than 5 seconds after the revocation commits.
- [ ] The agent listener verifies the chain against the internal CA, expiry, fingerprint,
  revocation state, principal status, and project status on every request.
- [ ] The internal CA is EC P-256, self-signed, valid for 10 years, with `CA:TRUE`,
  `pathlen:0`, and `keyCertSign`. The CA private key is wrapped by the current KEK and is
  loaded only through a CA signer.
- [ ] Consumer metadata is bound to the authenticated service identity and stored in
  `consumers`.
- [ ] Join and renew are rate limited.
- [ ] Join tokens and workload certificates have bounded retention and cleanup.

### Should Have

- [ ] `GET /v1/admin/identities/:id` returns the identity, all active certificates, and its
  consumer metadata.
- [ ] An agent can retry a renewal after a lost response without creating a second
  certificate when it reuses the same public key inside a short replay window.

### Won't Have (Out of Scope)

- Static API keys or client secrets for workloads.
- OIDC client-credentials for workloads.
- Cross-host certificate federation or external mTLS CAs.
- Per-certificate revocation or identity re-enable in v0.1. Identity revoke revokes all
  credentials; a re-enabled service requires a new join.
- Agent certificate/key storage, tmpfs delivery, and the refresh loop; RD-10 owns them.

## Technical Requirements

### Identity and ownership

- `principals.kind = 'service'` requires `owner_project_id`; `kind = 'user'` forbids it.
- A service identity cannot hold a local credential, an OIDC identity, or a CLI session.
  The identity-creation path and every login/link path reject a service principal.
- A project-scoped `project.admin` can manage only identities owned by that project. An
  org-scoped `project.admin` or `org.admin` can manage every identity. An auditor with
  `identity.read` can read identity metadata but cannot create, revoke, or issue a token.
- Active service-identity names are unique within a project:
  `UNIQUE (owner_project_id, name) WHERE kind = 'service' AND status = 'active'`.
  A revoked name may be reused. The scaffold treats a name conflict as a request to re-read
  and reuse the active identity.

### Authorization

RD-05 uses a narrow identity-authorization helper backed by the existing
`role_assignments` table and the action names defined by RD-06. It checks:

1. the caller's principal status is active;
2. the action is one of `identity.create`, `identity.read`, `identity.revoke`, or
   `identity.join_token`;
3. an org-scoped assignment for an org-eligible role (`org.admin`, `project.admin`, or
   `auditor`) covers every identity; a project-scoped assignment covers only identities whose
   `owner_project_id` matches the assignment's project scope; and
4. `identity.read` also accepts an `auditor` assignment at the applicable scope.

RD-06 replaces the helper with the full evaluator without changing the admin API. RD-06 owns
the control-plane ceiling for service identities; RD-05 does not grant a control-plane role.

### Admin API

All admin routes use the WebAFX envelope and a strict request schema. Unknown fields are
rejected with `400 validation_error`. The caller must be authenticated with a browser session
or a CLI bearer; the browser cookie is never accepted on the agent listener.

```text
POST /v1/admin/identities
{ "name": "payments-api", "projectId": "01J..." }
-> 201 { "id", "name", "projectId", "status", "createdAt" }

GET /v1/admin/identities?projectId=01J...
-> 200 { "identities": [ { "id", "name", "projectId", "status", "createdAt" } ] }

GET /v1/admin/identities/:id
-> 200 {
     "id", "name", "projectId", "status", "createdAt",
     "certificates": [ { "serial", "fingerprint", "notBefore", "notAfter", "revokedAt" } ],
     "consumer": { "composeProject", "composeService", "hostname", "manifestHash",
                   "state", "firstSeen", "lastSeen", "selfReported": true } | null
   }

POST /v1/admin/identities/:id/revoke
-> 204

POST /v1/admin/identities/:id/join-tokens
{ "ttlSeconds": 900 }
-> 201 { "id", "token", "expiresAt" }
```

- The token is returned once and is never returned by a read route.
- `ttlSeconds` is optional; the default is `OPENVAULT_JOIN_TOKEN_TTL` (15 minutes) and the
  maximum is 24 hours.
- `POST /:id/revoke` is idempotent: a second successful call returns 204.
- `GET /:id` returns 404 `identity_not_found` for an unknown or foreign identity.
- A missing owner project on create returns 422 `validation_error`.
- A duplicate active name returns 409 `identity_name_conflict`.
- The create path does not grant a data-plane role. RD-10's scaffold grants an object-scope
  `secrets.reader` assignment for each manifest entry, or prints the exact `ov role grant`
  command; it does not grant project-wide reader access.

### Join token

- Generate 32 random bytes and encode them as base64url without padding (43 characters).
- Store `SHA-256(token)` as 32 bytes in `join_tokens.token_hash`; never store or log the raw
  token.
- The token row carries `principal_id`, `project_id`, `created_by`, `expires_at`, `used_at`,
  and `revoked_at`.
- Token issuance and join require an active principal and an active project.
- Consume the token with one conditional update inside the issuance transaction:
  `UPDATE join_tokens SET used_at = now() WHERE token_hash = :hash AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING ...`.
- A second sequential or concurrent exchange returns 401 `join_failed` and issues no
  certificate.
- The join transaction locks the token's principal `FOR UPDATE`, rechecks principal and
  project state, then claims the token. Revoke uses the same principal-then-token lock order,
  so a join cannot insert an unrevoked certificate after a revoke commits.
- An identity revoke sets `revoked_at` on every unused token for that identity.
- The join request validates the CSR before claiming the token, so a malformed CSR does not
  burn a valid token.

### Join sequence

```text
operator -> POST /v1/admin/identities/:id/join-tokens
server   -> returns token once, stores hash + expiry
agent    -> generates EC P-256 key + CSR + consumer metadata
agent    -> POST /v1/agent/join { token, csr, consumer }
server   -> validates CSR shape and proof of possession
server   -> locks principal, rechecks active status/project
server   -> claims token, builds fixed profile from token identity
server   -> signs cert, inserts workload_certs + consumers row in one transaction
agent    -> stores cert + key, connects with mTLS
```

- The join listener path is the only unauthenticated agent path. It is still HTTPS and
  rate-limited.
- The join response returns the leaf certificate PEM, the CA chain PEM, the assigned
  identity id, serial, and `notAfter`. It never returns a private key.
- A failed join returns 401 `join_failed` for an unknown, expired, used, or revoked token or
  when the principal or project is inactive, and 422 `validation_error` for a malformed or
  unacceptable CSR. Error bodies never contain
  a token, token hash, CSR body, or key material.

### Agent API

```text
POST /v1/agent/join
{ "token": "<43-character base64url>", "csr": "<PEM PKCS#10>",
  "consumer": { "composeProject", "composeService", "hostname", "manifestHash" } }
-> 200 { "certificatePem", "chainPem", "identityId", "serial", "notAfter" }

POST /v1/agent/renew
{ "csr": "<PEM PKCS#10>", "consumer": { ... } }
-> 200 { "certificatePem", "chainPem", "identityId", "serial", "notAfter" }
```

Join is the only agent route without a client certificate; it is token-authenticated and
limited to 10 requests per minute per source IP. Renew requires the current certificate;
it is limited to 10 requests per minute per principal and 60 per minute per source IP. Both
return the fixed profile described below and never return a private key.

The agent data-plane fetch uses the existing
`GET /v1/data/:project/secrets/:name` route on the agent listener. The certificate
principal's `owner_project_id` must equal the id of the project named by `:project`; the
request cannot select another project. A successful fetch updates `consumers.last_seen` and
an allowlisted `state`. RD-08 owns the secret handler; RD-10 documents the fetch/refresh
contract.

### Certificate profile

| Field | Value |
|---|---|
| Key | EC P-256 |
| Signature | ECDSA-SHA256 |
| Validity | `OPENVAULT_CERT_TTL_DAYS` (default 30, range 1–90) |
| Subject | CN = principal id |
| SAN | exactly one URI: `openvault://identity/<principal id>` |
| Basic constraints | `CA:FALSE`, critical |
| Key usage | `digitalSignature` |
| Extended key usage | `clientAuth` |
| Serial | random 128-bit value, 1–128 characters |
| Fingerprint | SHA-256 over the DER certificate, lowercase hex |
| Renewal | after two thirds of the issued `not_before`/`not_after` window |
| Revocation | `workload_certs.revoked_at` checked on every request |

The server builds the profile; it does not copy CSR subject, SAN, basic constraints, key
usage, extended key usage, or unknown critical extensions. The CSR parser must enforce
resource limits and verify the self-signature.

### Internal CA and signing key

- The CA certificate is EC P-256, self-signed, valid for 10 years, `CA:TRUE`, `pathlen:0`,
  and `keyCertSign`.
- The CA private key is a 32-byte P-256 scalar wrapped by the current KEK. It is stored in a
  dedicated `ca_keys` table with `id`, `cert_pem`, `public_key`, `wrapped_key`, `wrap_nonce`,
  `wrap_tag`, `kek_id`, `status`, and timestamps. The raw key is never returned, logged, or
  written outside the wrapped column.
- `ov init` (RD-11/RD-13) generates the CA once and writes the public certificate to
  `OPENVAULT_INTERNAL_CA`. Re-running init must not rotate the CA. RD-05 acceptance uses a
  test CA fixture; production provisioning is an initialization prerequisite.
- A `CaSigner` service is the only component allowed to unwrap and use the CA key for
  signing. It verifies that the key matches `OPENVAULT_INTERNAL_CA` and exposes a sign
  operation, never the key. The KEK-rotation path may unwrap the CA key only to re-wrap it;
  that path is not a general signing path.
- Startup and `/ready` fail closed if the CA row is missing, the KEK cannot unwrap it, or the
  key does not match the public certificate. Readiness also signs a short test certificate and
  verifies it against `OPENVAULT_INTERNAL_CA`; it does not require a live agent. The TLS
  listener must not bind before this check.
- RD-13 includes `ca_keys` in KEK rotation, encrypted backup, restore, and restore
  verification. Restore re-materializes `OPENVAULT_INTERNAL_CA` from the restored CA row and
  verifies a pre-backup agent certificate still chains to it.

### Agent listener authentication

The agent listener uses HTTPS with `requestCert: true`. Because the join route must work
before an agent has a certificate, the listener uses `rejectUnauthorized: false` and a
default-deny application middleware:

- `POST /v1/agent/join` is allowed without a client certificate and is authenticated by the
  join token.
- Every other `/v1/agent/*` request requires `socket.authorized === true`, a leaf certificate
  chained to `OPENVAULT_INTERNAL_CA`, an unexpired certificate, a `workload_certs` row matching
  the SHA-256 fingerprint, `revoked_at IS NULL`, an active principal, and an active project.
- The agent data-plane fetch uses `GET /v1/data/:project/secrets/:name` on the same listener.
  It is subject to the same certificate checks and to the owner-project comparison.
- The middleware runs before routing and rejects everything else with 401
  `authentication_required`; a database or cache failure returns 503 and never falls open.
- The agent listener disables TLS session resumption. Certificate state is cached for at most
  5 seconds per fingerprint and the cache entry is invalidated when the certificate or
  identity is revoked.
- The agent request path checks the same state on every request, not only at the TLS
  handshake, so an existing keep-alive connection cannot outlive a revocation.
- The agent runtime maps 401/403 and certificate-rejection failures to “remove files and
  exit,” not to the transient/5xx retry path. RD-10 owns that behavior.

### Revocation

- `POST /v1/admin/identities/:id/revoke` runs one transaction that locks the principal row
  first, then:
  1. set `principals.status = 'disabled'` and `disabled_at = now()`;
  2. set `workload_certs.revoked_at = now()` for every unexpired, unrevoked certificate;
  3. set `join_tokens.revoked_at = now()` for every unused token; and
  4. mark the consumer row `failed` if present.
- Every agent request and renew checks the current principal and project state. A disabled
  identity cannot renew.
- The observable guarantee is: no request succeeds more than 5 seconds after the revocation
  transaction commits, including requests on an already-open connection. New and reused
  connections are both tested.
- Secrets already delivered to a container cannot be retracted by the server. Operators must
  rotate those values.

### Renewal

- The current certificate is the newest unexpired, unrevoked `workload_certs` row for the
  principal (newest `issued_at`, tie-break by id). Only that certificate may renew.
- Renewal requires a fresh CSR with a new EC P-256 key and proof of possession. The existing
  certificate authenticates the request over mTLS.
- The request is rejected with 409 `renewal_not_due` before two thirds of the certificate's
  actual `not_before`/`not_after` window. Use the certificate's dates, not a hardcoded 20
  days.
- Before the newest-only check, look up a process-local replay cache keyed by
  `(principal_id, SHA-256(CSR public key))` with a 5-minute window. A hit returns the cached
  certificate response, even when the authenticating certificate is the old one. The cache is
  populated on issuance. A server restart loses it; the agent must then re-join, which is a
  documented v0.1 limitation.
- A successful renewal issues a new certificate with the configured lifetime; the old
  certificate remains valid for data until `not_after` but cannot renew again.
- A retry that presents the same public key inside the replay window returns the same
  certificate instead of issuing another. A lost response therefore does not require a new
  join.
- An expired certificate cannot renew. The agent must obtain a new join token and re-join; a
  second join updates the existing consumer row.
- RD-10 owns the agent's two-thirds trigger, jitter, retry/backoff, and atomic certificate/key
  swap. RD-05 owns the server-side window, profile, and replay rule.

### Consumer metadata

```json
{
  "composeProject": "payments",
  "composeService": "api",
  "hostname": "b7c1...",
  "manifestHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

- The server sets `principal_id` and `project_id` from the token; the request cannot change
  them.
- Compose project and service are 1–100 characters; hostname matches
  `^[A-Za-z0-9._-]{1,255}$`; manifest hash matches `^sha256:[0-9a-f]{64}$`.
- Unknown fields and invalid values return 422.
- One consumer row exists per service identity. Join inserts or updates it, preserves
  `first_seen`, replaces metadata and `last_seen`, and sets `state = 'ok'`.
- Renew updates `last_seen` and the submitted metadata and leaves `state = 'ok'`. RD-10's
  agent data-plane fetch updates `last_seen` and `state`; RD-05 does not define a separate
  refresh route. The fetch sets `ok` on success and `degraded` or `failed` on its own result.
- Consumer metadata is self-reported. It is displayed as self-reported and is never used for
  authorization or as a verified manifest-integrity claim.
- RD-07 records metadata changes; a `last_seen` heartbeat alone is not an audit event.

### Rate limits

| Route | Limit | Key | Response |
|---|---|---|---|
| Join | 10/minute | source IP on the agent listener | 429 `RATE_LIMIT_EXCEEDED` |
| Renew | 10/minute | principal id | 429 `RATE_LIMIT_EXCEEDED` |
| Renew | 60/minute | source IP on the agent listener | 429 `RATE_LIMIT_EXCEEDED` |

The join limiter runs before expensive CSR work. The renew principal bucket does not reset
when the certificate is rotated. The counters are process-local in v0.1 and reset on restart;
this limitation is documented.

### Retention and cleanup

- Join tokens are retained for 24 hours after `expires_at` or `used_at`, whichever is later,
  then deleted. Revoked unused tokens are retained for the same window.
- Workload certificates are retained until 30 days after `not_after`. A revoked certificate
  is retained until the later of `not_after + 30 days` and `revoked_at + 30 days`.
- A daily bounded cleanup deletes eligible rows. Add indexes on `join_tokens.expires_at` and
  `workload_certs.not_after` for the cleanup predicate.
- A cleanup failure is logged and must not disable authentication or fail startup.

### Logging and redaction

- Join tokens and token hashes never appear in request logs, access logs, error bodies, audit
  details, or diagnostics.
- CSR bodies and private keys are never logged. The logger redacts `token`, `joinToken`,
  `req.body.token`, and related bearer fields; handlers never log entire request bodies.
- A captured-log integration test sends valid, expired, used, malformed-CSR, and revoked
  join/renew requests with sentinel values and asserts that no sentinel, token hash, or key
  material appears in the logs or error envelopes.
- Error bodies contain only stable codes and messages.

### Schema additions

- `ca_keys` as described above.
- `join_tokens.revoked_at timestamptz NULL`.
- A partial unique index on active service names:
  `UNIQUE (owner_project_id, name) WHERE kind = 'service' AND status = 'active'`.
- Indexes for `join_tokens.expires_at` and `workload_certs.not_after`.
- No change to the stored certificate body: `workload_certs` already has the principal,
  serial, fingerprint, validity, and revocation fields.

## Integration Points

- RD-02 supplies the admin and agent listeners, TLS material, `OPENVAULT_INTERNAL_CA`, the
  agent-listener join exception, and the readiness surface.
- RD-03 supplies admin authentication and the browser/CLI session principal. It does not
  supply project scoping.
- RD-06 defines the `identity.*` actions and the role/scope matrix. RD-05 uses a narrow
  helper until the full evaluator lands; RD-06 owns the control-plane ceiling and acceptance
  for a service identity granted a control-plane action.
- RD-07 records `identity.create`, `identity.revoke`, `identity.join_token`, `agent.join`,
  `agent.renew`, and consumer metadata changes. RD-05 does not claim persisted audit evidence
  before RD-07 lands; the failed-join audit assertion is verified in RD-07.
- RD-10 owns the agent's join request, certificate/key storage, two-thirds renewal trigger,
  retry/backoff, atomic key swap, refresh/heartbeat, consumer `state`, and object-scope reader
  grant.
- RD-08 supplies the agent data-plane secret handler and the existing
  `/v1/data/:project/secrets/:name` route; RD-10 uses that route on the agent listener.
- RD-11/RD-13 own `ov init`, CA generation, `ca_keys` provisioning, KEK re-wrap, encrypted
  backup, restore, and restore verification. RD-05 consumes the provisioned CA through the
  CA signer and uses a test fixture for its own acceptance.
- RD-14 verifies the mTLS boundary, CSR negative cases, revocation, and CA key protection.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | Ref |
|---|---|---|---|---|
| Workload auth | Static key / mTLS / OIDC | mTLS + join token | Short-lived and revocable | AR-6 |
| Certificate lifetime | 7 / 30 / 90 days | `OPENVAULT_CERT_TTL_DAYS`, default 30 | Honor the existing validated configuration; renewal is two thirds of the issued lifetime | PF-007 |
| CA | Public CA / internal CA / HSM | Internal EC P-256 CA | Self-hosted, no external dependency | AR-6 |
| CA key custody | CA file / keyring / `ca_keys` | KEK-wrapped `ca_keys` + `CaSigner` | Matches the documented key hierarchy, readiness, and RD-13 rotation | PF-002 |
| CA initialization | `ov init` / server first boot / operator file | `ov init` (RD-11/RD-13) | Idempotent, backup-friendly, and does not reorder fail-closed startup | PF-002 |
| Join token TTL | 5 / 15 / 60 minutes | 15 minutes default, 24 hours maximum | Short exposure with an explicit operator override | AR-14 |
| Project ownership | Global / project-owned | Project-owned | Prevents cross-project identity abuse | AR-16 |
| Join listener | Strict mTLS / route exception / new port | Route exception on 8444 with default-deny middleware | Smallest change that preserves the two-listener network model | PF-001 |
| Authorization | Full RBAC / narrow helper / hardcode | Narrow identity helper until RD-06 | RD-05 can complete without a dependency cycle; RD-06 replaces it | PF-010 |
| Audit | Audit port / move assertion / reorder RD-07 | Move the persisted assertion to RD-07 | RD-05 cannot claim persisted audit before its owner exists | PF-011 |
| CSR profile | Sign CSR / exact-match CSR / server-built profile | Server-built profile from the token | Removes impersonation and subordinate-CA paths | PF-003 |
| X.509 library | `@peculiar/x509` / `node-forge` / OpenSSL / custom | Pinned `@peculiar/x509` + thin wrapper | Smallest vetted library for CSR verification and X.509 issuance; no shell or custom ASN.1 | PF-012 |
| Revocation | Identity transaction / status-only / per-cert | Atomic identity revoke + per-request status and certificate check | One meaning for revoke; covers existing connections | PF-004, PF-005 |
| Renewal | Newest only / any cert / reuse key | Newest only, fresh CSR and key, retry replay | Bounds a stolen old certificate and rotates a compromised key | PF-008 |
| Token hash | SHA-256 / keyed hash | SHA-256 over 32 random bytes | The token has full entropy; the database stores only a fixed 32-byte digest | PF-006 |
| Rate limits | Join + renew values | 10/min join per IP; 10/min renew per principal; 60/min renew per IP | Bounds join and renewal amplification | PF-014 |
| Retention | 24h/30d / forever / inline delete | 24h tokens; 30d certificates; daily cleanup | Bounded tables without deleting a live revocation record | PF-016 |
| Consumer ownership | RD-05 join/renew / RD-10-RD-08 fetch | Split by lifecycle phase | Keeps identity issuance separate from the data-plane heartbeat/state update | PF-013 |
| Agent runtime | RD-05 / RD-10 | RD-10 | Keeps RD-05 server-side and testable before the agent exists | PF-013 |

## Security Considerations

- **Data sensitivity:** CA private key, join tokens, agent private keys, certificate
  fingerprints, and consumer metadata. The CA key is wrapped by the KEK; join tokens are
  stored hashed; agent private keys never reach the server.
- **Input validation:** token length/encoding, CSR shape and self-signature, EC P-256 key,
  exact SAN/extension profile, metadata lengths and formats, ULIDs, and request-body limits.
  Unknown fields are rejected.
- **Authentication & authorization:** join is the only unauthenticated agent route and is
  token-authenticated and rate-limited. Every other agent route is mTLS plus per-request
  certificate/status checks. Admin routes use the narrow identity authorization helper and
  never accept the browser cookie on the agent listener.
- **Injection risks:** no shell; a vetted X.509 library parses CSR input with resource
  limits; SQL uses parameterized queries.
- **Encryption needs:** TLS 1.2+ on both listeners; client certificates for protected agent
  routes; CA key wrapped by the KEK; private keys never returned or logged.
- **Rate limiting:** join 10/min per IP; renew 10/min per principal and 60/min per IP; 429
  responses. Counters are process-local in v0.1.
- **Revocation:** identity revoke is one transaction that disables the principal, revokes
  certificates, and invalidates tokens. The agent listener rechecks state on every request
  with a cache bounded to 5 seconds.
- **Logging:** join tokens, hashes, CSRs, private keys, and certificate bodies are never
  logged. A captured-log test proves the redaction.
- **Infrastructure:** the CA key is stored on the same host as the KEK; this is documented.
  There is no HSM or external CA in v0.1. `OPENVAULT_INTERNAL_CA` is the public CA certificate
  only.
- **Residual risk:** secrets already delivered to a container cannot be retracted. Rotate the
  values after a compromise. Per-certificate revocation is out of scope; identity revoke
  revokes all credentials.

## Acceptance Criteria

1. [ ] Creating a service identity without an owner project returns 422; a valid create
   returns 201, writes `principals(kind='service', owner_project_id)`, and rejects a duplicate
   active name with 409. A service principal cannot receive a local credential, OIDC identity,
   browser session, or CLI family.
2. [ ] An org administrator can create, read, list, revoke, and issue a join token for any
   identity. A project-scoped project administrator can do so only for its project; an
   org-scoped project administrator or auditor covers every project. An auditor can read
   identity metadata but cannot create, revoke, or issue a token; a foreign identity returns
   404. The control-plane ceiling is verified by RD-06 acceptance 4.
3. [ ] A join token is returned once, stored as a 32-byte SHA-256 hash, and is 43-character
   base64url. A sequential second exchange returns 401; two concurrent exchanges produce
   exactly one 200, one 401, one certificate row, and one consumer row. Expired, used, and
   revoked tokens return the same generic 401. Token issuance for a disabled identity or
   soft-deleted project is rejected, and a join for either case returns 401. Cross-project
   token issuance is rejected at the admin route. Failed-join audit persistence is verified in
   RD-07.
4. [ ] A valid CSR returns a certificate whose CN is the token principal, SAN is exactly one
   `openvault://identity/<id>`, basic constraints are `CA:FALSE`, key usage is
   `digitalSignature`, EKU is `clientAuth`, validity is `OPENVAULT_CERT_TTL_DAYS`, and the
   signature chains to `OPENVAULT_INTERNAL_CA`. The serial and SHA-256 fingerprint are stored;
   the agent does not need to know its principal id before join.
5. [ ] A non-P-256 key, invalid CSR signature, requested SAN, `CA:TRUE`, requested key
   usage/EKU, unknown critical extension, or malformed CSR returns 422, issues no certificate,
   and does not consume a valid token. An arbitrary or empty CSR subject is accepted. The CSR
   body and error detail never appear in the response or logs.
6. [ ] The agent listener allows `POST /v1/agent/join` without a client certificate. Every
   protected route returns 401 `authentication_required` for a missing, expired, self-signed,
   wrong-CA, unknown-fingerprint, revoked, or disabled certificate and for a soft-deleted
   project; a database/cache failure returns 503. No protected route reads a secret before
   this check.
7. [ ] Revoking an identity disables the principal, sets `revoked_at` on every unexpired
   certificate, revokes every unused join token, and marks the consumer failed in one
   transaction. A new connection, a reused keep-alive connection, and a renew attempt all
   fail with 401 within 5 seconds. A concurrent join and revoke leaves no unrevoked
   certificate and no `ok` consumer row. The test uses a controlled clock and an open
   connection.
8. [ ] Renewal before two thirds of the actual certificate lifetime returns 409
   `renewal_not_due`; after the threshold it succeeds with a fresh CSR/key, the old
   certificate remains valid for data until expiry but cannot renew, and a retry with the same
   public key inside the 5-minute replay window returns the same certificate even when the
   authenticating certificate is the old one. A non-default `OPENVAULT_CERT_TTL_DAYS` produces
   the correct threshold. An expired certificate requires a new join token.
9. [ ] Join creates one consumer row, a second join updates it while preserving `first_seen`,
   renew updates `last_seen`, and the RD-08 data-plane fetch on the agent listener updates
   `last_seen` and `state`. Invalid or unknown metadata returns 422; the server never accepts a
   principal or project override from the body. The admin response includes
   `selfReported: true`.
10. [ ] `ca_keys` contains one current KEK-wrapped P-256 CA key and a matching public
    certificate. Startup and `/ready` fail closed when the row is missing, the KEK cannot
    unwrap it, or it does not match `OPENVAULT_INTERNAL_CA`. Readiness can sign a test
    certificate that verifies against the CA. Re-running init does not rotate the CA. RD-13
    re-wraps the key, restores it, re-materializes the public certificate, and verifies a
    pre-backup agent certificate.
11. [ ] The 11th join in a minute from one IP returns 429. The 11th renew in a minute for one
    principal returns 429; the per-IP renewal bucket reaches 60 across distinct principals and
    the 61st returns 429 `RATE_LIMIT_EXCEEDED`. A new certificate does not reset the principal
    bucket.
12. [ ] A daily bounded cleanup deletes only join tokens older than 24 hours after expiry/use
    and certificates older than 30 days after expiry, while retaining a revoked certificate
    until the later of `not_after + 30 days` and `revoked_at + 30 days`. A post-expiry
    revocation is retained correctly. A cleanup failure is logged and does not disable auth or
    fail startup.
13. [ ] Captured logs from valid, expired, used, malformed-CSR, revoked, and renew requests
    contain no raw token, token hash, CSR body, private key, or CA key. Error bodies contain
    only stable codes and messages.
14. [ ] Security requirements verified: token hashing, CSR proof and profile, per-request
    revocation, CA key protection, no human credentials on service principals, no shell, no
    custom ASN.1, and no unauthenticated non-join agent route.

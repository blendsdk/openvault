# Join, Renewal, and Consumer: RD-05

> **Document**: 03-03-join-renew-consumer.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns join-token issuance and consumption, the join and renew HTTP services, the
consumer upsert, and the per-app join/renew rate limits. It uses the CA/X.509 boundary from
[03-02](03-02-ca-x509-issuance.md) and the identity contract/authorization from
[03-01](03-01-contracts-schema-authorization.md).

The join token is the identity source. The CSR only proves possession. The join transaction locks
the principal, claims the token atomically, signs a fixed-profile certificate, and writes the
certificate and consumer row before commit. Renewal uses the authenticated certificate, requires a
fresh key, and is serialized through the same principal lock. [AR-4, AR-6, AR-8, AR-13]

## Architecture

### Current Architecture

`join_tokens` already has a unique SHA-256 hash, principal/project binding, expiry, and `used_at`.
`workload_certs` already has serial/fingerprint/validity/revocation and a principal index.
`consumers` already has one row per principal. There is no token service, join/renew controller,
consumer repository, or agent rate-limit service.

### Proposed Changes

1. Add `AgentTokenService` under `apps/server/src/agent/`; it owns token SQL and the issue
   transaction.
2. Add `AgentJoinService`, `AgentRenewService`, `RenewalReplayCache`, and `ConsumerRepository`.
3. Add `AgentRateLimitService` with per-app join IP, renew principal, and renew IP limiters.
4. Add `AgentController` at `/v1/agent` with `POST /join` and `POST /renew`.
5. Wire the services through the agent runtime in [03-04](03-04-agent-listener-revocation.md).

## Implementation Details

### Join-token creation

`IdentityService` calls `AgentTokenService.issue(identity, ttlSeconds, createdBy)` after the admin
authorization and identity/project checks. `createdBy` is the authenticated actor id.

```ts
export interface IssuedJoinToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

issue(
  identity: ServiceIdentity,
  ttlSeconds: number | undefined,
  createdBy: string,
): Promise<IssuedJoinToken>;

revokeUnused(transaction: Transaction, principalId: string): Promise<void>;
```

- Generate 32 random bytes with `randomBytes(32)`; encode base64url without padding (43 chars).
- Hash the raw token with SHA-256 (32 bytes); only the hash is stored.
- Resolve the lifetime in milliseconds: a supplied `ttlSeconds` is multiplied by 1,000; when absent
  use `config.joinTokenTtlMs` directly. The service rejects a supplied value outside 1–86,400
  seconds with 422 `validation_error`; the contract only enforces an integer.
- In one transaction, lock the principal `FOR UPDATE` and the active project `FOR SHARE`, recheck
  both, then insert `join_tokens(id, token_hash, principal_id, project_id, expires_at,
  created_by)`. `createdBy` is the authenticated admin principal; it satisfies the NOT NULL FK.
- Return the raw token exactly once; no read route can reproduce it.
- A disabled identity or soft-deleted project is rejected before insertion. The same first lock
  order is used by join, renew, revoke, and token issuance. [AR-6, AR-9]

### Join sequence and atomicity

The controller parses the strict request and the service validates the CSR **before** touching the
token. A malformed CSR therefore does not consume a valid token.

```text
parse CSR -> verify proof and P-256 -> lock principal -> recheck active/project
-> conditional token claim -> issue certificate -> insert workload_certs
-> upsert consumer -> commit -> return certificate + chain
```

`AgentJoinService.join(input)`:

1. `parseAgentCsr(input.csr)` from 03-02. Any validation error returns 422 with a stable code.
2. Look up the token by SHA-256 hash without using `used_at` as a trust decision; require an
   unexpired, unused, unrevoked row.
3. Begin `database.withTransaction()`.
4. Lock the token’s principal `FOR UPDATE`; re-read `kind='service'`, active status, and active
   owner project. A missing/inactive identity or project returns 401 `join_failed`.
5. Claim the token with one conditional update:
   `UPDATE join_tokens SET used_at=now() WHERE token_hash=:hash AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id, principal_id, project_id`.
6. If the claim returns no row, roll back and return 401 `join_failed`.
7. Build the fixed profile from `principal_id` and `config.certTtlDays`; call
   `CaSigner.issueClientCertificate()`. The certificate is not returned until commit.
8. Insert `workload_certs(id, principal_id, serial, fingerprint, not_before, not_after)`.
   A unique serial collision retries the whole transaction with a fresh serial up to three times;
   the token claim rolls back, so the token is still available. After three collisions return 503.
9. Upsert `consumers` by `principal_id`; set `project_id`, metadata, `state='ok'`,
   `last_seen=now()`, preserve `first_seen`.
10. Commit; return the leaf certificate, CA chain, identity id, serial, and `notAfter`.

The principal lock is the same first lock used by revoke. A revoke that commits before the join
makes the recheck fail; a revoke that waits for the join revokes the new certificate after commit.
A concurrent second join cannot claim the same token. [AR-5, AR-6]

If certificate signing fails after the claim, the transaction rolls back, leaving the token unused.
If commit succeeds but the HTTP response is lost, the token is used and the certificate row exists;
the agent must request a new token. Join replay is intentionally not added in v0.1.

### Renewal

`AgentRenewService.renew(agentContext, input)`:

1. Parse and verify the fresh CSR with `parseAgentCsr()`.
2. Compute `publicKeySha256` (SPKI DER) and look up the process-local replay cache keyed by
   `(principalId, publicKeySha256)` **before** the newest-certificate check. A live hit returns the
   cached certificate response even when the authenticating certificate is the old certificate.
3. On a replay miss, reject the request with 422 `validation_error` when the CSR key hash equals
   `agentContext.publicKeySha256`. The authenticator computes that hash from the authenticated
   peer certificate. This enforces “fresh key” outside the replay window.
4. Begin `database.withTransaction()`.
5. Lock the principal `FOR UPDATE`; re-read active status and active owner project.
6. Select the newest unexpired, unrevoked `workload_certs` row for the principal ordered by
   `issued_at DESC, id DESC`.
7. Require `current.id === agentContext.certificateId`. Otherwise return 409
   `renewal_not_current`.
8. Require `now >= not_before + floor((not_after - not_before) * 2 / 3)`. Otherwise return 409
   `renewal_not_due`. Use the certificate’s actual dates; never hardcode 20 days.
9. Issue a new certificate with the configured TTL and fresh CSR/key; insert it; upsert the
   consumer metadata with `state='ok'` and `last_seen=now()`; commit.
10. Cache the response for five minutes under the public-key hash; return it.

The old certificate remains unrevoked and usable for data until `not_after`, but only the newest
certificate can renew. The replay cache is process-local, bounded (for example 1,024 entries), and
pruned on read/write. A restart loses it; the old certificate is then no longer current and the
agent must join again. `IdentityService.revoke()` calls `AgentRenewService.invalidatePrincipal()`
to clear replay entries for the revoked identity before returning. [AR-8, AR-24]

```ts
interface CachedRenewal {
  readonly expiresAt: number;
  readonly response: AgentCertificateResponse;
}
```

### Consumer upsert

`ConsumerRepository.upsert()` uses the existing unique `consumers.principal_id`:

```sql
INSERT INTO consumers
  (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash,
   state, first_seen, last_seen)
VALUES
  (:id, :principalId, :projectId, :composeProject, :composeService, :hostname, :manifestHash,
   'ok', now(), now())
ON CONFLICT (principal_id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  compose_project = EXCLUDED.compose_project,
  compose_service = EXCLUDED.compose_service,
  hostname = EXCLUDED.hostname,
  manifest_hash = EXCLUDED.manifest_hash,
  state = 'ok',
  last_seen = now()
RETURNING id, principal_id, project_id, compose_project, compose_service, hostname,
          manifest_hash, state, first_seen, last_seen;
```

The server sets `principal_id` and `project_id` from the token; the request cannot override them.
`first_seen` is never replaced. Join and renew write metadata and set `state='ok'`. RD-10/RD-08 own
the fetch heartbeat and `degraded`/`failed` transitions; the admin response always labels the
metadata self-reported. [AR-13]

### Agent controller

`AgentController` is registered at `/v1/agent`.

```ts
this.route().post("/join").middleware(joinIpLimit()).handle(...)
this.route()
  .post("/renew")
  .middleware(renewPrincipalLimit())
  .middleware(renewIpLimit())
  .handle(...)
```

- `POST /join` is the only unauthenticated route. It parses `agentJoinRequestSchema`, calls
  `AgentJoinService`, and returns `200` with `agentCertificateResponseSchema`.
- `POST /renew` calls `requireAgent(req)`, parses `agentRenewRequestSchema`, calls
  `AgentRenewService`, and returns `200` with the same response shape.
- The controller maps malformed JSON and empty/out-of-bound envelope fields to 400; an in-bound
  token that is not 43-character base64url, or is unknown/expired/used/revoked, to 401
  `join_failed`; and all remaining agent body/consumer/CSR schema failures to 422
  `validation_error`. The token is not regex-validated in the shared contract, so an in-bound bad
  token does not become a 400 validation leak.
- The response never contains a private key, token, token hash, or raw CSR.
- The CA signer failure is `503 ca_unavailable`; the database failure is 500 and contains no SQL.
- The join/renew services do not write audit rows; RD-07 owns the persisted event. [AR-11]

### Rate limits

`AgentRateLimitService` creates three WebAFX `rateLimitMiddleware` instances per application:

| Name | Limit | Key |
|---|---|---|
| joinIp | 10/minute | normalized `req.socket.remoteAddress` |
| renewPrincipal | 10/minute | `req.agent?.principalId` |
| renewIp | 60/minute | normalized `req.socket.remoteAddress` |

The async wrappers resolve the per-application service from `req.services`, matching the existing
browser/CLI limiter pattern. The join limiter runs before CSR parsing. The renew principal bucket
is consumed after agent authentication and never resets on certificate rotation. The IP key uses
the socket address, not a proxy header; agent forwarded headers are stripped by the pre-stack.
The counters are process-local and reset on restart. [AR-6, AR-15]

### Error handling

| Error case | Handling | AR |
|---|---|---|
| Unknown/expired/used/revoked/inactive token, principal, or project | 401 `join_failed`; one generic body | AR-6 |
| Malformed JSON, empty token, or over-128-character token envelope | 400 `validation_error` | AR-4, AR-13 |
| Agent body/consumer metadata/CSR schema or profile failure | 422 `validation_error`; token not consumed | AR-4, AR-13 |
| Join/renew rate limit | 429 `RATE_LIMIT_EXCEEDED` | AR-15 |
| Renew before two thirds | 409 `renewal_not_due` | AR-7, AR-8 |
| Renew from a non-newest certificate | 409 `renewal_not_current` | AR-8 |
| Renew with the authenticating certificate’s key outside the replay window | 422 `validation_error` | AR-8 |
| Renew with an expired/invalid certificate | 401 at the agent middleware; no controller access | AR-5 |
| Token or certificate table write failure | Transaction rollback; no partial credential | AR-5, AR-6 |
| CA signer unavailable | 503 `ca_unavailable` | AR-3 |
| Serial/fingerprint collision | Retry the whole transaction with a fresh serial up to three times; then 503; no token/certificate committed | AR-3 |
| Response lost after join commit | Token is used; operator issues a new token | AR-6 |
| Response lost after renew commit | Same-key retry returns the cached certificate inside five minutes | AR-8 |

## Testing Requirements

- Contract tests for join/renew requests, CSR field bounds, consumer metadata, and response shape.
- Join: valid token creates one certificate and one consumer; stored fields match the profile;
  token hash is 32 bytes; raw token is absent from the database and logs.
- Token issuance/revoke race: a concurrent issue either commits before revoke and is revoked by it,
  or observes the disabled identity and returns 409; no live unused token remains after both.
- Concurrency: two parallel joins with one token produce one 200, one 401, one certificate, and
  one consumer; join versus revoke leaves no unrevoked certificate.
- Inactive identity/project and revoked/expired/used tokens return the same 401 body.
- CSR negatives: malformed, bad proof, RSA/P-384, any extension; no token consumption.
- Renewal: before threshold 409; at/after threshold 200; a fresh key is used; old certificate
  remains valid but cannot renew; a lost response retry with the same public key inside five
  minutes returns the same certificate; the same key outside the replay window returns 422; a
  different key from an old certificate returns 409 `renewal_not_current`.
- Consumer: first join inserts; second join updates and preserves `first_seen`; renew updates
  `last_seen`; metadata override attempts fail; state is `ok`; no duplicate row.
- Rate limits: 11th join per IP; 11th renew per principal; 61st renew across principals from one
  IP. All return 429 with the stable code.

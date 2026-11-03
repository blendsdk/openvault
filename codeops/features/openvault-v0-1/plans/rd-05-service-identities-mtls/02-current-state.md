# Current State: RD-05 Service Identities and mTLS

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

- The initial schema already has `principals` with `kind` (`user`/`service`), `owner_project_id`,
  `status`, and `disabled_at`; `workload_certs` with principal, serial, fingerprint, validity, and
  revocation; `join_tokens` with principal/project/hash/expiry/use; `consumers` with one row per
  principal; and `role_assignments` with role/scope/expiry.
- The server has a typed configuration layer with `OPENVAULT_INTERNAL_CA`,
  `OPENVAULT_JOIN_TOKEN_TTL`, `OPENVAULT_CERT_TTL_DAYS`, and the agent port.
- The transport layer binds separate admin and agent HTTPS listeners. The agent listener currently
  uses `requestCert: true` and `rejectUnauthorized: true` for every route.
- The auth plugin resolves browser sessions and CLI bearers and installs Origin/CSRF guards. There
  is no agent authentication context.
- The keyring exposes current/named KEKs. `signing_keys` demonstrates KEK-wrapped 32-byte key
  material, AES-256-GCM AAD binding, transaction-scoped advisory locking, and cache handling.
- Readiness probes cover PostgreSQL, keyring, TLS/CA, and the audit table. The CA probe only checks
  the configured PEM; it does not load or use a CA private key.
- The integration harness creates disposable PostgreSQL databases, real HTTPS listeners, OpenSSL
  TLS fixtures, captured logs, and test-only auth seams.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/database/schema.ts` | Desired schema and generated migration source | Add `ca_keys`, `join_tokens.revoked_at`, active-service-name unique index, cleanup indexes |
| `apps/server/src/database/generated-types.ts`, `ctypes.ts` | Generated database types/constants | Regenerate after migration |
| `apps/server/migrations/` | Migration ledger and snapshots | Generated schema migration plus reviewed trigger migration |
| `apps/server/src/transport/secure-application.ts` | Admin/agent HTTPS servers and lifecycle | Agent listener `rejectUnauthorized:false`; disable resumption; wire agent runtime |
| `apps/server/src/transport/scope.ts` | Default-deny listener path table | Allow agent-scoped `/v1/data/*`; keep admin/agent separation |
| `apps/server/src/app.ts` | Application assembly, services, controllers | Register the single identity/agent runtime, controllers, listener-aware auth middleware, and CA/readiness wiring; fail closed without an authenticator |
| `apps/server/src/main.ts` | Production startup order | Load CA signer after migrations; bootstrap identity/agent runtime before transport |
| `apps/server/src/auth/plugin.ts` | Auth service registration and middleware | Skip browser/CLI resolvers on the agent listener; service-principal rejection |
| `apps/server/src/auth/credentials.ts` | Local credential lookup/status | Reject service principals on human credential paths |
| `apps/server/src/auth/oidc/identity.ts` | OIDC linking/JIT | Reject service principals on existing linkage |
| `apps/server/src/auth/middleware.ts`, `auth/cli-sessions.ts` | Browser/CLI context and family reads | Require `kind='user'`; skip on agent listener |
| `apps/server/src/observability/logger.ts` | Pino redaction | Add join-token/CSR/CA-key paths and captured-log evidence |
| `apps/server/src/security/keyring.ts` | KEK lifecycle and scoped access | Reuse unchanged |
| `apps/server/src/security/signing-keys.ts` | KEK-wrapped key pattern | Reuse pattern for CA wrapping; do not couple signing keys to CA |
| `apps/server/src/readiness/service.ts` | Dependency probes | Add a conditional CA sign/verify probe when the runtime is present |
| `apps/server/src/types/express.d.ts` | Request augmentation | Add `req.agent` |
| `apps/server/src/controllers/` | HTTP controllers | Add identity and agent controllers |
| `apps/server/package.json`, `pnpm-lock.yaml` | Runtime dependencies | Add `@peculiar/x509`, `@peculiar/asn1-schema`, `reflect-metadata` |
| `apps/server/tests/integration/helpers/tls.ts` | Existing TLS fixture | Add an EC agent CA/CSR/client fixture or a separate agent fixture |
| `apps/server/tests/integration/transport.spec.test.ts`, `transport.impl.test.ts` | Agent TLS/scope tests | Update for join exception, HTTP 401, protected health, and test seams |
| `apps/server/tests/integration/readiness.spec.test.ts`, `tests/test-app.impl.test.ts`, `tests/logging.spec.test.ts` | Existing readiness/app/logging suites | Conditional CA probe, runtime seam, redaction evidence |
| `packages/api-contract/src/*` | Shared Zod contracts | Add identity and agent schemas and exports |
| `docs/reference/api.md`, `configuration.md`, architecture/guides | Public behavior | Already aligned by the preflight; verify against implementation |

### Code Analysis

The current agent listener options reject a new agent at the handshake:

```ts
const agentOptions: ServerOptions = {
  ...adminOptions,
  requestCert: true,
  rejectUnauthorized: true,
  ca: [tls.caPem],
};
```

The listener scope also allows only `/health` and `/v1/agent/*` on the agent listener:

```ts
return path === "/health" || path === "/v1/agent" || path.startsWith("/v1/agent/");
```

The schema already enforces service ownership and project consistency:

```ts
principals.checkConstraint(
  "(kind = 'service' AND owner_project_id IS NOT NULL) OR (kind = 'user' AND owner_project_id IS NULL)",
);
```

The existing key-wrap pattern binds ciphertext to a row identifier:

```ts
function seedAad(kid: string): Buffer {
  return Buffer.from(`ov:jwt:v1:${kid}`, "utf8");
}
```

The CA signer should reuse this shape with a distinct AAD namespace and a raw P-256 scalar.

The existing readiness probes are a fixed list created from database, keyring, and TLS
dependencies. The CA signer is not available to that factory today, and no CA private key is
loaded. The plan makes the signer available before readiness is constructed and adds the CA probe
conditionally only when the agent runtime is present, so admin-only tests keep their existing
readiness behavior.

The transport integration tests deliberately use a closed database port and real HTTPS. They
currently prove that the agent listener rejects a missing or untrusted client certificate at the
handshake. After the join exception, those tests must distinguish the join route from every
protected path and use a test authenticator for offline listener tests.

There is no production `/v1/data` controller yet. RD-08 owns it. The RD-05 middleware can still
enforce the agent scope and project comparison against a test-only route; the real handler will
inherit the middleware when RD-08 lands.

## Gaps Identified

### Gap 1: Agent bootstrap is unreachable

**Current Behavior:** The agent listener rejects every connection without a client certificate, so
`POST /v1/agent/join` cannot issue the first certificate.
**Required Behavior:** Only join is allowed without a verified certificate; every other agent
listener route is default-deny. [AR-2, AR-18]
**Fix Required:** Listener option change, application middleware, test seams, and updated
transport expectations.

### Gap 2: CA private key is not stored or loaded

**Current Behavior:** `TlsMaterial` reads only the public CA PEM; no `ca_keys` row, signer, or
readiness probe exists.
**Required Behavior:** A KEK-wrapped CA scalar in `ca_keys`, a `CaSigner` that matches the public
certificate, and a readiness sign/verify probe. [AR-3, AR-17]
**Fix Required:** Schema, wrap/unwrap, signer, startup wiring, readiness, test fixture.

### Gap 3: No service-identity or agent API

**Current Behavior:** `principals`, `join_tokens`, `workload_certs`, and `consumers` exist only as
schema; there are no repositories, services, controllers, or contracts.
**Required Behavior:** Admin lifecycle with narrow authorization; join/renew with atomic token
claim, fixed profile, replay, consumer writes, and rate limits. [AR-4–AR-10, AR-13]
**Fix Required:** Contracts, repositories, services, controllers, app registration.

### Gap 4: No CSR/X.509 implementation

**Current Behavior:** No X.509/CSR library; the test helper shells out to OpenSSL.
**Required Behavior:** Vetted in-process CSR parsing/verification and fixed-profile certificate
issuance; no shell or custom ASN.1. [AR-12]
**Fix Required:** Approved dependency, thin wrapper, negative tests.

### Gap 5: Revocation is not connected to agent requests

**Current Behavior:** `workload_certs.revoked_at` and `principals.status` are independent; the
listener checks neither after the handshake.
**Required Behavior:** Atomic revoke over principal/certificates/tokens/consumer; per-request
certificate/principal/project check with a cache bounded to five seconds. [AR-5]
**Fix Required:** Revoke transaction, authenticator cache, middleware, invalidation, tests.

### Gap 6: Service principals can receive human credentials

**Current Behavior:** Login lookup filters `kind='user'` for local credentials, but OIDC linkage
and direct table inserts have no service-principal guard; CLI sessions have no guard.
**Required Behavior:** Every human credential path and database guard rejects service principals,
including a user→service kind change and browser/CLI read paths. [AR-14]
**Fix Required:** OIDC/session read filters, principal-kind and credential triggers, tests.

### Gap 7: Lifecycle cleanup is absent

**Current Behavior:** No join-token or workload-certificate cleanup and no indexes for it.
**Required Behavior:** 24h after token expiry/use; 30d after certificate expiry or the later of
expiry and revocation; daily bounded cleanup. [AR-15]
**Fix Required:** Indexes, maintenance service, tests.

## Dependencies

### Internal Dependencies

- RD-02 transport listeners, TLS material, scope, readiness, and startup lifecycle.
- RD-03 browser/CLI auth context and principal status.
- Existing keyring and PostgreSQL transaction helpers.
- Existing WebAFX controller, rate-limit, logger, and error-envelope patterns.
- Existing integration-test database, HTTPS, and captured-log helpers.
- RD-06 action matrix, RD-07 audit ownership, RD-08 data handler, RD-10 agent runtime, RD-13
  CA init/backup (later owners, not implementation dependencies for this plan).

### External Dependencies

- `@peculiar/x509@3.1.0`, `@peculiar/asn1-schema` peer, and `reflect-metadata` (approved).
- Node 24 WebCrypto/EC P-256 and `node:crypto`.
- PostgreSQL 16/17 and existing `pg`/BlendSDK adapters.
- OpenSSL only for existing test fixtures where retained; the product path never shells out.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Join exception accidentally opens another agent route | Medium | High | Default-deny middleware before routing; test every agent path; only POST join exempt |
| Agent listener options allow an untrusted certificate through | Medium | High | Check `socket.authorized`, chain, fingerprint, DB row, principal/project status |
| CA key leaks through logs, errors, or test fixtures | Low | High | `CaSigner` owns crypto; no key in controllers; captured-log tests; temp fixtures deleted |
| Join/revoke race leaves a valid certificate | Medium | High | Principal lock in both paths; atomic token claim; concurrent tests |
| Renewal replay allows an old certificate to extend access | Medium | High | Replay only for same public key within five minutes; newest-only otherwise; old cert cannot renew |
| Generated migration drifts from `schema.ts` | Medium | Medium | Regenerate, review, apply on PG16/17, `db:types:check` |
| Test seam hides production behavior | Medium | Medium | Seams only in test dependencies; production main always constructs the real signer/authenticator |
| Cross-RD assertion is mistaken for completed work | Medium | Medium | Explicit acceptance mapping; later owners named in [AR-21](00-ambiguity-register.md#cross-rd-acceptance-ownership) |
| Agent listener `/health` breaks a container health check | Low | Medium | Document that agent listener health requires mTLS; admin liveness remains separate |
| Existing tests rely on strict handshake rejection | High | Low | Update test harness for HTTP 401 and test authenticator; keep the protected-route assertion |

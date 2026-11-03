# Agent Listener, Revocation, and Retention: RD-05

> **Document**: 03-04-agent-listener-revocation.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the agent-listener authentication boundary, the request cache, the data-route
project guard, the atomic identity-revocation transaction, and lifecycle cleanup. It also defines
the runtime composition that makes the CA signer, agent services, identity services, controllers,
and readiness probe available to the application.

The listener is no longer handshake-strict for join. It uses optional client certificates and a
default-deny application middleware. Only `POST /v1/agent/join` is unauthenticated. `/health` and
every other agent-listener route require a verified chain, a stored workload certificate, an
active principal, and an active project. The request check runs after the handshake so an existing
keep-alive connection cannot outlive a revocation by more than the five-second cache bound.
[AR-2, AR-5, AR-18]

## Architecture

### Current Architecture

`SecureWebApplication` builds both HTTPS servers from the same TLS material. The agent listener
uses `requestCert: true`, `rejectUnauthorized: true`, and `ca: [tls.caPem]`. `scope.ts` allows
only `/health` and `/v1/agent/*` on the agent listener. The auth plugin resolves browser/CLI
contexts only. There is no agent context, authenticator, cache, data-route guard, or cleanup
service.

### Proposed Changes

1. Change agent listener options to `requestCert: true`, `rejectUnauthorized: false`, keep the CA,
   and disable session tickets/resumption.
2. Add `req.agent` and `AgentAuthContext` in `apps/server/src/agent/types.ts` (or
   `agent/agent-authenticator.ts`) and `types/express.d.ts`.
3. Add `AgentAuthenticator` with a positive five-second cache and `invalidatePrincipal()`.
4. Add `agentAuthMiddleware()` that exempts only `POST /v1/agent/join`, protects `/health`, and
   checks the data-route project when the path starts with `/v1/data/`.
5. Add `AgentRuntime` composition for CA signer, identity services, join/renew services, rate
   limits, cache, and maintenance; wire it in `main.ts`/`app.ts`.
6. Add `AgentMaintenanceService` for bounded daily cleanup.
7. Extend readiness with a `ca` probe using `CaSigner.probe()`.
8. Add the test-only agent authenticator/CA seams and a test-only `/v1/data` probe in the
   integration helper; update transport expectations.

## Implementation Details

### Agent context

```ts
export interface AgentAuthContext {
  readonly kind: "agent";
  readonly principalId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly certificateId: string;
  readonly serial: string;
  readonly fingerprint: string;
  readonly publicKeySha256: string;
  readonly notAfter: number;
}
```

Add `agent?: AgentAuthContext` to `Express.Request` in `src/types/express.d.ts`.
`requireAgent(req)` returns it or throws `401 authentication_required`. Keep the browser/CLI
`AuthContext` union unchanged. The browser and CLI resolvers skip the agent listener entirely, so
agent credentials never participate in browser CSRF, password-change, or CLI refresh rules. Add
mixed-cookie and mixed-bearer tests. [AR-16]

### Listener options and scope

```ts
const agentOptions: ServerOptions = {
  ...adminOptions,
  requestCert: true,
  rejectUnauthorized: false,
  ca: [tls.caPem],
  secureOptions: constants.SSL_OP_NO_TICKET,
  sessionTimeout: 0,
};
```

`rejectUnauthorized:false` is required only because a new agent has no certificate. The application
middleware is the security boundary. The CA list still lets Node set `socket.authorized` and
`getPeerCertificate()` for a trusted chain; an untrusted or missing certificate reaches the
middleware with `authorized===false`.

The agent listener is fail-closed. `startTransport()` must require an `AgentAuthenticator` (real or
the explicit test override) before binding the agent listener; without one, it throws. The listener
flip and middleware installation are one atomic change. The admin-only test path may omit a
functional runtime; `createTestApplication` supplies an explicit deny-all authenticator and can
start both listeners. An explicit fixture authenticator takes precedence.

Update the agent scope to:

```ts
return (
  path === "/health" ||
  path === "/v1/agent" ||
  path.startsWith("/v1/agent/") ||
  path === "/v1/data" ||
  path.startsWith("/v1/data/")
);
```

The admin listener already permits `/v1/data/*`; it does not permit `/v1/agent/*`. The scope table
is defense in depth, not authentication.

### Agent authenticator

```ts
export interface AgentAuthenticator {
  authenticate(req: Request): Promise<AgentAuthContext | undefined>;
  revalidate(req: Request): Promise<AgentAuthContext | undefined>;
  invalidatePrincipal(principalId: string): void;
}
```

`authenticate()`:

1. Return `undefined` on a non-agent listener.
2. Read the TLS socket via a type guard. Require `socket.authorized === true` and a peer
   certificate with raw DER. Compute the SHA-256 fingerprint from DER (`lowercase hex`), not the
   colon-formatted display string. Also compute the SHA-256 of the certificate’s SPKI DER public
   key and place it in `publicKeySha256`.
3. Check the positive cache by fingerprint. A live entry returns the context only after checking
   `notAfter > Date.now()`.
4. Otherwise query one row:

```sql
SELECT wc.id, wc.serial, wc.fingerprint, wc.not_after,
       p.id AS principal_id, p.owner_project_id, p.status AS principal_status,
       pr.name AS project_name, pr.deleted_at
  FROM workload_certs wc
  JOIN principals p ON p.id = wc.principal_id
  JOIN projects pr ON pr.id = p.owner_project_id
 WHERE wc.fingerprint = :fingerprint
   AND wc.revoked_at IS NULL
   AND wc.not_before <= now()
   AND wc.not_after > now()
   AND p.status = 'active'
   AND pr.deleted_at IS NULL;
```

5. Return `undefined` for no row, a disabled principal, a revoked certificate, a soft-deleted
   project, or an expired certificate.
6. Cache the positive context with an expiry calculated from the read start (`readStartedAt + 5s`),
   not from after the query returns. Do not cache misses; a newly joined agent must be accepted
   immediately. Cache size is bounded (for example 1,024); expired entries are pruned on
   read/write.
7. `invalidatePrincipal()` removes every cache entry for the principal after a local revoke.
8. `revalidate(req)` performs the same TLS/DB checks without reading the positive cache. RD-08
   must call it (or an equivalent cache-bypassing check) immediately before sending a secret.

A database/cache failure propagates to the middleware, which returns `503` and never falls open.
The authenticator does not return a context for a certificate with an unknown fingerprint even
though the TLS chain is valid. [AR-5, AR-18]

```ts
export interface AgentProjectResolver {
  resolveActiveByName(name: string): Promise<{ readonly id: string; readonly name: string } | undefined>;
}
```

The resolver reads `projects` with `deleted_at IS NULL`; it may share a five-second cache with the
authenticator. The runtime registers it as a singleton.

### Middleware

`agentAuthMiddleware(authenticator)` runs before routing:

```text
if listener !== agent -> next
if method === POST && path === /v1/agent/join -> next
context = await authenticator.authenticate(req)
if !context -> 401 authentication_required
req.agent = context
if path starts with /v1/data/:
  projectName = decode the first path segment after /v1/data
  project = await projectResolver.resolveActiveByName(projectName)
  if !project || project.id !== context.projectId -> 403 access_denied
next
```

The path is normalized once with the existing `normalizeRequestPath`; malformed paths fail through
the pre-stack. The path project is resolved to its active project id and compared with
`context.projectId`, matching the RD-05 invariant. The data-route comparison is defense in depth
for RD-08; the actual secret handler also uses RBAC and `revalidate()`. A valid certificate for
project A cannot request project B. [AR-13, AR-18]

The middleware protects `/health`; the agent health check therefore requires a live workload
certificate. The admin `/health` remains the container liveness route and is unchanged.

### Revocation transaction

`IdentityService.revoke()` runs:

1. `SELECT ... FROM principals WHERE id=:id FOR UPDATE`.
2. Verify the identity exists and is a service identity; return 404 when missing/foreign.
3. `UPDATE principals SET status='disabled', disabled_at=COALESCE(disabled_at, now())`.
4. `UPDATE workload_certs SET revoked_at=now() WHERE principal_id=:id AND revoked_at IS NULL AND not_after>now()`.
5. `agentRuntime.identityRuntime.tokens.revokeUnused(tx, id)`; `AgentTokenService` owns the
   unused-token update.
6. `UPDATE consumers SET state='failed', last_seen=now() WHERE principal_id=:id`.
7. Commit.
8. Call `agentAuthenticator.invalidatePrincipal(id)` and
   `renewService.invalidatePrincipal(id)` after commit; both local caches drop the identity.
9. Return 204.

The same principal lock is taken first by join and renew, so a join cannot insert an unrevoked
certificate after a revoke commits. A concurrent revoke that waits for a join will revoke the new
certificate. A concurrent revoke that wins makes the join’s recheck fail. [AR-5, AR-6]

The observable guarantee is:

> No new agent request is admitted more than five seconds after the revocation transaction
> commits, including on an already-open keep-alive connection. A data handler must call
> `revalidate()` immediately before sending a secret and fail closed if it no longer holds a live
> context.

The per-request middleware and local cache invalidation meet the admission bound in one process.
Another process may use a warm positive entry for at most five seconds. RD-08 owns the pre-send
recheck for secret delivery; that obligation is recorded in the plan's cross-RD acceptance map.
Tests cover a new connection, a reused connection, a renew attempt, and a deliberately slow
test-only data route. Secrets already delivered to a container are not retracted; the operator
rotates them. [AR-5]

### Retention

`AgentMaintenanceService` runs an initial bounded cleanup and then every 24 hours. A failure is
logged with a fixed message and does not abort startup or disable authentication.

```sql
-- 1,000-row bound; tokens retained 24h after the later of expiry/use/revocation
DELETE FROM join_tokens
 WHERE id IN (
   SELECT id
     FROM join_tokens
    WHERE expires_at < now() - interval '24 hours'
      AND (used_at IS NULL OR used_at < now() - interval '24 hours')
      AND (revoked_at IS NULL OR revoked_at < now() - interval '24 hours')
    ORDER BY expires_at
    LIMIT :limit
 );

-- certificates retained 30d after the later of expiry/revocation
DELETE FROM workload_certs
 WHERE id IN (
   SELECT id
     FROM workload_certs
    WHERE not_after < now() - interval '30 days'
      AND (revoked_at IS NULL OR revoked_at < now() - interval '30 days')
    ORDER BY not_after
    LIMIT :limit
 );
```

The indexes from 03-01 support the candidate scans. Deleting a revoked certificate before its
retention boundary would silently un-revoke it; the query never does that. [AR-15]

### Runtime composition and startup

`apps/server/src/agent/agent-runtime.ts` owns:

```ts
export interface AgentRuntimeCore {
  readonly caSigner: CaSigner;
  readonly authenticator: AgentAuthenticator;
  readonly projectResolver: AgentProjectResolver;
  readonly identityRuntime: IdentityRuntime;
  readonly joinService: AgentJoinService;
  readonly renewService: AgentRenewService;
  readonly rateLimits: AgentRateLimitService;
}

export interface AgentRuntime extends AgentRuntimeCore {
  readonly maintenance: AgentMaintenanceService;
  dispose(): Promise<void>;
}

export async function createAgentRuntime(options: {
  database: PostgreSQLDatabase;
  keyring: KeyringProvider;
  tls: TlsMaterial;
  config: OpenVaultConfig;
  logger: PinoLoggerProvider;
  now?: () => number;
}): Promise<AgentRuntimeCore>;
```

Production order:

1. `loadConfig`, `KeyringProvider.load`, `TlsMaterial.load`.
2. `runMigrations`.
3. Open the database.
4. `createAgentRuntime()` loads `ca_keys`, constructs the single `IdentityRuntime` owner, the
   authenticator, project resolver, join/renew/rate services, and fails startup if the CA is
   missing/mismatched. It receives the one logger provider created in `main.ts`. It does not
   construct a maintenance timer or a second identity service.
5. Phase 4 extends the core runtime with `maintenance` and `dispose`; the Phase 3 integration tests
   use the core. `createApplication(config, { database, tls, keyring, logger, agentRuntime })`.
6. `app.prepare()`; `bootstrapAuthRuntime(app)`; `bootstrapAgentRuntime(app)` starts maintenance.
7. `app.startTransport()` binds both listeners only after the CA, identity runtime, authenticator,
   and agent middleware are ready.

`createApplication` accepts either the Phase 2 test `IdentityRuntime` or the Phase 3
`AgentRuntimeCore` (Phase 4 `AgentRuntime` extends it), never both, and registers its services
once; the `identity-runtime` remains the only owner of the identity service and token service.

`createTestApplication` supplies an explicit deny-all test authenticator only when no
`agentOverrides.authenticator` is provided. Admin-only auth/CLI/logging suites can therefore start
both listeners without an open agent route; agent requests receive 401. An explicit fixture
authenticator takes precedence, so the transport tests can authorize their trusted client
certificate without weakening other suites. `createApplication`/production requires a real or
explicit test authenticator, and `startTransport()` throws when neither is present. The Phase 4
`AgentRuntime.dispose()` stops maintenance, clears both caches, and calls `caSigner.destroy()`;
register it through the application service disposal path.

### Readiness

`createProductionProbes` adds the `ca` probe only when an agent runtime/CA signer is present:

```ts
{
  name: "ca",
  async check() {
    try {
      await agentRuntime.caSigner.probe();
    } catch {
      throw new ReadinessError("ca");
    }
  },
}
```

The admin-only test path omits the probe and keeps the existing readiness suite green. Production
always supplies the runtime. Add `"ca"` to `ReadinessProbeName`. `/ready` remains 503 on a missing
key, unwrap failure, mismatch, or sign/verify failure when the probe is present. The probe does not
require a live agent. The `ReadyController` logs the fixed probe name and returns the generic
`not_ready` envelope. [AR-3]

### Test seams

`SecureApplicationDependencies` gains an optional `agentRuntime` (real) and a test-only
`agentOverrides` seam:

```ts
interface AgentTestOverrides {
  readonly authenticator?: AgentAuthenticator;
  readonly projectResolver?: AgentProjectResolver;
  readonly caSigner?: Pick<CaSigner, "issueClientCertificate" | "probe">;
  readonly now?: () => number;
}
```

Production `main.ts` passes the real runtime and never the overrides. Tests can:

- use a fake authenticator that accepts a fixture client certificate;
- use a fake CA signer for listener/scope tests that never join;
- use real PostgreSQL and the real runtime for join/renew/revoke/authorization/cleanup tests;
- use `createApplication(...)`, register a test-only controller at `/v1/data/:project/secrets/:name`
  **before** `app.prepare()`, then `startTransport()` on the real agent listener. Do not add routes
  after `prepare()`; they sit behind the 404 handler. The probe verifies the middleware and
  project-id guard, and does not implement the RD-08 secret handler.

The existing transport/readiness/test-app/logging tests move to the new boundary:
`transport.spec.test.ts`, `transport.impl.test.ts`, `readiness.spec.test.ts`, `test-app.impl.test.ts`,
and `tests/logging.spec.test.ts` are explicitly updated. Missing/untrusted certificates on
protected paths return HTTP `401 authentication_required`; the accepted fixture certificate uses
the test authenticator and receives `200` for `/health`; the join route remains reachable without a
client certificate.

### Error handling

| Error case | Handling | AR |
|---|---|---|
| Missing/untrusted/expired/revoked/disabled certificate on a protected path | 401 `authentication_required`; no route handler runs | AR-5, AR-18 |
| Unknown fingerprint or inactive project | 401; no data | AR-5, AR-18 |
| Database/cache failure during agent auth | 503; fail closed | AR-5, AR-18 |
| Data path project differs from certificate owner | 403 `access_denied`; no data | AR-13 |
| Revoke unknown/foreign identity | 404 `identity_not_found` | AR-9 |
| Revoke DB failure | 500; transaction rollback; no partial revocation | AR-5 |
| Cleanup failure | Logged; startup and auth continue; retry next interval | AR-15 |
| CA probe failure | `/ready` 503 `not_ready` when the runtime probe is present; agent signing unavailable | AR-3 |
| Agent listener receives an admin path | Scope 404 before auth | AR-2 |

## Testing Requirements

- Listener options: join without a certificate reaches the join service; missing/untrusted
  certificates on `/health`, `/v1/agent/renew`, and `/v1/data` return HTTP 401; a valid test
  certificate reaches `/health`.
- Authenticator: valid chain but unknown fingerprint rejected; expired/revoked certificate,
  disabled principal, soft-deleted project, and wrong data project rejected; DB failure 503.
- Cache: repeated requests within five seconds use one DB read; a revoke invalidates the local
  entry; another process’s stale entry expires within five seconds; a newly issued certificate is
  accepted immediately.
- Revocation: atomic updates; idempotent 204; new/reused/renew requests fail within five seconds;
  concurrent join/revoke leaves no unrevoked cert.
- Retention: token and certificate boundaries; post-expiry revocation; bounded batches; failed
  cleanup does not block startup.
- Readiness: CA sign/verify success and failure; missing/mismatched CA at startup; admin-only
  path omits the CA probe; runtime path includes it.
- Existing transport, readiness, test-app, and logging suites are updated and green.
- Mixed browser cookie/CLI bearer on the agent listener never attaches `req.auth`.
- Data-route guard resolves the path project id and rejects a soft-deleted or mismatched project.
- Admission-time guarantee: a deliberately slow test-only data route that revalidates before
  sending fails closed after a revoke.
- Test seam: production wiring never uses test overrides; fake runtime is not used by `main.ts`.

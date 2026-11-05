# Current State: RD-10 Agent Delivery and Compose

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The server already owns the agent identity and listener boundary. `AgentJoinService` validates
a PKCS#10 CSR, claims a single-use join token, signs a fixed-profile certificate, and upserts
one consumer row in the same transaction. `AgentRenewService` enforces the two-thirds window,
the newest-certificate rule, and a five-minute process-local replay cache keyed by the CSR
public key. `DatabaseAgentAuthenticator` verifies the TLS chain, the live `workload_certs`
row, the principal, and the project on every request with a bounded five-second cache.
`agentAuthMiddleware` denies every agent-listener route except `POST /v1/agent/join` and
enforces the owner-project comparison for `/v1/data/*`.

The RD-08 data route already serves `GET /v1/data/:project/secrets/:name` on the agent
listener. `SecretsController` resolves the agent context and passes `agentPrincipalId` to
`SecretService.read`; the service updates `consumers.last_seen` after a successful decrypt
but does not update `state`. `consumers.state` already allows `ok`, `degraded`, and `failed`.

The project, identity, assignment, and join-token services already expose every operation a
scaffold needs. `ProjectService` creates and lists projects; `IdentityService` creates, lists,
and issues tokens; `AssignmentService` grants object-scope roles; `SecretRepository` resolves
an active secret by project and name. There is no scaffold route, service, or Compose renderer.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/agent/agent-join-service.ts` | Join, token claim, certificate, consumer upsert | Reuse unchanged |
| `apps/server/src/agent/agent-renew-service.ts` | Two-thirds renewal and replay cache | Reuse unchanged; agent must match its five-minute window |
| `apps/server/src/agent/agent-authenticator.ts` | mTLS and live-row admission | Reuse unchanged |
| `apps/server/src/agent/agent-middleware.ts` | Default-deny agent listener and project guard | Reuse unchanged |
| `apps/server/src/agent/consumer-repository.ts` | One consumer row per identity | Reuse unchanged |
| `apps/server/src/controllers/secrets.ts` | Data routes and agent read | Read consumer state headers and update the heartbeat |
| `apps/server/src/secrets/service.ts` | Secret read and heartbeat | Accept a state or expose a state-aware heartbeat method |
| `apps/server/src/secrets/repository.ts` | `touchConsumer` | Add the allowlisted state |
| `apps/server/src/agent/consumer-service.ts` | New state-aware heartbeat service | Audit state transitions; best-effort failure |
| `apps/server/src/projects/service.ts` | Project create/list/authz | Reuse in scaffold |
| `apps/server/src/identity/identity-service.ts` | Identity create/list/token/authz | Reuse in scaffold |
| `apps/server/src/rbac/assignment-service.ts` | Object-scope assignment/authz | Reuse in scaffold |
| `apps/server/src/secrets/repository.ts` | Active secret lookup | Reuse in scaffold |
| `apps/server/src/app.ts` | Composition | Register scaffold service/controller |
| `packages/api-contract/src/agents.ts` | Join/renew/consumer contracts | Reuse unchanged |
| `packages/api-contract/src/index.ts` | Contract exports | Export scaffold contracts |
| `apps/server/tests/integration/helpers/agent-app.ts` | Real agent listener harness | Reuse for scaffold/state tests |
| `apps/server/tests/integration/helpers/agent-tls.ts` | Real CA/CSR/client fixtures | Reuse |
| `apps/server/tests/integration/secrets-consumer-state.spec.test.ts` | Agent heartbeat and state tests | New file; the existing lifecycle test keeps its scope |
| `docs/guide/agent.md` | Target agent documentation | Replace the "later release" note with implemented behavior |
| `docs/guide/docker-compose.md` | Target Compose documentation | Document the scaffold route and snippet |
| `docs/reference/api.md` | Published API | Add the scaffold route and state headers |
| `docs/reference/configuration.md` | Server configuration | Add an agent environment section |
| `docs/security/limitations.md` | Accepted residuals | Add agent residuals |

### Code Analysis

- `AgentCertificateResponse` returns `certificatePem`, `chainPem`, `identityId`, `serial`, and
  `notAfter`; it never returns the private key (`packages/api-contract/src/agents.ts:37-44`).
- The join response does not include `notBefore`, so the agent must parse the certificate PEM
  to compute the two-thirds renewal point from the actual `notBefore`/`notAfter` window.
- The server replay cache expires after five minutes (`apps/server/src/agent/agent-renew-service.ts:20-22`).
  The agent's pending key/CSR reuse must use the same window.
- The data route is registered on `/v1/data` and the agent middleware rejects every other
  route on the agent listener; a certificate request there receives 401 for a same-project
  agent and 403 for a project mismatch (RD-09 tests).
- `touchConsumer` currently runs `UPDATE consumers SET last_seen = now()` and ignores errors in
  the service (`apps/server/src/secrets/repository.ts:748-753`).
- `consumers` is unique on `principal_id` and checks `state IN ('ok', 'degraded', 'failed')`
  (`apps/server/src/database/schema.ts:239-248`).
- The scaffold needs an object id per entry; `SecretRepository.findActiveSecret` already
  returns the record by project and name (`apps/server/src/secrets/repository.ts:241-260`).
- The project and identity name-conflict paths already return stable 409 codes, and a disabled
  service identity name can be reused by a new active row because the unique index is partial
  (`apps/server/migrations/20261103141309_service-identities.up.sql:32`).
- The repository has no `apps/agent` package and no `ov-agent` binary.
- The repository has no scaffold route, Compose renderer, or manifest skeleton generator.
- A consumer state change is not audited; only join/renew classify `state` as a metadata change
  (`apps/server/src/agent/consumer-repository.ts:185-187`). There is no heartbeat route.
- The agent has no record of which output files a previous manifest delivered, so a removed
  entry would leave a stale file.

## Gaps Identified

### Gap 1: No workload-side agent

**Current Behavior:** The server can join and renew an identity, but no process generates the
key/CSR, stores the certificate, fetches secrets, writes files, refreshes, or exposes status.

**Required Behavior:** A deployable per-service agent that implements RD-10 end to end.

**Fix Required:** Add `apps/agent` with manifest/config/state, a real HTTPS client, join,
delivery, renewal, status, unix socket, wrapper mode, health, and tests.

### Gap 2: The consumer state cannot become degraded or failed through the fetch

**Current Behavior:** A successful agent read only moves `last_seen`; a missing or failed entry
cannot update `state`, and a state change is not audited.

**Required Behavior:** The fetch updates `last_seen` and an allowlisted state, a missing
required/optional entry is recorded as `failed`/`degraded`, a final heartbeat records the
aggregate, and a state change writes one `consumer.update` event.

**Fix Required:** Accept validated state and optional-entry headers on the agent data read,
add a `POST /v1/agent/consumer` heartbeat route, and add an `AgentConsumerService` that audits
state transitions.

### Gap 3: No scaffold workflow

**Current Behavior:** An operator would have to create a project, create an identity, find each
secret id, grant four assignments, and issue a token by hand.

**Required Behavior:** An idempotent scaffold that performs those steps, grants only
object-scope reader, and returns a safe Compose snippet plus manifest.

**Fix Required:** Add scaffold contracts, a service, a controller, a Compose renderer, and
integration tests.

### Gap 4: Removed manifest entries leave files behind

**Current Behavior:** The agent has no persistent record of the files it delivered.

**Required Behavior:** On restart, a file delivered from a previous manifest but absent from
the new manifest is removed.

**Fix Required:** Persist `managed-files.json` and reconcile it at startup.

### Gap 5: Documentation is target-state only

**Current Behavior:** The agent guide says the client is delivered in a later release; the
Compose guide is marked target documentation; the API reference has no scaffold route.

**Required Behavior:** Documentation matches the implemented agent and scaffold.

**Fix Required:** Update the agent, Compose, API, configuration, architecture, security, and
changelog documents and add a deployment example.

## Dependencies

### Internal Dependencies
- RD-05 join/renew services, consumer schema, replay window, and mTLS listener.
- RD-07 consumer-change audit and decision writer.
- RD-08 data route, secret lookup, project/identity/assignment services, and consumer table.
- RD-09 agent-listener denial for certificate routes.
- Existing config, transport, and integration-test helpers.

### External Dependencies
- Node.js 24.21.0 (`https`, `tls`, `fs`, `net`, WebCrypto).
- `yaml@2.9.1` for strict manifest parsing.
- `@peculiar/x509@3.1.0` for PKCS#10 CSR generation.
- `zod@4.6.7` and `@openvault/api-contract` for shared validation.
- PostgreSQL 16 and 17 for the server integration tests.
- Vitest, WebAFX, Biome, and TypeScript 7.0.2.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent writes a partial set during startup | Medium | High | Buffer every required value; write only after all required succeed (AR-12) |
| Refresh removes files on a transient failure | Medium | High | Exhaustive status mapping and tests for 5xx/network/TLS/401/403/404 (AR-11) |
| Renewal retry creates a second certificate | Medium | High | Persist the pending key/CSR and reuse it for the server's five-minute window (AR-10) |
| Manifest path or mode escapes the output directory | Low | High | Strict names, no `..`, no absolute paths, four modes, `0700` root (AR-6) |
| Agent logs a value or key | Low | High | Structured value-free logs and captured-log tests (AR-16) |
| Scaffold grants project-wide access | Low | High | Object-scope assignments only and a negative test (AR-19–AR-22) |
| Scaffold partially completes | Medium | Medium | Idempotent create-or-reuse and a documented retry; token issued last (AR-19–AR-22) |
| Consumer state lags after a network failure | Medium | Low | State converges on the next successful fetch; documented (AR-18) |
| New dependencies expand the supply chain | Low | Medium | Use already-pinned workspace libraries and `pnpm audit:prod` (AR-26) |

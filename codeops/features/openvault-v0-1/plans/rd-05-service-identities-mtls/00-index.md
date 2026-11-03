# RD-05 Service Identities and mTLS Implementation Plan

> **Feature**: Server-side service identities, one-time join tokens, internal CA signing, agent client certificates, renewal, revocation, and consumer registration.
> **Status**: Plan Preflighted
> **Created**: 2026-11-01 23:08
> **Preflight**: [00-preflight-report-RD-05.md](../../requirements/00-preflight-report-RD-05.md) — passed after re-scan
> **Plan Preflight**: [00-preflight-report.md](00-preflight-report.md) — passed after re-scan
> **Implements**: openvault-v0-1/RD-05
> **CodeOps Artifact Schema**: 1

## Overview

RD-05 replaces workload API keys with short-lived mTLS certificates. An administrator creates a
service identity owned by one project and issues a one-time join token. The agent submits an EC
P-256 CSR and consumer metadata. The server derives the certificate identity from the token, denies
CSR-controlled identity and extension fields, signs a fixed client-authentication profile with the
internal CA, and stores the certificate serial and fingerprint for later verification.

The plan also adds the narrow identity-authorization helper required before RD-06, the admin API
for creating, reading, listing, revoking, and issuing join tokens, and the agent-listener boundary
that protects every route except join. Revocation is one transaction over the principal,
certificates, unused tokens, and consumer row; the listener rechecks certificate, principal, and
project state per request with a cache bounded to five seconds.

RD-05 remains server-side. The agent runtime, certificate/key storage, renewal scheduling, and
refresh heartbeat belong to RD-10; the secret data handler belongs to RD-08; persisted audit
belongs to RD-07; CA generation, backup, restore, and KEK rotation belong to RD-11/RD-13. The plan
tests the boundary it owns, including a test-only data-route guard, and records the later-RD
assertions in [AR-21](00-ambiguity-register.md#cross-rd-acceptance-ownership).

## Minimum-Sufficient Baseline

**Original goal:** A service identity can join with a one-time token, use a short-lived mTLS
certificate, renew it, and be revoked quickly.

**Smallest viable design:** Extend the existing schema with a `ca_keys` row, one join-token
revocation column, and lifecycle indexes; add a small CA signer around the approved X.509 library;
add identity/admin, join/renew, consumer, middleware, rate-limit, and cleanup services; reuse the
existing WebAFX controllers, PostgreSQL transaction helper, keyring, logger, rate limiter, and
integration-test harness.

**Excluded machinery:** Agent runtime and tmpfs delivery (RD-10), the `/v1/data` secret handler
(RD-08), persisted audit (RD-07), `ov init`/backup/KEK rotation (RD-11/RD-13), the full RBAC
evaluator (RD-06), a new test runner or database harness, a queue, Redis, an HSM, an external CA,
and per-certificate revocation.

**Approved complexity:** The pinned `@peculiar/x509` dependency and its ASN.1/Reflect support are
approved under [AR-12](00-ambiguity-register.md#ar-12--x509-library). The `ca_keys` table and
`CaSigner` are direct feature code. No other larger support surface is planned.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and cross-RD ownership |
| PF | [Preflight Report](00-preflight-report.md) | Plan preflight findings and remediation rulings |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-05 and plan-local decisions |
| 02 | [Current State](02-current-state.md) | Existing schema, auth, transport, and test boundaries |
| 03-01 | [Contracts, Schema, and Identity Admin](03-01-contracts-schema-authorization.md) | API contracts, migration, narrow authorization, admin service/controller |
| 03-02 | [CA and X.509 Issuance](03-02-ca-x509-issuance.md) | `ca_keys`, `CaSigner`, CSR validation, fixed certificate profile, readiness |
| 03-03 | [Join, Renewal, and Consumer](03-03-join-renew-consumer.md) | Atomic token claim, join/renew transactions, replay, consumer writes, rate limits |
| 03-04 | [Agent Listener, Revocation, and Retention](03-04-agent-listener-revocation.md) | Listener options, agent middleware/cache, data-route guard, revoke, cleanup |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases, integration tests, and verification |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Usage Examples

```bash
# Create a project-owned service identity
curl -sS -X POST https://vault.example.com/v1/admin/identities \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"payments-api","projectId":"01J..."}'

# Issue a one-time join token
curl -sS -X POST https://vault.example.com/v1/admin/identities/$IDENTITY_ID/join-tokens \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"ttlSeconds":900}'

# Agent bootstrap; the CSR is a public-key proof only
curl -sS -X POST https://openvaultd:8444/v1/agent/join \
  -H 'Content-Type: application/json' \
  --data-binary @join-request.json

# Renew after two thirds of the certificate lifetime, using the current certificate
curl -sS -X POST https://openvaultd:8444/v1/agent/renew \
  --cert agent-cert.pem --key agent-key.pem \
  -H 'Content-Type: application/json' \
  --data-binary @renew-request.json

# Revoke the identity and all of its credentials
curl -sS -X POST https://vault.example.com/v1/admin/identities/$IDENTITY_ID/revoke \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Key Decisions

| Decision | Outcome | AR |
|---|---|---|
| Scope | Server-side RD-05; later-RD assertions stay with their owners | AR-1, AR-21 |
| Join listener | One port; only `POST /v1/agent/join` is unauthenticated; `/health` and all other agent-listener routes require a verified certificate; the listener is fail-closed without an authenticator | AR-2, AR-18, PF-001 |
| CA | P-256 self-signed 10-year CA; KEK-wrapped 32-byte scalar in `ca_keys`; `CaSigner` only | AR-3, AR-17 |
| X.509 | Pinned `@peculiar/x509` 3.1.0 + ASN.1 peer + `reflect-metadata`; no shell/custom ASN.1 | AR-12 |
| Identity source | Token identity; CSR is proof of possession only; fixed CN/SAN/CA/keyUsage/EKU | AR-4 |
| Phase boundary | Agent context, authenticator, middleware, and listener flip land before the join/renew controller; cache/revoke/retention/readiness follow | PF-001, PF-011 |
| Admin API | Create/list/get/revoke/join-token; scoped list; all retained certificates in detail; unique active names | AR-9, AR-19, AR-20, AR-23 |
| Authorization | Narrow `role_assignments` helper for `identity.*`; org/project scope; auditor read-only | AR-10 |
| Join token | 32 random bytes base64url; SHA-256 at rest; atomic claim; 15m default/24h max | AR-6, AR-7 |
| Renewal | Two thirds of actual lifetime; newest only; fresh key via peer-certificate SPKI hash; five-minute replay-first retry | AR-8, AR-24, PF-003 |
| Revocation | One transaction; per-request state check with ≤5s cache; no success after five seconds | AR-5 |
| Consumer | RD-05 owns join/renew writes; RD-08/RD-10 own fetch heartbeat/state | AR-13, AR-21 |
| Audit | Persisted audit assertion is RD-07 | AR-11 |
| Human credentials | Service principals rejected by local/OIDC/browser/CLI paths and database guards | AR-14 |
| Tests | Real PostgreSQL, real crypto, test-only seam injection, integration gate per phase, pre-prepare data probe | AR-22, AR-25, PF-002, PF-004, PF-008, PF-009, PF-010 |
| Runtime | One identity runtime owner, one logger, agent runtime disposal | PF-007 |
| Auth listeners | Browser/CLI resolvers skip the agent listener | PF-012 |

## Specialist Agents

| Role | Kind | Use | AR Ref |
|---|---|---|---|
| correctness-reviewer | reviewer | Every executed phase | — |
| security-auditor | reviewer | Phases 1–4: key wrapping, CSR profile, token atomicity, mTLS, revocation | — |
| concurrency-auditor | reviewer | Phases 1, 3, 4: migration, join/revoke locking, cache, replay | — |

**No project-specific specialist is proposed.** The capability-gap check found no durable project
invariant that a new role would carry better than the existing catalog roles plus a dynamic packet.

_Detection evidence: The repository already has `security-auditor`, `concurrency-auditor`, and
`correctness-reviewer` agents, and the work reuses their existing concerns: key wrapping in
`apps/server/src/security/signing-keys.ts`, principal locking in
`apps/server/src/auth/cli-sessions.ts`, and transport boundaries in
`apps/server/src/transport/secure-application.ts`. No repeated RD-05-specific finding pattern
exists yet._

## Related Files

**New server files**
- `packages/api-contract/src/identities.ts`
- `packages/api-contract/src/agents.ts`
- `apps/server/src/identity/identity-repository.ts`
- `apps/server/src/identity/identity-authorizer.ts`
- `apps/server/src/identity/identity-service.ts`
- `apps/server/src/agent/agent-authenticator.ts`
- `apps/server/src/agent/agent-token-service.ts`
- `apps/server/src/agent/agent-join-service.ts`
- `apps/server/src/agent/agent-renew-service.ts`
- `apps/server/src/agent/consumer-repository.ts`
- `apps/server/src/agent/agent-rate-limits.ts`
- `apps/server/src/agent/agent-maintenance.ts`
- `apps/server/src/agent/agent-middleware.ts`
- `apps/server/src/agent/project-resolver.ts`
- `apps/server/src/agent/agent-runtime.ts`
- `apps/server/src/identity/identity-runtime.ts`
- `apps/server/src/security/ca.ts`
- `apps/server/src/security/x509.ts`
- `apps/server/src/controllers/identity.ts`
- `apps/server/src/controllers/agent.ts`

**Modified server files**
- `apps/server/src/database/schema.ts`
- `apps/server/src/database/generated-types.ts`
- `apps/server/src/database/ctypes.ts`
- `apps/server/src/app.ts`
- `apps/server/src/main.ts`
- `apps/server/src/readiness/service.ts`
- `apps/server/src/transport/secure-application.ts`
- `apps/server/src/transport/scope.ts`
- `apps/server/src/types/express.d.ts`
- `apps/server/src/auth/credentials.ts`
- `apps/server/src/auth/oidc/identity.ts`
- `apps/server/src/auth/plugin.ts`
- `apps/server/src/auth/middleware.ts`
- `apps/server/src/auth/cli-sessions.ts`
- `apps/server/src/observability/logger.ts`
- `apps/server/package.json`
- `pnpm-lock.yaml`

**Tests and fixtures**
- `apps/server/tests/integration/helpers/agent-tls.ts`
- `apps/server/tests/integration/helpers/agent-runtime.ts`
- `apps/server/tests/integration/transport.spec.test.ts`
- `apps/server/tests/integration/*.spec.test.ts`
- `apps/server/tests/*.impl.test.ts`
- `packages/api-contract/tests/identities.spec.test.ts`
- `packages/api-contract/tests/agents.spec.test.ts`

**Documentation**
- `docs/reference/api.md`
- `docs/reference/configuration.md`
- `docs/reference/roles.md`
- `docs/architecture/identity.md`
- `docs/architecture/crypto.md`
- `docs/architecture/agent-delivery.md`
- `docs/guide/authentication.md`
- `docs/guide/agent.md`
- `docs/guide/rotation.md`
- `docs/guide/install.md`
- `docs/guide/backup-restore.md`
- `docs/security/limitations.md`

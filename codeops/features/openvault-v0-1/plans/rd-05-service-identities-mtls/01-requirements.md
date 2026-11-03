# Requirements: RD-05 Service Identities and mTLS

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-05](../../requirements/RD-05-service-identities-mtls.md) — the owning requirements document
> **Preflight**: [00-preflight-report-RD-05.md](../../requirements/00-preflight-report-RD-05.md)
> **Plan Preflight**: [00-preflight-report.md](00-preflight-report.md)

## Scope of this plan (delta view)

The RD is the owning requirements document. This page records only the plan boundary, the
plan-local decisions, and the later-RD handoffs.

### In this plan

- RD-05 Must Have: service identities and project ownership, admin lifecycle, narrow
  authorization, join tokens, join/renew, fixed certificate profile, CA signing, per-request
  agent checks, atomic revocation, consumer writes, rate limits, and retention. [AR-1–AR-15]
- RD-05 Should Have: admin detail with retained certificates and retry-safe renewal replay.
  [AR-8, AR-9, AR-20]
- Plan-local server mechanics: contracts, generated migration and manual guards, module split,
  CA row shape, scoped list/detail behavior, certificate backdating, test seams, and verification.
  [AR-16–AR-25]

### Deferred / out of this plan

- The agent runtime, certificate/key storage, renewal trigger, retry/backoff, and refresh heartbeat
  — RD-10; RD-05 owns only the server boundary. [AR-1, AR-13]
- The `/v1/data/:project/secrets/:name` secret handler — RD-08. This plan exposes only the agent
  listener scope and middleware that will protect it. [AR-1, AR-21]
- `ov init`, CA generation, backup, restore, re-materialization, and KEK rotation — RD-11/RD-13.
  The plan consumes a provisioned `ca_keys` row and uses a test fixture. [AR-1, AR-3]
- Persisted audit chain, audit events, and failed-join evidence — RD-07. [AR-11]
- Full RBAC evaluator, control-plane ceiling, assignments, grant guards, and access explanation —
  RD-06. RD-05 uses a narrow identity helper. [AR-10]
- Per-certificate revocation, identity re-enable, external mTLS CAs, OIDC client credentials, and
  static workload keys — RD-05 `Won't Have`; v0.2 or never in v0.1.

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Module layout and agent context | `identity/`, `agent/`, `security/ca.ts`, `controllers/identity.ts`, `controllers/agent.ts`; separate `req.agent` | AR-16 |
| CA row shape | Raw 65-byte uncompressed P-256 public point; 32-byte wrapped scalar; current/retired; one current row | AR-17 |
| Agent listener health | Only `POST /v1/agent/join` is unauthenticated; `/health` requires a verified certificate and live workload row | AR-18 |
| Admin list | Optional `projectId`; org-scoped readers see all, project-scoped readers see owned projects; supplied project must be covered | AR-19 |
| Admin detail | Every retained certificate, newest first, including revoked/expired | AR-20 |
| Certificate validity | `notBefore = now - 30s`; `notAfter = notBefore + OPENVAULT_CERT_TTL_DAYS` | AR-24 |
| Service names | Trim; reject control characters; 1–100 characters; case-sensitive | AR-23 |
| Test seams | Inject a test CA signer/agent authenticator for offline transport tests; real PostgreSQL for integration tests; test-only `/v1/data` probe | AR-22 |
| Verification | `pnpm verify` under Node 24.21.0 plus the integration gate against PostgreSQL 16 and 17 | AR-25, PF-002, PF-010 |
| Migration source | Edit `schema.ts`; generate the incremental migration; regenerate types/snapshot; add a reviewed manual trigger migration | AR-16, AR-17 |
| Preflight corrections | All 16 plan-preflight findings resolved with the accepted recommendations: Phase 3 fail-closed agent boundary, integration gates, fresh-key enforcement, project-id data guard, token lock/createdBy, kind guards, one runtime/logger/dispose, existing-test updates, CA seams, PG matrix, admission-time guarantee plus RD-08 recheck, listener-aware auth, and minor consistency fixes | PF-001–PF-016 |

## Acceptance mapping

The RD owns the detailed acceptance criteria. This table records who executes each clause.

| RD-05 acceptance | This plan | Later owner |
|---|---|---|
| 1 — create/ownership/no human credentials | Full | — |
| 2 — admin authorization and read scope | Full except the full control-plane ceiling | RD-06 acceptance 4 |
| 3 — one-time token, atomic claim, inactive/non-project cases, 401 | Full, excluding persisted audit | RD-07 audit evidence |
| 4 — fixed certificate profile and stored metadata | Full | — |
| 5 — CSR negative profile | Full | — |
| 6 — agent listener join exception and protected routes | Full, including `/health` and a test-only `/v1/data` probe | RD-08 real data handler |
| 7 — atomic revoke and admission-time five-second bound | Full admission-time boundary; RD-08 must revalidate before sending a secret | RD-08 pre-send recheck |
| 8 — renewal threshold, newest-only, replay, expired recovery | Full server side | RD-10 agent trigger/retry |
| 9 — consumer join/renew and fetch state | Join/renew writes and data-route guard; the test probe does not update state | RD-08/RD-10 fetch heartbeat |
| 10 — CA row, readiness sign/verify, init idempotence, restore | CA row/load/sign and conditional `/ready` probe | RD-13 `ov init`, backup, restore, re-wrap |
| 11 — join/renew rate limits | Full | — |
| 12 — retention and cleanup | Full | — |
| 13 — log/error redaction | Full | — |
| 14 — security verification | Full server boundary | RD-14 independent verification |

## Plan-local acceptance criteria

1. [ ] `pnpm verify` passes under Node 24.21.0, and the integration gate passes with the
   disposable PostgreSQL database.
2. [ ] The migration ledger applies cleanly on PostgreSQL 16 and 17; `pnpm db:types:check` reports no drift.
3. [ ] The integration suite covers contracts, migrations, identity admin, CA/CSR, the fail-closed
   agent boundary, join/renew, revocation, retention, and captured logs against real PostgreSQL.
4. [ ] The existing transport, transport.impl, local auth, OIDC, CLI, readiness, test-app, schema,
   and logging suites remain green.
5. [ ] No execution-plan, requirement, or ambiguity identifier appears in shipped code or documentation comments.
6. [ ] Documentation reflects the final CA row, agent listener, join/renew, renewal, revoke,
   consumer, rate-limit, and retention behavior.

> **Traceability:** Every plan-local decision above cites its owning
> [Ambiguity Register](00-ambiguity-register.md) entry or the plan
> [preflight report](00-preflight-report.md). RD-05 owns the functional and security acceptance
> criteria; later-RD clauses are listed in [AR-21](00-ambiguity-register.md#cross-rd-acceptance-ownership).

## Ambiguity Register: RD-05 Service Identities and mTLS Plan

> **Status**: ✅ GATE PASSED — all 25 items resolved
> **Last Updated**: 2026-11-01 23:08
> **Mode**: make-plan (normal mode)
> **Source**: [RD-05](../../requirements/RD-05-service-identities-mtls.md) and its passed [preflight report](../../requirements/00-preflight-report-RD-05.md)

The preflighted RD-05 decisions are imported as resolved context and are not re-litigated.
`AR-1` through `AR-15` are the imported decisions. `AR-16` through `AR-25` are the plan-local
choices the user confirmed in the planning interview.

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|---|---|---|---|---|
| AR-1 | Scope | Whether the plan implements the server-side RD-05 only or also the agent runtime, persisted audit, and CA init/backup | A: server-side RD-05; RD-10/RD-07/RD-11/RD-13 own their work / B: pull those later RDs forward | User accepted preflight PF-001/PF-011/PF-013 and RD-05 Integration Points: server-side only | ✅ Resolved |
| AR-2 | Security | How a new agent reaches join while the agent listener is mTLS for every other route | A: optional certificate on 8444 plus default-deny middleware / B: dedicated join port / C: admin listener | User accepted preflight PF-001 Option B | ✅ Resolved |
| AR-3 | Data & state | Where the CA private key lives and how it is used | A: KEK-wrapped `ca_keys` row plus `CaSigner` / B: CA key file / C: keyring extension | User accepted preflight PF-002 Option A; `ov init`/RD-13 provision the row | ✅ Resolved |
| AR-4 | Security | Whether the CSR controls the issued identity or only proves key possession | A: token-derived fixed profile / B: exact-match CSR / C: sign CSR as-is | User accepted preflight PF-003 Option A | ✅ Resolved |
| AR-5 | Security | Revocation and renewal semantics for disabled identities and old certificates | A: atomic identity revoke plus per-request status checks / B: status-only / C: per-certificate revoke | User accepted preflight PF-004 and PF-005 Option A | ✅ Resolved |
| AR-6 | Concurrency | How one join token is consumed and how the wrong-project case is tested | A: atomic conditional claim plus issuance-side project check / B: explicit project claim / C: application mutex | User accepted preflight PF-006 Option A | ✅ Resolved |
| AR-7 | Behavioral | Certificate lifetime and renewal threshold source | A: `OPENVAULT_CERT_TTL_DAYS`, two thirds of the actual lifetime / B: fixed 30/20 days | User accepted preflight PF-007 Option A | ✅ Resolved |
| AR-8 | Behavioral | Which certificate may renew and how a lost response is recovered | A: newest only, fresh key, five-minute replay / B: any valid certificate / C: reuse key | User accepted preflight PF-008 Option A | ✅ Resolved |
| AR-9 | Integration | Admin identity routes, response shapes, and idempotent service names | A: full create/list/get/revoke/join-token contract plus partial unique name index / B: only token/revoke | User accepted preflight PF-009 Option A | ✅ Resolved |
| AR-10 | Security | How RD-05 authorizes admin identity routes before RD-06 exists | A: narrow identity helper backed by `role_assignments` / B: split RD-06 / C: hardcode | User accepted preflight PF-010 Option A | ✅ Resolved |
| AR-11 | Integration | Where persisted audit evidence is verified | A: audit port in RD-05 / B: move the assertion to RD-07 | User accepted preflight PF-011 Option B | ✅ Resolved |
| AR-12 | Technical | Which X.509 library performs CSR verification and certificate issuance | A: pinned `@peculiar/x509` / B: `node-forge` / C: OpenSSL / D: custom ASN.1 | User accepted preflight PF-012 Option A; Complexity Gate Justified and directly approved | ✅ Resolved |
| AR-13 | Integration | Consumer metadata ownership and the agent data-plane route | A: RD-05 join/renew plus RD-10/RD-08 fetch; reuse `/v1/data/:project/secrets/:name` / B: new consumer route | User accepted preflight PF-013 Option A | ✅ Resolved |
| AR-14 | Security | Whether a service principal can receive human credentials | A: schema/service guards and login rejection / B: rely on RD-06 | User accepted preflight PF-015 Option A | ✅ Resolved |
| AR-15 | Data & state | Join-token and workload-certificate retention | A: 24h tokens, 30d certificates, daily cleanup / B: keep forever | User accepted preflight PF-016 Option A | ✅ Resolved |
| AR-16 | Technical | Where the new server code lives and how the agent request context is represented | A: `identity/`, `agent/`, `security/ca.ts`, `controllers/identity.ts`, `controllers/agent.ts`; separate `req.agent` / B: extend the browser/CLI `AuthContext` union / C: put everything in existing auth files | User accepted the recommended technical defaults: separate `req.agent`, `identity/`, `agent/`, `security/ca.ts`, `controllers/identity.ts`, and `controllers/agent.ts` | ✅ Resolved |
| AR-17 | Data & state | Exact `ca_keys` column representations and lifecycle | A: raw 65-byte uncompressed P-256 public point, 32-byte wrapped scalar, `current`/`retired` status, one current row / B: SPKI DER public key and current-only status | User accepted the recommended technical defaults: raw 65-byte point, 32-byte wrapped scalar, `current`/`retired`, one current row | ✅ Resolved |
| AR-18 | Behavioral | Whether `/health` on the agent listener requires a client certificate like every other non-join route | A: protect `/health` too; existing transport tests adapt / B: exempt `/health` as liveness only | User accepted the plan question: only `/v1/agent/join` is unauthenticated; `/health` and every other agent-listener route require a verified certificate | ✅ Resolved |
| AR-19 | Behavioral | Scope and filtering of `GET /v1/admin/identities` | A: optional `projectId`; org-scoped reads list all, project-scoped reads list owned; supplied project must be covered / B: require `projectId` on every list | User accepted the plan question: optional `projectId` with scope-aware filtering | ✅ Resolved |
| AR-20 | Behavioral | Which certificates `GET /v1/admin/identities/:id` returns | A: every retained certificate, newest first, including revoked/expired / B: only unexpired, unrevoked certificates | User accepted the plan question: every retained certificate, newest first | ✅ Resolved |
| AR-21 | Scope | Which RD-05 acceptance assertions this plan can execute before RD-08/RD-10/RD-13 exist | A: named deferral: RD-05 tests join/renew/consumer writes, middleware, CA signer/readiness, revoke; RD-08/RD-10/RD-13 own fetch-state, agent runtime, init/backup assertions / B: pull those later RDs into this plan | User accepted the plan question: server-side plan; later-RD assertions remain with RD-08/RD-10/RD-13 | ✅ Resolved |
| AR-22 | Technical | How the agent middleware is tested without a production data route while keeping existing offline transport tests | A: add test-only CA signer/agent-authenticator seams and a test-only `/v1/data` probe; real integration tests use PostgreSQL / B: require a live database for every transport test / C: skip `/v1/data` guard tests until RD-08 | User accepted the recommended technical defaults: test-only seams plus a `/v1/data` probe; real integration tests use PostgreSQL | ✅ Resolved |
| AR-23 | Behavioral | Service-identity name validation beyond the table's 1–100 character bound | A: trim, reject control characters, 1–100 characters, case-sensitive / B: require the project slug pattern / C: accept the database bound only | User accepted the recommended technical defaults: trim, reject control characters, 1–100 characters, case-sensitive | ✅ Resolved |
| AR-24 | Technical | Certificate `notBefore` anchoring to tolerate clock skew | A: backdate 30 seconds and keep the configured total lifetime / B: use exact current time | User accepted the recommended technical defaults: backdate 30 seconds; total lifetime remains the configured TTL | ✅ Resolved |
| AR-25 | Standards | Whether the project verification command is `pnpm verify` for every task | A: `pnpm verify` / B: another command | User accepted the plan question: `pnpm verify` | ✅ Resolved |

## Resolution Notes

### Imported decisions

- **AR-1:** RD-05 is server-side. RD-10 owns the agent runtime and refresh loop; RD-07 owns the persisted audit chain; RD-11/RD-13 own `ov init`, CA generation, backup, restore, and KEK rotation. RD-08 owns the data-plane secret handler.
- **AR-2:** The agent listener keeps one port. It sets `requestCert: true` and `rejectUnauthorized: false`; middleware authenticates every non-join route. The join route is token-authenticated and rate-limited.
- **AR-3:** `ca_keys` stores the CA private key as a KEK-wrapped 32-byte P-256 scalar. A `CaSigner` verifies the matching public certificate and exposes signing only. Readiness signs and verifies a probe certificate.
- **AR-4:** The join token is the identity source. The CSR is a public-key proof only. The server builds CN, SAN, basic constraints, key usage, and EKU from the token.
- **AR-5:** Identity revoke is one transaction over principal, certificates, join tokens, and consumer. The agent listener checks certificate, principal, and project state per request with a five-second cache.
- **AR-6:** The token is 32 random bytes as base64url; the database stores SHA-256. A conditional update claims it atomically. A malformed CSR is rejected before the claim.
- **AR-7:** The configured certificate lifetime is authoritative. Renewal opens at two thirds of the issued `not_before`/`not_after` window.
- **AR-8:** The newest unexpired, unrevoked certificate may renew with a fresh P-256 key and CSR. A five-minute process-local replay cache returns the same response for the same public key.
- **AR-9:** The admin surface is create, scoped list, detail, idempotent revoke, and join-token creation. The partial unique index covers active service names per project.
- **AR-10:** The helper checks `role_assignments` for the four `identity.*` actions. Org-scoped assignments cover all identities; project-scoped assignments cover owned identities; `auditor` is read-only.
- **AR-11:** RD-05 does not claim persisted audit. RD-07 records `identity.create`, `identity.revoke`, `identity.join_token`, `agent.join`, `agent.renew`, and consumer metadata changes.
- **AR-12:** Production uses pinned `@peculiar/x509` 3.1.0, its ASN.1 peer, and `reflect-metadata`, behind a thin module. It never shells out or implements ASN.1.
- **AR-13:** RD-05 owns join/renew consumer writes. RD-10/RD-08 own the fetch heartbeat/state on the existing data route.
- **AR-14:** Service principals are rejected by local, OIDC, browser, and CLI credential paths; database guards prevent inserting human credentials for them.
- **AR-15:** Join tokens are deleted 24 hours after expiry/use. Certificates are deleted 30 days after expiry, or after the later of expiry and revocation. Cleanup is daily and bounded.

### AR-12 — X.509 library

The plan uses the preflight-approved pinned `@peculiar/x509@3.1.0`, its ASN.1 peer, and
`reflect-metadata` behind the single production X.509 boundary. The package is not a general PKI
framework and does not add a shell or in-repo ASN.1 implementation. See the AR-12 table row.

## Plan-local decisions

- **AR-16:** Use separate agent context and module boundaries.
- **AR-17:** Use the compact raw-point CA row with current/retired lifecycle.
- **AR-18:** Protect agent `/health`; only join is unauthenticated.
- **AR-19:** List is optional-project scoped.
- **AR-20:** Detail returns all retained certificates.
- **AR-21:** Later-RD assertions stay with RD-08/RD-10/RD-13.
- **AR-22:** Use test-only seam injection and a test-only data probe.
- **AR-23:** Use trimmed 1–100 character service names.
- **AR-24:** Backdate certificate `notBefore` by 30 seconds.
- **AR-25:** Use `pnpm verify`.

## Cross-RD acceptance ownership

The following RD-05 acceptance clauses are exercised by later plans, not this one:

- RD-05 acceptance 7 pre-send data delivery check: RD-08 must call the cache-bypassing
  `revalidate()` before sending a secret.
- RD-05 acceptance 8 agent renewal trigger/retry: RD-10.
- RD-05 acceptance 9 data-fetch heartbeat/state: RD-08/RD-10.
- RD-05 acceptance 10 `ov init` and restore/KEK-rewrap clauses: RD-13.
- RD-05 acceptance 3 failed-join audit persistence: RD-07.
- RD-05 acceptance 2 control-plane ceiling: RD-06.

This plan still tests the RD-05 boundary that enables those clauses: token/profile/consumer writes,
agent middleware and data-route guard, CA signer/readiness, revoke, and the local cache.

# Testing Strategy: RD-05 Service Identities and mTLS

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| CA wrapping, CSR validation, certificate issuance | 95% |
| Join/renew transactions and atomic token claim | 95% |
| Identity authorization and admin API | 90% |
| Agent listener, authenticator cache, revocation | 90% |
| Contracts, migrations, and cleanup | 90% |
| Documentation and reference accuracy | docs build + link check |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL through the disposable-database helper, real HTTPS, real
  Node/WebCrypto, and real `@peculiar/x509` code. There are no database or crypto mocks.
- The agent binary is not part of RD-05. HTTP-level tests cover the complete server boundary; the
  agent runtime and local files remain RD-10.
- Test-only seams are permitted only for offline listener tests; production wiring must use the
  real CA signer, authenticator, repositories, and database.
- In-code traceability comments quote the behavior in plain language. They never include an `ST-`
  id, an RD id, a plan path, or a requirements path.

## 🚨 Specification Test Cases

> These cases derive from RD-05, the preflight decision record, the component specifications, and
> the Ambiguity Register. Expectations are fixed before implementation. If implementation and a
> spec case disagree, the implementation is wrong.

### Contracts

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Parse a valid identity create body `{name:" payments-api ", projectId:ULID}` | Schema accepts; name trims to `payments-api`; response type has no password, email, or credential field | RD-05 AC-1; AR-9, AR-23 |
| ST-2 | Add `email`, `password`, or `kind` to identity create; add an unknown field to list/detail/token contracts | Strict schemas reject the input with 400 `validation_error` | RD-05 admin API; AR-9 |
| ST-3 | Names: empty, whitespace, 100 chars, 101 chars, control character, Unicode text, two names differing only by case | Empty/whitespace/control/101 rejected; 100 and Unicode accepted; case-sensitive names are distinct | RD-05 AC-1; AR-23 |
| ST-4 | List query absent, `projectId=ULID`, malformed project id, unknown query field | Optional valid ULID accepted; malformed/unknown rejected with 400 `validation_error` | RD-05 admin API; AR-19 |
| ST-5 | Join-token contract absent, integer, fractional | Absent/integer accepted; fractional rejected by the contract with 400 | RD-05 join token; AR-6 |
| ST-84 | Join-token service TTL `0`, `86401`, `1`, `86400` | 0/86401 return 422; 1/86400 accepted; absent uses config | RD-05 join token; AR-6 |
| ST-6 | Join contract with valid token/consumer/CSR, unknown consumer field, missing CSR | Valid accepted; missing/unknown fields rejected | RD-05 agent API; AR-4, AR-6 |
| ST-85 | Join service with an in-bound 42- or 44-character token; empty/129-character envelope | 42/44 return 401 `join_failed`; empty/129 fail the contract with 400; no certificate | RD-05 agent API; AR-6 |
| ST-7 | Renew request with CSR and consumer, missing consumer, unknown field; agent certificate response | Valid accepted; missing/unknown rejected; response has certificate/chain/identity/serial/notAfter and no private key | RD-05 agent API; AR-8 |
| ST-8 | Deserialize identity list/detail | No token/hash/private key row fields exist; `selfReported` is literal `true` in consumer detail | RD-05 AC-9; AR-13, AR-20 |

### Schema, migration, and human-credential guards

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-9 | Apply migrations to an empty database | `ca_keys` exists with the documented columns and checks; `join_tokens.revoked_at` exists; all prior tables remain | RD-05 schema additions; AR-3, AR-17 |
| ST-10 | Inspect indexes and constraints | One current CA row; `join_tokens.expires_at` and `workload_certs.not_after` indexes; active service-name partial unique index | RD-05 schema additions; AR-15, AR-17, AR-23 |
| ST-11 | Insert current/current, current/retired, retired without `retired_at`, and a malformed key-length CA row | Only one current is allowed; retired rows require `retired_at`; key lengths are enforced | RD-05 AC-10; AR-17 |
| ST-12 | Insert two active service identities with the same project/name; revoke one and insert the name again | Active duplicate rejected; revoked name can be reused | RD-05 AC-1; AR-9, AR-23 |
| ST-13 | Insert `local_credentials`, `oidc_identities`, or `cli_sessions` for a service principal | Each insert fails with a check/trigger error; user principals still succeed | RD-05 AC-1; AR-14 |
| ST-14 | Insert a local credential for a user, then change the principal to service | Update path is guarded or rejected; no service principal gains a credential | RD-05 AC-1; AR-14 |
| ST-82 | Service principal with a legacy browser session, CLI family, or OIDC linkage | Browser status, CLI active-context, and OIDC lookup reject it; no human context is attached | RD-05 AC-1; AR-14 |
| ST-15 | Run `pnpm db:types:check` after migration | Generated row types and CType constants include `ca_keys` and the new columns; no drift | RD-05 technical; AR-17 |
| ST-16 | Apply the ledger on one PostgreSQL version in Phase 1 | Migration count and public table count match the reviewed snapshot; cross-version matrix is ST-83 | RD-05 technical; AR-25 |

### Identity administration and authorization

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-17 | Org admin creates a valid service identity | 201 summary; `principals` row has `kind='service'`, owner project, active status; no email/credential | RD-05 AC-1; AR-9 |
| ST-18 | Create with missing project, unknown project, or soft-deleted project | 422 `validation_error`; no principal row | RD-05 AC-1; AR-9 |
| ST-19 | Create a duplicate active service name in the same project | 409 `identity_name_conflict`; no second active row | RD-05 AC-1; AR-9 |
| ST-20 | Project-scoped `project.admin` creates in owned project and in another project | Owned 201; other 403 `access_denied` | RD-05 AC-2; AR-10 |
| ST-21 | Org-scoped `project.admin` creates/reads/revokes across projects | Allowed on every project | RD-05 AC-2; AR-10 |
| ST-22 | `auditor` lists/reads but attempts create/revoke/join-token | Reads allowed at scope; writes 403 | RD-05 AC-2; AR-10 |
| ST-23 | List with no project as org reader, project reader, org-scoped project.admin, and auditor | Org readers see all; project readers see owned only; empty set returns `{identities:[]}` | RD-05 AC-2; AR-19 |
| ST-24 | List with a `projectId` the caller does not cover | 403 `access_denied`; no rows from that project | RD-05 AC-2; AR-19 |
| ST-25 | Detail an identity with active, revoked, and expired certificates plus a consumer | 200; certificates newest first, including revoked/expired; consumer `selfReported:true` | RD-05 AC-9; AR-20 |
| ST-26 | Detail/revoke/token a foreign or unknown identity; malformed path id | 404 `identity_not_found`; no data or mutation | RD-05 AC-2; AR-19 |
| ST-27 | Revoke an identity | 204; principal disabled; every unexpired certificate revoked; every unused token revoked; consumer failed; one transaction | RD-05 AC-7; AR-5 |
| ST-28 | Revoke the same identity twice; revoke a foreign identity | Second 204; foreign 404 and no changes | RD-05 AC-7; AR-9 |
| ST-29 | Issue a join token for an active identity, disabled identity, soft-deleted project; race issuance with revoke | Active 201 with token once; disabled/deleted 409 `identity_inactive`; no token row on rejection; concurrent issue/revoke leaves no live unused token after both | RD-05 AC-3/7; AR-6 |
| ST-30 | Read identity list/detail after token issuance | No raw token, hash, or credential field is exposed | RD-05 AC-3; AR-9 |

### CA and X.509

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-31 | Wrap a 32-byte CA scalar with KEK `k1`; unwrap; retry with wrong AAD, wrong KEK, flipped tag, or truncated scalar | Round trip returns scalar; every failure throws without plaintext | RD-05 AC-10; AR-3, AR-17 |
| ST-32 | Load a matching `ca_keys` row | Signer loads; public point, CA certificate, and private key match; no raw scalar escapes | RD-05 AC-10; AR-3 |
| ST-33 | Load with missing current row, wrong point, mismatched `cert_pem`, or unwrap failure; attempt a second current row | Startup/signer fails closed; the unique current index rejects the second row; error contains no key bytes | RD-05 AC-10; AR-3, AR-17 |
| ST-34 | Parse a valid P-256 CSR with an arbitrary, empty, or whitespace-only subject | Accepted; subject ignored; proof verified; public-key hash returned | RD-05 AC-4/5; AR-4 |
| ST-35 | Parse malformed PEM/DER and a CSR with a modified signature | 422 validation; no certificate; no token consumption | RD-05 AC-5; AR-4 |
| ST-36 | Parse RSA, P-384, and non-EC public keys | 422 validation; no certificate | RD-05 AC-5; AR-4 |
| ST-37 | CSR with SAN, basicConstraints, keyUsage, EKU, or an unknown extension | 422 validation; no certificate; no token consumption | RD-05 AC-5; AR-4 |
| ST-38 | Issue a certificate with default TTL | CN=principal, one URI SAN, CA:FALSE, digitalSignature, clientAuth, serial hex, SHA-256 DER fingerprint, CA-valid; no private key in response | RD-05 AC-4; AR-4, AR-24 |
| ST-39 | Issue with TTL 1, 30, and 90; inspect `notBefore`/`notAfter` | `notBefore` is 30s before issue; total validity equals TTL; renewal threshold is two thirds of actual window | RD-05 AC-4/8; AR-7, AR-24 |
| ST-40 | Force a serial collision three times | Bounded retry; then `ca_unavailable`/503; no certificate with wrong profile | RD-05 AC-4; AR-3, AR-4 |
| ST-41 | Run `CaSigner.probe()` with a valid loaded signer and a deliberately failing probe double | Valid probe succeeds; failing double fails; load failure is tested with a corrupted row before load | RD-05 AC-10; AR-3 |
| ST-79 | Call `/ready` with a runtime CA probe that fails | 503 `not_ready`; probe logs `ca`; admin-only app without the runtime keeps the existing readiness behavior | RD-05 AC-10; AR-3 |
| ST-42 | Capture logs/errors during wrap, load, CSR, issue, and probe failure | No scalar, JWK `d`, wrapped bytes, CSR body, private key, or CA key appears | RD-05 AC-13; AR-3, AR-12 |

### Join tokens and join

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-43 | Issue a default token and inspect storage/response | 15-minute expiry; 32-byte SHA-256 hash; 43-character base64url raw returned once; raw absent from DB | RD-05 AC-3; AR-6 |
| ST-44 | Join with a valid token and CSR | 200 certificate/chain/identity/serial/notAfter; one `used_at`; one certificate row; one consumer; no private key | RD-05 AC-3/4; AR-4, AR-6 |
| ST-45 | Two concurrent joins with one token | Exactly one 200, one 401, one certificate row, one consumer row | RD-05 AC-3; AR-6 |
| ST-46 | Join with unknown, expired, used, revoked, or inactive token | Same 401 `join_failed`; no certificate/consumer; no token leak | RD-05 AC-3; AR-6 |
| ST-47 | Join for a disabled principal or soft-deleted project | 401 `join_failed`; no certificate; token not usable | RD-05 AC-3; AR-5, AR-6 |
| ST-48 | Join with a malformed CSR using a valid token | 422; token remains unused; no certificate | RD-05 AC-5; AR-4 |
| ST-49 | CA signer fails during join | Transaction rolls back; token remains unused; no certificate/consumer; 503 | RD-05 AC-3; AR-3, AR-6 |
| ST-50 | Join races a revoke | Either join commits then revoke removes the certificate, or revoke commits and join returns 401; never an unrevoked cert/`ok` consumer | RD-05 AC-7; AR-5, AR-6 |
| ST-51 | Join twice with two tokens for the same identity and different metadata | One consumer row; `first_seen` preserved; metadata/lastSeen updated; no duplicate | RD-05 AC-9; AR-13 |
| ST-52 | Join with unknown field, principal/project override, invalid metadata, or too-long hostname | 422; server-derived principal/project unchanged; no certificate | RD-05 AC-9; AR-13 |
| ST-53 | 11th join in one minute from one source IP | 429 `RATE_LIMIT_EXCEEDED`; no expensive CSR/CA work | RD-05 AC-11; AR-15 |

### Renewal, consumer, and rate limits

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-54 | Renew before two thirds of actual lifetime | 409 `renewal_not_due`; no new certificate | RD-05 AC-8; AR-7, AR-8 |
| ST-55 | Renew at/after two thirds with a fresh CSR/key | 200; new certificate has configured TTL; old remains unrevoked but cannot renew | RD-05 AC-8; AR-8 |
| ST-56 | Renew from an older valid certificate | 409 `renewal_not_current`; no new certificate | RD-05 AC-8; AR-8 |
| ST-57 | Renew with the same public key after a simulated lost response, inside five minutes, authenticating with the previously issued certificate | Same certificate response; no second `workload_certs` row | RD-05 AC-8; AR-8 |
| ST-58 | Retry the same public key after five minutes or after a process restart | Cache miss; old certificate cannot renew; 409; rejoin required | RD-05 AC-8; AR-8 |
| ST-59 | Attempt renew with an expired certificate | TLS/middleware 401; no controller access; new join token required | RD-05 AC-6/8; AR-5 |
| ST-60 | Renew with non-default `OPENVAULT_CERT_TTL_DAYS` (1, 90) | Renewal threshold derives from the actual window; default 30 behavior unchanged | RD-05 AC-8; AR-7 |
| ST-61 | Renew updates consumer metadata | `last_seen` moves; `first_seen` preserved; state `ok`; no duplicate | RD-05 AC-9; AR-13 |
| ST-62 | 11th renew for one principal; 61st renew across principals from one IP | 429; principal bucket does not reset on rotation; IP bucket reaches 60 | RD-05 AC-11; AR-15 |
| ST-63 | Renew after revoke/disable/soft-delete | 401 at middleware; no certificate; no cache fallback | RD-05 AC-7; AR-5 |
| ST-64 | Renew with a CSR key equal to the authenticating certificate key outside the replay window, or a malformed CSR | 422; no certificate; token/certificate state unchanged; inside the replay window the same key returns the cached response | RD-05 AC-5/8; AR-4, AR-8 |

### Agent listener, revocation, and retention

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-65 | Join request without a client certificate; protected `/health` without a certificate | Join reaches the token path; `/health` returns 401 `authentication_required` | RD-05 AC-6; AR-2, AR-18 |
| ST-66 | Untrusted, expired, self-signed, or unknown-fingerprint certificate on a protected path | 401; no route handler; no secret read | RD-05 AC-6; AR-5, AR-18 |
| ST-67 | Trusted certificate with a live workload row on `/health` | 200; authenticator attaches identity/project/certificate context | RD-05 AC-6; AR-18 |
| ST-68 | Trusted certificate with revoked cert, disabled principal, or soft-deleted project | 401; no context; no data | RD-05 AC-6; AR-5, AR-18 |
| ST-69 | Database/cache failure during agent authentication | 503; fail closed; no route handler | RD-05 AC-6; AR-5, AR-18 |
| ST-70 | Pre-prepare test-only data route on the real agent listener with matching project, wrong project, soft-deleted path project, and no certificate | Matching 200; wrong/soft-deleted 403 `access_denied`; missing 401; no production data handler is added | RD-05 AC-6/9; AR-13, AR-22 |
| ST-71 | Admin path on agent listener; agent path on admin listener | Scope 404 before auth; no cross-listener route | RD-05 AC-6; AR-2 |
| ST-72 | Authenticator cache: repeat request within five seconds, revoke in same process, revoke in another process, new certificate | One DB read in the window; local invalidation immediate; other process expires within five seconds; new cert accepted immediately | RD-05 AC-7; AR-5 |
| ST-73 | Revoke identity, then use a new connection, a reused keep-alive connection, and renew | All fail 401 within five seconds; consumer failed; no unrevoked certificate | RD-05 AC-7; AR-5 |
| ST-74 | Concurrent join/revoke and concurrent revoke/revoke | No unrevoked cert, no `ok` consumer, one consistent final state; revoke idempotent | RD-05 AC-7; AR-5, AR-6 |
| ST-75 | Token/certificate cleanup at exact boundaries and after a post-expiry revoke | Tokens 24h; certs 30d after later of expiry/revoke; bounded batches; no live cert deleted | RD-05 AC-12; AR-15 |
| ST-76 | Startup with missing/mismatched CA; `/ready` with failed sign probe | Startup aborts; readiness 503 `not_ready`; agent listener does not bind | RD-05 AC-10; AR-3 |
| ST-77 | Production wiring versus test overrides | Production uses real CA/auth/DB; test-only authenticator/CA seam never appears in `main.ts` | RD-05 security; AR-22 |
| ST-78 | Captured logs and error envelopes from join, renew, revoke, malformed CSR, and auth failures | No raw token, token hash, CSR, private key, CA key, or secret; only stable codes/messages | RD-05 AC-13; AR-12 |
| ST-80 | Browser cookie and CLI bearer on the agent listener | Browser/CLI resolution is skipped; no `req.auth` is attached; agent routes still require `req.agent` | RD-05 AC-6; AR-18 |
| ST-81 | Test-only data route sleeps past five seconds, is revoked during the wait, then calls `revalidate()` before sending | Revalidation fails; no secret is sent; admission-time guarantee is honest | RD-05 AC-7; AR-5 |
| ST-83 | Apply the migration ledger on PostgreSQL 16 and 17 in Phase 5 | Both apply cleanly; integration suite passes on both; `pnpm db:types:check` reports no drift on both | RD-05 technical/AC-10; AR-25 |

## Test Categories

### Specification Tests

| Test file | ST cases | Component |
|---|---|---|
| `packages/api-contract/tests/identities.spec.test.ts` | ST-1–ST-5, ST-8 | Identity contracts |
| `packages/api-contract/tests/agents.spec.test.ts` | ST-6–ST-7 | Agent contracts |
| `apps/server/tests/integration/schema-identity.spec.test.ts` | ST-9–ST-16 | Schema/migration/guards |
| `apps/server/tests/integration/schema.spec.test.ts` | Existing table/constraint/index regression | Schema |
| `apps/server/tests/integration/migrations.spec.test.ts` | Existing migration ledger regression | Migration |
| `apps/server/tests/integration/service-principals.spec.test.ts` | ST-82 | Human-credential read-path guards |
| `apps/server/tests/integration/identity-admin.spec.test.ts` | ST-17–ST-30, ST-84 | Admin API/authorization/TTL status |
| `apps/server/tests/integration/ca-x509.spec.test.ts` | ST-31–ST-42 | CA/CSR/issuance |
| `apps/server/tests/integration/agent-join.spec.test.ts` | ST-43–ST-53, ST-65–ST-68, ST-85 | Tokens/join/basic agent auth/token status |
| `apps/server/tests/integration/agent-renew.spec.test.ts` | ST-54–ST-64 | Renewal/consumer/rates |
| `apps/server/tests/integration/agent-listener.spec.test.ts` | ST-69–ST-74, ST-80 | Cache/revocation/data guard/mixed credentials |
| `apps/server/tests/integration/agent-retention.spec.test.ts` | ST-75–ST-77, ST-79, ST-81 | Retention/readiness/delivery bound |
| `apps/server/tests/integration/agent-logging.spec.test.ts` | ST-78 | Captured-log redaction (Phase 5) |

### Implementation Tests

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/integration/security/ca.impl.test.ts` | Wrap AAD, key lengths, public-point parsing, load errors, probe, zero/redaction boundaries | High |
| `apps/server/tests/agent/csr.impl.test.ts` | DER/PEM, signature, curve, extension, resource-limit, and serial edges | High |
| `apps/server/tests/integration/identity/authorization.impl.test.ts` | Scope combinations, expiry, service actors, list filters | High |
| `apps/server/tests/agent/rate-limits.impl.test.ts` | Key extraction, rotation non-reset, IP/principal separation | High |
| `apps/server/tests/agent/replay-cache.impl.test.ts` | Expiry, bound, same-key hit, different-key miss | High |
| `apps/server/tests/integration/agent/retention.impl.test.ts` | Boundary dates, batch size, failure logging | Medium |
| `packages/api-contract/tests/identities.impl.test.ts` | Strict fields, name/TTL boundaries, status mapping | High |
| `packages/api-contract/tests/agents.impl.test.ts` | Join/renew body and response edges | High |
| `apps/server/tests/integration/schema-identity.impl.test.ts` | Migration/trigger/key/index/type-drift edges | High |
| `apps/server/tests/integration/agent/authenticator.impl.test.ts` | Socket/fingerprint/cache/invalidation/DB failure | High |
| `apps/server/tests/logging.spec.test.ts` | Redaction rule table (ST-78's end-to-end case is agent-logging.spec) | High |
| `apps/server/tests/integration/identity-admin.impl.test.ts` | Admin errors, idempotent revoke, cache callback | High |
| `apps/server/tests/integration/agent-join.impl.test.ts` | Atomic claim, consumer upsert, serial retry | High |
| `apps/server/tests/integration/agent-renew.impl.test.ts` | Fresh-key, replay, threshold, revoked principal | High |
| `apps/server/tests/integration/agent-revoke.impl.test.ts` | Concurrent join/revoke, cache invalidation, failure rollback | High |
| `apps/server/tests/integration/transport.spec.test.ts` | Existing transport boundary updated for 401 and test authenticator | High |
| `apps/server/tests/integration/transport.impl.test.ts` | Existing EchoController/agent listener updated | High |
| `apps/server/tests/integration/readiness.spec.test.ts` | Conditional CA probe and admin-only readiness | High |
| `apps/server/tests/test-app.impl.test.ts` | Runtime/test seam startup behavior | Medium |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Identity admin flow | Auth, identity controller/service, PostgreSQL, role assignments | Create/list/detail/revoke/token with real sessions and DB |
| Join/renew flow | Agent controller, CA signer, X.509, PostgreSQL, HTTPS | Real token, CSR, certificate, consumer, renewal, replay |
| Listener/revocation flow | HTTPS agent listener, authenticator, cache, identity service | Missing/valid/revoked certs, keep-alive, data guard |
| Migration/types flow | BlendSDK migration generator, PostgreSQL 16/17 | Ledger, schema, triggers, generated types |

### End-to-End Tests

The server boundary is tested with real HTTPS and PostgreSQL. The agent binary, tmpfs delivery, and
local status socket are RD-10; no RD-05 end-to-end agent container is planned. The RD-05 data-route
test is a test-only Express probe because the production secret handler belongs to RD-08.

## Test Data

### Fixtures Needed

- EC P-256 CA fixture with public point, wrapped scalar, server certificate, and client certificate.
- `ca_keys` row seeded through the real wrap function.
- Project and user principals with org/project role assignments, plus auditor.
- Service identities in active/disabled states and active/soft-deleted projects.
- Join tokens in unused/used/expired/revoked states.
- Workload certificates in active/expired/revoked states with known fingerprints.
- Test-only agent authenticator/CA seams and a test-only `/v1/data` probe.
- Captured pino destination and sentinel tokens/CSRs/keys.

### Mock Requirements

No database, crypto, CA, or HTTP mocks in integration tests. Unit tests may use pure in-memory
cache/clock seams. The offline transport suite uses the explicit test authenticator/CA seam from
03-04, not a production fallback.

## Verification Commands

```bash
pnpm build
# PostgreSQL 16/17 profiles: pg16 on 5433, pg17 on 5434
docker compose -f deploy/compose/compose.test.yaml --profile pg16 up -d
OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:migrate
TEST_DATABASE_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test \
OPENVAULT_TEST_DB=1 pnpm test:integration
OPENVAULT_DB_URL=postgres://openvault:test-password@127.0.0.1:5433/openvault_test pnpm db:types:check

# Repeat with --profile pg17 and port 5434
pnpm verify
```

`pnpm verify` is the project verification command confirmed in AR-25. The integration command is a
separate phase gate because `pnpm verify` intentionally excludes `tests/integration/**`.

## Verification Checklist

- [ ] All ST cases have concrete input and expected output.
- [ ] Every ST case traces to RD-05, a component spec, or an AR entry.
- [ ] Specification tests are written before implementation and fail red.
- [ ] Specification tests pass green before implementation tests are added.
- [ ] Implementation tests cover crypto, cache, rate, retention, and authorization edges.
- [ ] Integration tests run on PostgreSQL 16 and 17 with the existing disposable-database helper.
- [ ] `pnpm verify`, the integration gate, and `pnpm db:types:check` pass under Node 24.21.0.
- [ ] Existing transport, readiness, test-app, logging, schema, auth, and CLI suites remain green.
- [ ] Existing transport/auth/schema/readiness/logging suites remain green.
- [ ] Captured logs and error envelopes contain no secret, token, CSR, key, or hash sentinel.
- [ ] Documentation matches the implemented behavior.

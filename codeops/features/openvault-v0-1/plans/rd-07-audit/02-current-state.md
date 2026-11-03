# Current State: RD-07 Audit

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

| Area | Current state |
|---|---|
| Schema | `audit_events`, `audit_keys`, and `audit_checkpoints` exist with every required column, check, index, and foreign key. `audit_events.id` is a `bigserial`; `event_id` is a unique ULID. `audit_checkpoints.last_event_id` is a unique `bigint` sequence reference. See `apps/server/src/database/schema.ts:397-455`. |
| Append-only | `reject_audit_mutation` blocks UPDATE and DELETE on both audit tables. DELETE is allowed only when `openvault.allow_audit_prune = 'on'` **and** `session_user = 'openvault_pruner'`. TRUNCATE is blocked. See `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27` and `:130-133`. |
| Policy port | `PolicyAuditPort` has `recordDecision` and `recordMutation`. The only implementation is `LoggingPolicyAudit`, which writes to the logger's error channel and keeps a bounded per-principal denial counter. See `apps/server/src/rbac/audit.ts:81-170`. |
| Policy callers | `PolicyService.authorize`, `authorizeList`, `hasAny`, and `recordDecision` audit decisions; `capabilitiesFor` and projection methods do not. `AssignmentService.create/delete` record a decision and a mutation. See `apps/server/src/rbac/policy-service.ts:614-623` and `apps/server/src/rbac/assignment-service.ts:163-225`. |
| Identity | `IdentityService` checks policy through `IdentityAuthorizer.can` and `hasAny`. Several flows call both, so one attempt can produce two policy events. See `apps/server/src/identity/identity-service.ts:203-263` and `apps/server/src/identity/identity-authorizer.ts:55-71`. |
| Authentication | Local login returns a generic `{ok:false}` without a reason. Browser, CLI, and OIDC controllers issue sessions or tokens without writing audit evidence. See `apps/server/src/auth/local-login.ts:98-144` and the three controllers. |
| Agent | Join and renew validate a CSR, claim a token, sign a certificate, and upsert consumer metadata in one transaction. Neither service records an audit event. See `apps/server/src/agent/agent-join-service.ts:75-180`, `apps/server/src/agent/agent-renew-service.ts:195-328`, and `apps/server/src/agent/consumer-repository.ts:90-123`. |
| Key hierarchy | The KEK is loaded from a mode-`0600` keyring file. `KeyringProvider.withCurrentKey` and `withKey` expose key bytes only inside a synchronous callback. The audit key is documented as KEK-wrapped but no code creates or unwraps it. See `apps/server/src/security/keyring.ts:114-132` and `docs/architecture/crypto.md:54-73`. |
| Crypto helper | `packages/core` provides an envelope that wraps a generated DEK, not a direct 32-byte key. The audit key needs a direct KEK wrap with the table's 32-byte ciphertext, 12-byte nonce, and 16-byte tag. See `packages/core/src/crypto.ts:79-115`. |
| API | No `/v1/audit` controller is registered. `apps/server/src/app.ts:221-231` registers ready, auth, identity, assignment, agent, and meta controllers only. The API reference already lists the three intended routes at `docs/reference/api.md:339-345`. |
| Rate limits | The RBAC admin limiters use the authenticated principal and per-application instances. See `apps/server/src/rbac/rate-limits.ts:24-50`. There is no audit limiter. |
| Configuration | `OPENVAULT_AUDIT_RETENTION_DAYS` is already validated at 30–3650 with a 180-day default. See `apps/server/src/config/loader.ts:295` and `docs/reference/configuration.md:27`. |
| Readiness | The `audit` probe runs `SELECT 1 FROM audit_events LIMIT 1`. See `apps/server/src/readiness/service.ts:126-138`. |
| Tests | `seedBase` inserts a fake audit key, event, and checkpoint with random bytes, so a real verifier cannot use that database. See `apps/server/tests/integration/helpers/fixtures.ts:149-190`. The `rbac-audit.impl.test.ts` suite covers the logger adapter only. |

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/database/schema.ts` | Audit tables and indexes | None; reuse |
| `apps/server/migrations/20261030094213_triggers-and-seed.up.sql` | Append-only and prune triggers | None; reuse |
| `apps/server/src/rbac/audit.ts` | Policy audit port and logger adapter | Add mutation `projectId`; keep the port stable |
| `apps/server/src/rbac/policy-service.ts` | Decision engine | Add a non-auditing option to `hasAny` |
| `apps/server/src/rbac/assignment-service.ts` | Assignment lifecycle | Pass the transaction to mutation writes |
| `apps/server/src/rbac/runtime.ts` | Policy composition | Accept the persistent adapter |
| `apps/server/src/identity/identity-authorizer.ts` | Identity policy adapter | Accept request context and non-auditing checks |
| `apps/server/src/identity/identity-service.ts` | Identity lifecycle | One audited decision per attempt; context plumbing |
| `apps/server/src/controllers/identity.ts` | Identity routes | Pass request context |
| `apps/server/src/controllers/assignments.ts` | Assignment routes | Reuse the shared context helper |
| `apps/server/src/controllers/auth.ts` | Browser login | Emit success/failure/lockout events |
| `apps/server/src/controllers/cli-auth.ts` | CLI login | Emit success/failure/lockout events |
| `apps/server/src/controllers/oidc.ts` | OIDC callback | Emit success/failure events |
| `apps/server/src/auth/local-login.ts` | Shared credential verifier | Return a stable failure reason and lockout flag |
| `apps/server/src/agent/agent-join-service.ts` | Join | Emit one join event and one consumer change event |
| `apps/server/src/agent/agent-renew-service.ts` | Renew | Emit one renew event and one consumer change event |
| `apps/server/src/agent/consumer-repository.ts` | Consumer upsert | Add a locked comparison read |
| `apps/server/src/app.ts` | Application composition | Create the audit runtime, register services and controller |
| `apps/server/src/main.ts` | Process startup | Create the audit runtime before the agent runtime |
| `packages/api-contract/src/audit.ts` | New contracts | Create |
| `apps/server/src/audit/` | New writer, query, verify, export, prune modules | Create |
| `apps/server/src/controllers/audit.ts` | New routes | Create |
| `apps/server/tests/integration/helpers/fixtures.ts` | Test data | Stop inserting synthetic audit rows by default |
| `docs/reference/api.md`, `docs/guide/audit.md`, `docs/reference/configuration.md`, `docs/reference/cli.md` | Documentation | Update with the implemented behavior |

### Code Analysis

The policy service fails closed today: `recordDecision` catches any audit port rejection and throws `PolicyUnavailableError`, which controllers map to 503 (`apps/server/src/rbac/audit.ts:118-155`, `apps/server/src/rbac/policy-service.ts:614-623`). The persistent adapter can keep that contract. The hard part is transaction ownership: a denial inside `AssignmentService.create` records the decision and then throws, so an audit row written in the same transaction would roll back with the failed mutation. The writer must commit decisions independently while mutation rows join the caller's transaction.

The join service already wraps the token claim, certificate insert, and consumer upsert in one transaction (`apps/server/src/agent/agent-join-service.ts:92-167`). Writing the join and consumer events inside that transaction gives the required fail-closed behavior and lets a retry reuse nothing after a rollback.

The test fixture's synthetic audit rows are not a valid chain. Any test that runs the real verifier against `seedBase` would fail at the first row. The fixture must separate business seeding from the schema-only audit rows.

## Gaps Identified

### Gap 1: No persistent writer

**Current Behavior:** Decisions and mutations are logged and lost on restart.
**Required Behavior:** Every event is appended to `audit_events` with a valid chain link and HMAC.
**Fix Required:** Canonical encoder, key store, writer, and persistent policy adapter.

### Gap 2: No canonical serialization

**Current Behavior:** The logger stores a free-form object; key order depends on construction.
**Required Behavior:** Byte-stable canonical JSON that a verifier can reproduce from a row.
**Fix Required:** A strict serializer with sorted keys and bounded inputs.

### Gap 3: No query, verification, or export surface

**Current Behavior:** No `/v1/audit` controller exists.
**Required Behavior:** Filtered events, chain verification, and NDJSON export under `audit.read`.
**Fix Required:** Contracts, query/cursor/verify/export services, controller, and limiters.

### Gap 4: Incomplete and duplicate emitter evidence

**Current Behavior:** Identity flows can emit two events per attempt; auth, agent, and consumer actions emit none.
**Required Behavior:** One event per attempt with the RD action strings and no sensitive material.
**Fix Required:** One-decision identity flow, auth reason plumbing, join/renew events, and consumer change detection.

### Gap 5: No retention execution

**Current Behavior:** The retention setting exists but nothing prunes.
**Required Behavior:** An explicit command exports, checkpoints, deletes, and records the prune.
**Fix Required:** Prune service, CLI entry point, pruner-role connection, and tests.

### Gap 6: Invalid test audit fixture

**Current Behavior:** `seedBase` inserts random bytes into the audit tables.
**Required Behavior:** Chain tests start from a clean, valid chain.
**Fix Required:** Remove synthetic audit rows from `seedBase`; add a schema-only fixture.

## Dependencies

### Internal Dependencies

- RD-02: database pool, request id, readiness probe.
- RD-03: principals, local/OIDC authentication, sessions.
- RD-05: service principals, join tokens, workload certificates, consumer rows.
- RD-06: policy engine, action catalog, audit port, assignment service.

### External Dependencies

- Node `crypto` for SHA-256, HMAC-SHA256, AES-256-GCM, and random bytes. No new package.
- PostgreSQL 16/17 for `pg_advisory_xact_lock`, `jsonb`, `inet`, and `bigserial`.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chain lock held across a long mutation transaction | Low | Medium | Mutations are admin-rate; decision events commit independently; measure under the concurrency test |
| Fail-closed audit makes login/join unavailable during a database incident | Medium | High | Accepted trade-off; readiness reports audit health; no secret or state change without evidence |
| Verification cost grows with retention | Medium | Medium | Batched ascending walk; rate-limited; 180-day default |
| Synthetic fixture rows invalidate verification | High | Medium | Separate the schema fixture from chain tests (AR-26) |
| Pruner role unavailable in a deployment | Medium | High | Document the prerequisite; command fails before deleting; test guards the role |
| OIDC failure paths miss an event | Medium | Medium | One helper at every callback exit; table-driven tests |
| Details allowlist rejects a legitimate field | Low | Medium | Typed emitters and per-action tests; fail closed rather than silently drop |

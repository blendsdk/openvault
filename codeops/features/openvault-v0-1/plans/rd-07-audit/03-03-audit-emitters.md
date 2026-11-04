# Audit Emitters: RD-07 Audit

> **Document**: 03-03-audit-emitters.md
> **Parent**: [Index](00-index.md)

## Overview

The writer is only useful if the current security-relevant paths call it. This component replaces the policy logger adapter, corrects the identity flows that emit two decisions per attempt, and adds authentication, agent, and consumer events. Every emitter follows the fail-closed rule: no state change or returned credential without a persisted event.

**Governing decisions:** AR-1, AR-3, AR-5, AR-14, AR-17, AR-18, AR-19, AR-20, AR-21, AR-22.

## Architecture

### Current Architecture

| Path | Current evidence |
|---|---|
| Authorization | `PolicyService` calls `PolicyAuditPort`; the adapter logs. |
| Assignments | `AssignmentService` records one decision and one mutation; the mutation is inside the database transaction. |
| Identity | `IdentityService` calls `can` and sometimes `hasAny`; both audit by default. |
| Login | `LocalLoginService` returns only `{ ok: false }`; no reason, no event. |
| OIDC | Callback failures throw; no event. |
| Agent | Join/renew write certificates and consumers; no event. |
| Consumer | `ConsumerRepository.upsert` always updates `last_seen`; no change detection. |

### Proposed Changes

```text
PolicyService ──────────────► PersistentPolicyAudit ──► AuditWriter
AssignmentService ──────────► PersistentPolicyAudit.recordMutation(tx)
IdentityService ────────────► PolicyService (one audited decision)
Auth controllers ───────────► AuditService.record (auth.login/auth.lockout)
Agent join/renew ───────────► AuditService.record(tx) for success; separate write for failure
ConsumerRepository ─────────► change detection before upsert ──► AuditService.record(tx)
```

## Implementation Details

### Shared Request Context

File: `apps/server/src/audit/http.ts`

```ts
/** Reads the request id, client address, and user agent. */
export function auditRequestContext(req: Request): AuditRequestContext;
```

- `requestId`: `req.id` when present, else `"internal"`.
- `sourceIp`: `req.ip` when present, else `null`. The helper returns the raw address; the writer normalizes it through PostgreSQL `inet` before hashing and persisting, so IPv4-mapped and compressed IPv6 values are stable across write and read.
- `userAgent`: `req.headers["user-agent"]` when it is a string, truncated to 512 characters, else `null`.

The duplicate helper in `apps/server/src/controllers/assignments.ts:36-44` moves here and is imported by the assignment, identity, auth, agent, and audit controllers. A caller that builds an `AuditEventDraft` uses `requestId: context.requestId ?? "internal"`; the writer requires a non-empty request id.

### Policy Adapter

File: `apps/server/src/audit/policy-audit.ts`

`PersistentPolicyAudit` is described in the core document. The caller changes are:

| File | Change |
|---|---|
| `apps/server/src/rbac/audit.ts` | Add `projectId` to decision and mutation events; add `recordMutation(event, tx?: AuditQueryExecutor)`; keep the logger adapter compatible; move the denial counter to a shared class |
| `apps/server/src/rbac/policy-service.ts` | Set `projectId` on every decision event from the evaluated resource |
| `apps/server/src/rbac/assignment-service.ts` | Pass `tx` to `recordMutation`; add `projectId` to each mutation event |
| `apps/server/src/rbac/runtime.ts` | Accept `audit?: PolicyAuditPort`; default to `LoggingPolicyAudit` |
| `apps/server/src/audit/runtime.ts` | Build the persistent adapter and expose it |

`PolicyMutationEvent` gains:

```ts
/** Project that owns the assignment, or null for organization scope. */
readonly projectId: string | null;
```

`PolicyDecisionEvent` gains the same `projectId: string | null` field so an object-scoped decision can satisfy the database check. `PolicyService.#toEvent` sets it from the evaluated resource; current project-scoped decisions use the project id, and org/system decisions use null.

`AssignmentService.create` derives the mutation project id from the resolved resource: org → null, project → scope id, secret/certificate → the resource's `projectId`. `delete` derives it the same way from `#resolveDeleteResource`.

### Identity: One Decision Per Attempt

Files: `apps/server/src/identity/identity-authorizer.ts`, `identity-service.ts`, `controllers/identity.ts`.

`IdentityAuthorizer` gains:

```ts
/** Evaluates one action on one resource and returns the decision. */
public async decide(
  action: IdentityAction,
  actorId: string,
  resource: PolicyResource,
  context?: PolicyAuditContext,
  options?: AuthorizeOptions,
): Promise<PolicyDecision>;

/** Reports whether the actor holds the action anywhere. */
public async hasAny(
  action: IdentityAction,
  actorId: string,
  context?: PolicyAuditContext,
  options?: AuthorizeOptions,
): Promise<boolean>;
```

`can` also accepts context and passes it through.

| Service method | Audited decision | Non-audited visibility |
|---|---|---|
| `create` | `authorize("identity.create", { type: "project", id })` | none |
| `list` with project filter | `authorize("identity.read", { type: "project", id })` | `canReadAll`, `readableProjectIds` |
| `list` without filter | `authorizeList("identity.read", org)` | none |
| `get` | `authorize("identity.read", { type: "identity", id, projectId })` | `hasAny(audit:false)` to choose 403 vs 404 |
| `revoke` | `authorize("identity.revoke", { type: "identity", id, projectId })` | `hasAny(audit:false)` to choose 403 vs 404 |
| `issueJoinToken` | `authorize("identity.join_token", { type: "identity", id, projectId })` | `hasAny(audit:false)` to choose 403 vs 404 |

The identity resource produces `scopeType: "project"`, `objectType: "identity"`, and `objectId` equal to the identity id. Create keeps the project resource because the identity row does not exist yet; its `objectType` is `project`.

Every service method adds `context?: PolicyAuditContext` as its last parameter. `IdentityController` calls `auditRequestContext(req)` and passes it.

### Authentication

Files: `apps/server/src/auth/local-login.ts`, `controllers/auth.ts`, `controllers/cli-auth.ts`, `controllers/oidc.ts`.

#### Local login result

```ts
/** Stable internal failure reasons; never returned to the client. */
export type LocalLoginFailureReason =
  | "unknown_credentials"
  | "inactive_principal"
  | "locked"
  | "invalid_credentials"
  | "invalid_hash";

export type LocalLoginResult =
  | { readonly ok: true; readonly credential: LocalLoginSuccess }
  | {
      readonly ok: false;
      readonly reason: LocalLoginFailureReason;
      readonly principalId?: string;
      /** Set when this failure created a lock. */
      readonly lockedUntil?: Date;
    };
```

`LocalLoginService.login` maps:

| Condition | Reason | Principal |
|---|---|---|
| Unknown identifier | `unknown_credentials` | absent |
| Disabled principal | `inactive_principal` | present |
| Already locked | `locked` | present |
| Non-policy stored hash | `invalid_hash` | present |
| Wrong password | `invalid_credentials` | present |
| Post-issuance credential change | `invalid_credentials` | present; the controller writes one deny event, returns 401, and the CLI revokes the unopened family |

After `recordFailure`, the service returns `lockedUntil` only when the new value is a future date. A failure that does not lock does not set it. The generic client response remains `401 invalid_credentials`; the reason is internal evidence only.

#### Browser and CLI

Both controllers determine the final credential outcome before writing the success event:

1. Parse the request.
2. Call `localLogin.login`.
3. On failure:
   - Write `auth.login` with `result: "deny"`, `actorId` when known (else null and `actorKind: "system"`), details `{ method: "local", client, reason }`.
   - If `lockedUntil` is set, write `auth.lockout` with `result: "deny"`, details `{ method: "local", client, lockSeconds: 900 }`.
   - Throw the generic 401.
4. On success:
   - Browser: call `localLogin.revalidate` before creating the session. If the recheck fails, write exactly one `auth.login` deny with `reason: "invalid_credentials"` and throw the generic 401. If it succeeds, write exactly one `auth.login` allow, then create the session and deliver the cookie. A session-creation failure after the allow event does not change the authentication result.
   - CLI: call `cliAuth.login`. A `credential_changed` result is a post-issuance failure: write exactly one deny with `reason: "invalid_credentials"` and throw 401. If it returns `issued`, write exactly one allow event, then deliver the token response. If the allow write fails, revoke the just-created family and return 503.
   - If the allow write fails in the browser path, no session exists yet; return 503.

The allow event is written after the final credential recheck and before credential delivery. A CLI token family exists only internally until delivery; revoking it on audit failure preserves fail-closed behavior without recording an allow for a rejected login.

`client` is `"browser"` for `AuthController` and `"cli"` for `CliAuthController`. The event scope is `system` with null ids because a login is not tied to a project.

#### OIDC

`OidcController` writes one `auth.login` event per callback attempt:

| Point | Result | Reason |
|---|---|---|
| Missing state, unknown state, binding mismatch, missing code | deny | `oidc_flow` |
| Provider `error` parameter | deny | `oidc_flow` |
| Code exchange failure | deny | `oidc_flow` |
| Provider unavailable | deny | `oidc_unavailable` |
| Access denied or link collision | deny | `access_denied` or `link_collision` |
| Identity resolved | allow | none |

The success event is written after identity resolution and before `sessions.create`. It uses the resolved principal id, `scopeType: "system"`, and details `{ method: "oidc", client: "browser" }`. If the allow write fails, no session is created and the controller returns 503. If session creation fails after the allow event, authentication remains recorded; no cookie is delivered. Failures before identity resolution use a null actor and `actorKind: "system"`. The provider subject, tokens, and claims are never stored.

Login initiation (`GET /v1/auth/oidc/login`) is not an authentication attempt and is not audited.

### Agent Join and Renewal

Files: `apps/server/src/agent/agent-join-service.ts`, `agent-renew-service.ts`, `controllers/agent.ts`.

Both services take an `AuditRecorder` dependency. `AgentJoinService.join(input, context?)` and `AgentRenewService.renew(auth, input, context?)` add an optional `AuditRequestContext`; the default is an internal request id with no source address or user agent, so existing direct-construction tests keep compiling. Production `AgentController` passes `auditRequestContext(req)`. Isolated tests use a `RecordingAudit` or no-op recorder; production never omits the recorder.

```ts
/** Minimal writer surface used by business emitters. */
export interface AuditRecorder {
  record(draft: AuditEventDraft, tx?: AuditQueryExecutor): Promise<AuditEventRecord>;
}
```

#### Join success

Inside the join transaction, after the consumer upsert:

1. Record `agent.join` with `result: "allow"`, `actorKind: "service"`, `actorId: principalId`, `scopeType: "project"`, `scopeId: projectId`, `projectId`, `objectType: "identity"`, `objectId: principalId`, details `{ consumerId, certificateSerial }`.
2. Record the consumer event when the comparison requires one (see below).

Both rows share the transaction. An audit failure rolls back the token claim, certificate insert, and consumer change.

#### Join failure

The method wraps the operation. On error, if the error is `AuditUnavailableError`, rethrow it. Otherwise record one `agent.join` failure event through an independent write, then rethrow the original error. If the failure write fails, the 503 replaces the original error.

| Failure | Actor kind | Actor id | Reason |
|---|---|---|---|
| CSR validation | system | null | `invalid_csr` |
| Unknown token | system | null | `join_token_unknown` |
| Expired token | system | null | `join_token_expired` |
| Inactive principal | system | null | `principal_inactive` |
| Inactive or deleted project | system | null | `project_inactive` |
| Used token | service | token principal | `join_token_used` |
| Revoked token | service | token principal | `join_token_revoked` |
| Lost claim race | service | token principal | `join_token_claim_failed` |
| CA unavailable | service | known principal | `ca_unavailable` (`error`) |
| Certificate conflict | service | known principal | `certificate_conflict` (`error`) |
| Unexpected | system | null | `internal_error` (`error`) |

The event carries no token, token hash, CSR, private key, certificate body, or request body.

Failure scope follows the data available:

| Failure | Scope |
|---|---|
| Invalid CSR, unknown token, expired token | `system`, null project |
| Inactive principal or project, token row known | `project` with the token's project id |
| Used, revoked, lost claim, CA failure | `project` with the token's project id |

A system actor may still be recorded against a project scope when the token proves the project; the database check only requires a project id for project/object scopes.

#### Renew success

Inside the renewal transaction, after the consumer upsert:

1. Record `agent.renew` with `result: "allow"`, service actor, project scope, identity object, details `{ consumerId, certificateSerial }`.
2. Record the consumer event when required.

An audit failure rolls back the renewal and prevents the replay cache from storing a response.

A replay hit returns the cached response before any new transaction. It is the same issuance attempt, so the original `agent.renew` event is the evidence and no second event is written; a test locks this behavior.

#### Renew failure

Renew is authenticated, so every failure uses the service actor:

| Failure | Reason |
|---|---|
| CSR validation | `invalid_csr` |
| Principal inactive | `principal_inactive` |
| Project inactive | `project_inactive` |
| Certificate not current | `renewal_not_current` |
| Renewal not due | `renewal_not_due` |
| CA unavailable | `ca_unavailable` (`error`) |
| Certificate conflict | `certificate_conflict` (`error`) |
| Unexpected | `internal_error` (`error`) |

Renew failures use the authenticated project scope and the service actor. They carry no CSR, private key, or certificate body.

Every renewal failure is recorded through an independent write **after** the renewal transaction rolls back; an event written inside the failing transaction would disappear. The join failure rule applies unchanged: if the error is already `AuditUnavailableError`, rethrow it; otherwise write exactly one `agent.renew` failure event and rethrow the original error. If the failure write fails, return 503 instead of the original error. Pre-transaction failures (CSR validation and a replay-cache lookup) use the same independent path.

### Consumer Change Detection

Files: `apps/server/src/agent/consumer-repository.ts`, `agent-join-service.ts`, `agent-renew-service.ts`.

Add:

```ts
/** Reads the current consumer row under a row lock. */
public async findForUpdate(
  principalId: string,
  tx: AuditQueryExecutor = this.#database,
): Promise<ConsumerRecord | undefined>;
```

The optional executor defaults to the repository's constructor database, so existing direct constructions keep working; join and renew pass their transaction explicitly.

Comparison ignores `id`, `firstSeen`, and `lastSeen`. It compares `composeProject`, `composeService`, `hostname`, `manifestHash`, and `state`.

```ts
export type ConsumerChange =
  | { readonly kind: "register" }
  | { readonly kind: "update"; readonly changed: readonly string[] };

/** Returns the audit-relevant change, or null for a last_seen-only update. */
export function classifyConsumerChange(
  previous: ConsumerRecord | undefined,
  next: ConsumerRecord,
): ConsumerChange | null;
```

- No previous row → `register`.
- Any metadata difference → `update` with the changed field names in fixed order.
- Only `lastSeen` (and therefore `state: "ok"`) changed → `null`.

`state` is set to `"ok"` by the upsert. A previous `degraded` or `failed` state therefore produces an `update`; this is an audited state change. RD-10 may add refresh paths later.

Event mapping:

| Field | Register | Update |
|---|---|---|
| action | `consumer.register` | `consumer.update` |
| result | allow | allow |
| actor | service principal | service principal |
| scope | project / project id | project / project id |
| object | `consumer` / consumer id | `consumer` / consumer id |
| details | `consumerId`, metadata fields, `state` | same plus `changed` |

The event shares the join/renew transaction.

### Composition and Wiring

Files: `apps/server/src/app.ts`, `main.ts`, `rbac/runtime.ts`, `identity/identity-runtime.ts`, `agent/agent-runtime.ts`, `auth/plugin.ts`.

- `createAuditCore` builds the writer and persistent policy adapter.
- `createAuditRuntime` builds the service and limiters from the core and the policy service.
- `createPolicyRuntime` accepts the adapter; when absent it keeps the logger default.
- `createAgentRuntime` accepts an optional `AuditCore`; when absent it creates one from the database and keyring. It then creates the policy runtime with the core's adapter and the full audit runtime, and passes the service to join/renew. It exposes the audit runtime on its value.
- `createIdentityRuntime` keeps its optional `policyRuntime`; production passes the application policy runtime built with the persistent adapter. Isolated unit tests may keep the logger default.
- `createApplication` resolves the audit runtime in this order: explicit dependency, agent runtime, or build core → policy → runtime. `SecureApplicationDependencies` gains an optional `auditRuntime`. It registers `auditService` and `auditRateLimits`, passes the service to `createAuthPlugin`, and registers `AuditController` at `/v1/audit`.
- `createAuthPlugin` requires the `AuditRecorder` and uses it in the three login controllers.
- `main.ts` continues to create the agent runtime before the application; the runtime carries the shared audit instance.
- A shared controller helper maps `AuditUnavailableError` (and its key subclass) to 503 `service_unavailable`; auth, CLI, OIDC, identity, assignment, agent, and audit controllers use it. Existing domain error mapping is unchanged.

Only one audit runtime exists per application process, so the denial counter and limiters are not duplicated. Tests that assert persisted identity decisions construct the identity runtime with a policy runtime built from the same audit core.

### Fail-Closed Behavior by Emitter

| Emitter | Before evidence | On audit failure |
|---|---|---|
| Policy decision | Before the caller acts on the decision | 503 via `PolicyUnavailableError` |
| Assignment mutation | Inside the mutation transaction | Transaction rolls back; 503 |
| Identity mutation | Decision commits independently, then the mutation proceeds | Denial/allow evidence survives; mutation errors are separate |
| Local/CLI login | After the final credential recheck, before credential delivery | 503; no credential; a just-created CLI family is revoked |
| OIDC login | After identity resolution, before session creation | 503; no session |
| Agent join | Inside the join transaction | Transaction rolls back; 503 |
| Agent renew success | Inside the renew transaction | Transaction rolls back; 503 |
| Agent renew failure | Independent write after rollback | 503 if the failure write fails |
| Consumer change | Inside the join/renew transaction | Transaction rolls back; 503 |
| Audit verify/export | Before the response body | 503 |

## Error Handling

| Error case | Handling strategy | AR Ref |
|---|---|---|
| Unknown identity before authorization | 404 with no decision event; no action was evaluated | AR-19 |
| Denied identity action | One deny event; 403 or 404 based on non-audited visibility | AR-19 |
| Login failure reason unknown to the client | Generic 401; reason only in the audit detail | AR-20 |
| Login audit failure | 503; no session or token. A wrong-password attempt may already have advanced the failure counter; no credential is issued and the client gets 503. | AR-17, AR-20 |
| Audit write failure in an existing controller | `AuditUnavailableError` is mapped to 503 in the auth, CLI, OIDC, identity, assignment, agent, and audit controllers; unknown exceptions remain 500 only when they are not audit failures. | AR-17, AR-25 |
| OIDC provider error | One deny event; existing redirect/error behavior otherwise | AR-20 |
| Join token used/revoked | One service-actor event; original 401 | AR-21 |
| Join audit failure inside the transaction | Roll back the join; 503 | AR-17 |
| Consumer metadata unchanged | No consumer event; the join/renew event still records the attempt | AR-22 |
| Unexpected emitter error | Record `internal_error` when possible; otherwise the original error propagates | AR-21 |

## Testing Requirements

- Event-count tests for every identity method: one decision event per attempt, including denials.
- Assertion that a denied assignment leaves one decision event after the transaction rolls back.
- Auth tests for each local failure reason, lockout threshold, and success for browser and CLI.
- A credential-race test for browser and CLI: a hash change after verification produces exactly one deny event, no allow event, and no returned credential.
- OIDC tests for state failure, provider error, exchange failure, access denial, and success.
- Join failure matrix: unknown, expired, used, revoked, inactive principal, inactive project, invalid CSR.
- Renew failure matrix: not current, not due, inactive, CA failure, and a failure event that survives the transaction rollback.
- A renewal replay test: the cached response is returned without a second `agent.renew` event.
- Consumer tests: first join registers, changed compose service updates, `last_seen`-only produces no event, state change updates.
- Redaction tests with sentinel values in every emitter input; assert the sentinel appears in no column.
- Fail-closed tests that force an audit insert failure and assert the 503 plus the absent state change for auth, CLI, OIDC, agent join, and agent renew.
- Existing direct-construction tests for `AgentJoinService` and `AgentRenewService` are updated for the audit recorder and the optional request context.

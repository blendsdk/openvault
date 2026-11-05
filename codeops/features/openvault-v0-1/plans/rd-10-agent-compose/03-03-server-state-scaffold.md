# Server State and Scaffold: RD-10 Agent Delivery and Compose

> **Document**: 03-03-server-state-scaffold.md
> **Parent**: [Index](00-index.md)

## Overview

This component adds the server surfaces RD-10 needs: an agent-aware consumer heartbeat on the
existing secret read, a final aggregate heartbeat route, and an idempotent per-service Compose
scaffold. It does not add a migration, a scheduler, or a second identity system.

## Architecture

### Consumer state

```text
agent fetch / heartbeat
  GET /v1/data/:project/secrets/:name        POST /v1/agent/consumer
  X-OpenVault-Consumer-State: ok|degraded    { "state": "ok|degraded|failed" }
  X-OpenVault-Entry-Optional: true|false
        │                                           │
        ▼                                           ▼
SecretsController ──► SecretService.read    AgentController
        │                                           │
        └──────────────► AgentConsumerService ◄─────┘
                              │
                              ├─ update consumers.last_seen
                              └─ one consumer.update audit event on a state change
```

The per-fetch headers record an immediate result: a successful read uses the supplied state; a
404/410 records `degraded` for an optional entry or `failed` for a required entry. The final
heartbeat records the aggregate after every refresh, including a last-entry or all-entry
failure that no subsequent fetch can report.

### Scaffold

```text
POST /v1/admin/scaffold
  { project, service, entries[0..100] }
        │
        ▼
ScaffoldService
  ├── resolve active project (create only when entries is empty)
  ├── authorize assignment.write on the project
  ├── resolve every active secret id (fail before any grant/token)
  ├── resolve or create active service identity
  ├── reject a reused identity with a broader live grant
  ├── create or reuse object-scope secrets.reader assignments
  ├── revoke previous unused join tokens for the identity
  ├── issue one token
  └── render per-service compose + manifest
```

The route is control-plane and requires a browser or CLI principal. It is not available on
the agent listener; the scope middleware returns 404 before the agent middleware.

## Implementation Details

### Contracts

Add `packages/api-contract/src/scaffold.ts`:

```ts
/** A Compose-safe service name used in paths and generated YAML. */
export const composeServiceNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "invalid compose service name");

/** Compose scaffold request. */
export const scaffoldRequestSchema = z
  .strictObject({
    project: projectNameSchema,
    service: composeServiceNameSchema,
    entries: z.array(secretNameSchema).max(100).default([]),
  })
  .superRefine((value, context) => {
    if (new Set(value.entries).size !== value.entries.length) {
      context.addIssue({ code: "custom", path: ["entries"], message: "entries must be unique" });
    }
  });

/** One object-scope grant created or reused by the scaffold. */
export const scaffoldAssignmentSchema = z.strictObject({
  name: secretNameSchema,
  assignment: assignmentSchema,
});

/** Compose scaffold response. */
export const scaffoldResponseSchema = z.strictObject({
  project: projectSchema,
  identity: identitySummarySchema,
  assignments: z.array(scaffoldAssignmentSchema),
  joinToken: joinTokenResponseSchema,
  compose: z.string().min(1),
  manifest: z.string().min(1),
  manifestFile: z.string().min(1),
});
```

Export the schemas and inferred types from `packages/api-contract/src/index.ts`. Add
`agentConsumerStateSchema = z.strictObject({ state: z.enum(["ok", "degraded", "failed"]) })`,
`agentConsumerStateResponseSchema = agentConsumerStateSchema`, and their types to
`packages/api-contract/src/agents.ts`.

### Consumer heartbeat service

Add `apps/server/src/agent/consumer-service.ts`:

```ts
/** Updates one consumer heartbeat and audits state changes. */
export class AgentConsumerService {
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly consumers: ConsumerRepository;
    readonly audit?: AuditRecorder;
    readonly logger?: Logger;
  });

  /** Best-effort heartbeat; a state change writes one consumer.update event. */
  public async update(
    principalId: string,
    state: "ok" | "degraded" | "failed",
    context?: AuditRequestContext,
  ): Promise<void>;
}
```

Behavior:

1. Run one transaction. `consumerRepository.findForUpdate(principalId, tx)`.
2. No row: return without creating a consumer; join/renew owns registration.
3. State unchanged: `UPDATE consumers SET last_seen = now()` only, no audit event.
4. State changed: update `last_seen` and `state`, then write one `consumer.update` event with
   `changed: ["state"]` and the new state. The event uses the existing consumer details
   (`consumerId`, `composeProject`, `composeService`, `hostname`, `manifestHash`, `state`).
5. If the audit write fails, the transaction rolls back, `update` catches the error, logs
   `consumer_heartbeat_failed`, and returns normally; the read/heartbeat response is still
   successful and the next cycle retries. A state change is never silently unaudited.

Add `ConsumerRepository.updateState(tx, principalId, state)` returning the updated row and
reuse `findForUpdate` for the previous value.

### Per-fetch headers

In the agent branch of `SecretsController`'s `GET /:project/secrets/:name`:

```ts
const state = parseConsumerState(req.headers["x-openvault-consumer-state"]); // default "ok"
const optional = parseOptionalFlag(req.headers["x-openvault-entry-optional"]); // default false
```

- Invalid or repeated header values on the agent listener return 422 `validation_error` before
  the read.
- On success, call `AgentConsumerService.update(agent.principalId, state, context)` after the
  read; ignore a heartbeat failure.
- On `SecretServiceError` 403, 404, or 410 for an agent request, map `403` to `failed` and
  `404/410` to `optional ? "degraded" : "failed"`, call the heartbeat best-effort, then rethrow.
- On 401 from the middleware there is no authenticated principal; the revocation path already
  sets `failed`. An expired client certificate cannot update the row. Document this residual.
- Non-agent requests ignore the headers.
- Remove the `agentPrincipalId` option from `SecretService.read`; the controller owns the
  heartbeat.

### Heartbeat route

Add to `AgentController`:

```ts
this.route()
  .post("/consumer")
  .middleware(consumerStateLimit())
  .handle(async (req, res) => {
    const agent = requireAgent(req);
    const parsed = agentConsumerStateSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, "validation_error", "Validation failed");
    const service = await this.services.get<AgentConsumerService>("agentConsumerService");
    await service.update(agent.principalId, parsed.data.state, auditRequestContext(req));
    this.ok(res, { state: parsed.data.state });
  });
```

The route returns 200 `{state}` so the client can validate a body; it requires mTLS. Add a 60/minute per-principal limiter to `AgentRateLimitService`
(`consumerState`) and the agent rate-limit options. The agent calls it after every refresh and
startup, and `--once` calls it once.

### Scaffold service

`apps/server/src/scaffold/service.ts`:

```ts
/** Options for {@link ScaffoldService}. */
export interface ScaffoldServiceOptions {
  readonly database: PostgreSQLDatabase;
  readonly projects: ProjectService;
  readonly projectRepository: ProjectRepository;
  readonly identities: IdentityService;
  readonly assignments: AssignmentService;
  readonly secrets: SecretRepository;
  readonly policy: PolicyService;
  readonly now?: () => number;
}

/** Creates or reuses a Compose service scaffold. */
export class ScaffoldService {
  public async scaffold(
    actorId: string,
    input: ScaffoldRequest,
    context?: PolicyAuditContext,
  ): Promise<ScaffoldResponse>;
}
```

Algorithm:

1. Validate the request in the controller.
2. `projectRepository.findActiveByName(database, input.project)`.
   - If absent and `entries.length > 0`: throw 422 `validation_error` with
     `Project not found; create the project and its secrets before scaffolding entries`.
     Do not create an empty project.
   - If absent and `entries.length === 0`: call `projects.create(actorId, { name }, context)`.
     On 409, re-read the active project (a concurrent create won).
3. Authorize `assignment.write` on `{ type: "project", id: project.id }` with
   `policy.authorize(...)`. On denial, record the decision and throw 403 `access_denied`.
4. Resolve every entry with `secrets.findActiveSecret(database, project.id, name)`. If any are
   missing, throw 422 `validation_error` with `Unknown secret: <names>`; no identity,
   assignment, or token is created.
5. Find an active service identity via `identities.list(actorId, project.id, context)` and an
   exact trimmed-name match with `status === "active"`. If none, call
   `identities.create(actorId, { name, projectId }, context)`. On 409, re-read and match; a
   disabled same-name identity is ignored and the create is retried once.
6. Inspect all live assignments for the identity with
   `policyRepository.listAllLiveForPrincipal(identity.id)`. This internal query returns every
   live assignment, including org-scope rows that a project-scoped `project.admin` cannot see
   through `AssignmentService.list`. If any live assignment grants a broader role
   (`org.admin`, `project.admin`, `secrets.manager`, `secrets.officer`, `secrets.reader` at
   `project`/`org`, or `reader` at `project`/`org`), throw `ScaffoldServiceError` 409
   `identity_scope_conflict` with guidance to use a different service name or revoke the broad
   grant. Object-scope `secrets.reader` assignments are allowed.
7. For each resolved secret, call `assignments.create(actorId, { principalId, role:
   "secrets.reader", scopeType: "object", scopeId: secret.id }, context)`.
   - On 409 `assignment_conflict`, list the exact assignment. If it is live, reuse it. If it is
     expired, call `assignments.delete(actorId, assignment.id, context)` and create it again.
8. List the identity's live object-scope `secrets.reader` assignments and delete every one
   whose `scopeId` is not in the requested secret-id set, using `assignments.delete` so each
   removal is audited. This keeps a re-scaffold with fewer entries least-privilege.
9. Rotate the join token atomically: `identities.rotateJoinToken(actorId, identity.id,
   undefined, context)` locks the identity, revokes every unused token, and inserts the new
   token in one transaction. The default TTL is `OPENVAULT_JOIN_TOKEN_TTL` (15 minutes).
10. Render the Compose snippet and manifest skeleton, return the response, and never log the
    token.

The token is issued last so a missing secret, broader grant, or denied assignment does not
consume a one-time credential. The workflow is idempotent across partial failures: a retry
re-reads the project, identity, and assignments and issues a fresh token.

`IdentityService` gains:

```ts
/** Atomically revokes every unused token and issues a new one. */
public async rotateJoinToken(
  actorId: string,
  id: string,
  ttlSeconds: number | undefined,
  context?: PolicyAuditContext,
): Promise<JoinTokenResponse>;
```

It authorizes `identity.join_token`, rechecks the identity/project state, and calls a new
`AgentTokenService.rotate` that locks the principal, revokes every unused token, and inserts
the new token in one transaction. Two concurrent scaffolds therefore cannot leave two live
unused tokens.

### All-assignments query

Add `PolicyRepository.listAllLiveForPrincipal(principalId)`:

```ts
/** Lists every live assignment for one principal, including org-scope rows. */
public async listAllLiveForPrincipal(principalId: string): Promise<readonly AssignmentRecord[]>;
```

The query is not visibility-filtered. The scaffold calls it only after `assignment.write` on
the identity's project has been authorized, so it does not widen what the actor can mutate; it
is needed because a project-scoped admin cannot see an org-scope grant through the normal
visibility filter.

### Compose renderer

`apps/server/src/scaffold/compose.ts` exports pure functions:

```ts
export interface ComposeScaffoldInput {
  readonly project: string;
  readonly service: string;
  readonly entries: readonly string[];
}

export function renderCompose(input: ComposeScaffoldInput): string;
export function renderManifest(input: ComposeScaffoldInput): string;
export function manifestFileName(service: string): string; // openvault.${COMPOSE_PROJECT_NAME}.<service>.manifest.yaml
```

`service` is already validated by `composeServiceNameSchema`; every interpolated YAML scalar
is emitted through a `yamlQuote` helper (a JSON string is a valid YAML double-quoted scalar) so
metacharacters cannot break the document. The image constant is
`ghcr.io/blendsdk/openvault-agent:0.1.0`. The snippet is deterministic:

```yaml
# Generated by OpenVault. Merge the application keys into your service.
# Before first start, create the agent-owned directories:
# install -d -m 0700 -o 10001 -g 10001 "/dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api" "./openvault-state/${COMPOSE_PROJECT_NAME}/api"
# install -m 0444 -o 10001 -g 10001 ./openvault-ca.pem "./openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml"
# Set OPENVAULT_JOIN_TOKEN in your shell or an env file outside this Compose file.
# Never commit the token to the Compose file or to source control.
services:
  openvault-agent-api:
    image: "ghcr.io/blendsdk/openvault-agent:0.1.0"
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      OPENVAULT_URL: "https://openvaultd:8444"
      OPENVAULT_CA_FILE: "/etc/openvault/ca.pem"
      OPENVAULT_JOIN_TOKEN: "${OPENVAULT_JOIN_TOKEN}"
      OPENVAULT_PROJECT: "payments"
      OPENVAULT_SERVICE: "api"
      COMPOSE_PROJECT_NAME: "${COMPOSE_PROJECT_NAME}"
      OPENVAULT_MANIFEST: "/etc/openvault/manifest.yaml"
      OPENVAULT_OUTPUT_DIR: "/run/secrets"
      OPENVAULT_STATE_DIR: "/var/lib/openvault"
    tmpfs:
      - /run/openvault:uid=10001,gid=10001,mode=0700,size=16m
    volumes:
      - type: bind
        source: /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-state/${COMPOSE_PROJECT_NAME}/api
        target: /var/lib/openvault
        bind:
          create_host_path: false
      - type: bind
        source: ./openvault-ca.pem
        target: /etc/openvault/ca.pem
        read_only: true
      - type: bind
        source: ./openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml
        target: /etc/openvault/manifest.yaml
        read_only: true
    networks: [default, vault_net]
    healthcheck:
      test: ["CMD", "ov-agent", "health", "--ready"]
      interval: 10s
      timeout: 3s
      retries: 3
  api:
    # Merge these keys into the application service.
    user: "10001:10001"
    volumes:
      - type: bind
        source: /dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api
        target: /run/secrets
        read_only: true
        bind:
          create_host_path: false
    depends_on:
      openvault-agent-api:
        condition: service_healthy
networks:
  vault_net:
    external: true
```

The manifest file name is `openvault.<compose-project>.<service>.manifest.yaml`; the scaffold returns the template `openvault.${COMPOSE_PROJECT_NAME}.<service>.manifest.yaml`, which RD-11 expands from the Compose project name. Every mapping key and scalar is emitted through `yamlQuote`, so a leading-digit or boolean-like service name stays a string key. `renderManifest` returns:

```yaml
project: "payments"
service: "api"
refresh: "300s"
output_dir: "/run/secrets"
entries:
  - name: "db-password"
    file: "db-password"
```

When `entries` is empty, the manifest contains a comment instructing the operator to add at
least one entry before starting the agent. Neither document contains the join token or a
certificate.

### Scaffold error type

Add `apps/server/src/scaffold/errors.ts`:

```ts
export type ScaffoldErrorCode =
  | "validation_error"
  | "access_denied"
  | "project_name_conflict"
  | "identity_scope_conflict"
  | "identity_inactive";

export class ScaffoldServiceError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: ScaffoldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScaffoldServiceError";
  }
}
```

The controller's `mapError` handles `ScaffoldServiceError` first, then the existing project,
identity, RBAC, policy, and audit errors. This is what makes the 409 `identity_scope_conflict`
and 422 paths reachable instead of a generic 500.

### Route and composition

`apps/server/src/controllers/scaffold.ts` uses the same `execute`/`mapError` pattern as the
project and assignment controllers:

```ts
function mapError(error: unknown): unknown {
  if (error instanceof ProjectServiceError) return new ApiError(error.statusCode, error.code, error.message);
  if (error instanceof IdentityServiceError) return new ApiError(error.statusCode, error.code, error.message);
  if (error instanceof RbacServiceError) return new ApiError(error.statusCode, error.code, error.message);
  if (error instanceof PolicyUnavailableError || error instanceof AuditUnavailableError) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

this.route()
  .post("/")
  .middleware(scaffoldWriteLimit())
  .handle(async (req, res) => {
    const actor = requirePrincipal(req);
    const parsed = scaffoldRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, "validation_error", "Validation failed");
    const service = await this.services.get<ScaffoldService>("scaffoldService");
    const result = await execute(() =>
      service.scaffold(actor.user.id, parsed.data, auditRequestContext(req)),
    );
    this.ok(res, scaffoldResponseSchema.parse(toScaffoldResponse(result)));
  });
```

`toScaffoldResponse` projects `ProjectRecord` and `AssignmentRecord` into the contract shapes:
ISO timestamps, no `principalKind`/`principalStatus`, and `{name, assignment}` for each grant.

Register `app.registerController("/v1/admin/scaffold", ScaffoldController)`, the
`ScaffoldService`, and the `AgentConsumerService` in `apps/server/src/app.ts`. Add a
`scaffoldWriteLimit` of 5/minute per principal in `apps/server/src/rbac/rate-limits.ts` (or a
small scaffold rate-limit module) and register it like the assignment limit.

### Error mapping

| Error | Status / code |
|---|---|
| Invalid body, duplicate entries, unknown secret, project missing with entries | 422 `validation_error` |
| Project name conflict after concurrent create | 409 `project_name_conflict` |
| Reused identity has a broader live grant | 409 `identity_scope_conflict` via `ScaffoldServiceError` |
| Actor cannot grant | 403 `access_denied` |
| Identity inactive / create conflict | existing identity codes |
| Join token failure | existing identity codes |
| Policy or audit unavailable | 503 `service_unavailable` |

## Code Examples

```http
POST /v1/admin/scaffold
{ "project": "payments", "service": "api",
  "entries": ["db-password", "stripe-api-key"] }

-> 200 {
     "project": { "id": "01J...", "name": "payments", ... },
     "identity": { "id": "01J...", "name": "api", "projectId": "01J...",
                    "status": "active", "createdAt": "..." },
     "assignments": [
       { "name": "db-password", "assignment": { "role": "secrets.reader",
         "scopeType": "object", "scopeId": "01J...", ... } }
     ],
     "joinToken": { "id": "01J...", "token": "<43 chars>", "expiresAt": "..." },
     "compose": "services:\n  openvault-agent-api:\n...",
     "manifest": "project: \"payments\"\n...",
     "manifestFile": "openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml"
   }
```

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Missing secret | 422 before identity/grant/token creation | AR-20 |
| Project missing with entries | 422 without creating a project | AR-20 |
| Project missing with no entries | Create project, identity, token, manifest skeleton | AR-19, AR-20 |
| Existing project/identity/assignment | Re-read and reuse | AR-22 |
| Reused identity has broader grant | 409 `identity_scope_conflict` | AR-22 |
| Expired object assignment | Delete and recreate | AR-22 |
| Disabled identity with the same name | Create a new active identity | AR-22 |
| Re-scaffold | Revoke old unused tokens, issue a fresh one | AR-19 |
| Token issuance fails after grants | Idempotent retry; grants remain | AR-19 |
| Invalid consumer state header | 422 before the read | AR-18 |
| Heartbeat audit failure | Best-effort; previous state remains; next cycle retries | AR-18 |

## Testing Requirements
- Integration tests for the full scaffold workflow, idempotence, object-scope-only grants,
  token absence, per-service Compose names, unknown entries, project creation with empty
  entries, missing project with entries, broader-grant rejection including an org-scope grant
  seen by a project-scoped actor, stale object-grant removal when the entry set shrinks,
  expired assignments, atomic token rotation, and authorization.
- Integration tests for consumer state on success, required 404, optional 404, 403, invalid
  headers, heartbeat route, state audit, and non-agent requests.
- Pure renderer tests for deterministic YAML, quoting, path traversal rejection, two-service
  uniqueness, host-directory comments, app UID, and token absence.
- Contract tests for the scaffold and heartbeat schemas.

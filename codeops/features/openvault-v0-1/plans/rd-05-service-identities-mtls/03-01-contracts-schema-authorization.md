# Contracts, Schema, and Identity Admin: RD-05

> **Document**: 03-01-contracts-schema-authorization.md
> **Parent**: [Index](00-index.md)

## Overview

This component owns the public identity contracts, the database changes that support workload
identity, the narrow identity-authorization helper, and the admin controller/service. It is the
foundation for the CA, join/renew, listener, and cleanup components.

The admin surface is deliberately small: create a project-owned service identity, list identities
visible to the caller, read one identity with its retained certificates and consumer, revoke the
identity, and issue a one-time join token. RD-06 will replace the narrow helper, not the route
contract. [AR-9, AR-10, AR-16, AR-19, AR-20, AR-23]

## Architecture

### Current Architecture

`principals` already stores service principals, project ownership, and status. `workload_certs`,
`join_tokens`, `consumers`, and `role_assignments` already exist. The missing schema pieces are a
CA-key row, token revocation, and lifecycle indexes. There is no identity controller, service,
authorizer, or API contract.

The auth plugin attaches a browser or CLI context to `req.auth`. Admin routes use
`requirePrincipal`; the new helper reads `role_assignments` directly because RD-06's full evaluator
is not implemented yet. [AR-10]

### Proposed Changes

1. Add strict Zod contracts in `packages/api-contract/src/identities.ts` and export them from
   `packages/api-contract/src/index.ts`.
2. Add the schema changes and generated migration, then a reviewed manual trigger migration for
   service-principal human-credential guards.
3. Add `apps/server/src/identity/identity-repository.ts`,
   `identity/identity-authorizer.ts`, and `identity/identity-service.ts`.
4. Add `apps/server/src/controllers/identity.ts` and register it at `/v1/admin/identities`.
5. Wire the service/controller into the application assembly without putting agent behavior in the
   existing browser/CLI auth controller.

## Implementation Details

### Shared contracts

Use `z.strictObject` everywhere; unknown fields are rejected.

```ts
// packages/api-contract/src/identities.ts
export const identityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed");

export const identityCreateRequestSchema = z.strictObject({
  name: identityNameSchema,
  projectId: ulidSchema.optional(),
});

export const identityListQuerySchema = z.strictObject({
  projectId: ulidSchema.optional(),
});

export const identitySummarySchema = z.strictObject({
  id: ulidSchema,
  name: z.string().min(1).max(100),
  projectId: ulidSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.iso.datetime(),
});

export const identityCertificateSchema = z.strictObject({
  serial: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

export const identityConsumerSchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  state: z.enum(["ok", "degraded", "failed"]),
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  selfReported: z.literal(true),
});

export const identityDetailSchema = identitySummarySchema.extend({
  certificates: z.array(identityCertificateSchema),
  consumer: identityConsumerSchema.nullable(),
});

export const identityListSchema = z.strictObject({
  identities: z.array(identitySummarySchema),
});

export const joinTokenCreateRequestSchema = z.strictObject({
  ttlSeconds: z.number().int().optional(),
});

export const joinTokenResponseSchema = z.strictObject({
  id: ulidSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
```

`packages/api-contract/src/agents.ts` owns the agent contracts. The controller maps a malformed
JSON body or an empty/over-128-character token envelope to 400, an agent body/consumer/CSR schema
failure to 422, and an in-bound token encoding/unknown/expired/used/revoked failure to 401
`join_failed`. The service, not the schema, owns the token encoding/lifetime check so an in-bound
bad token does not reveal which token field failed:

```ts
export const agentConsumerSchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const agentJoinRequestSchema = z.strictObject({
  token: z.string().min(1).max(128),
  csr: z.string().min(1).max(65_536),
  consumer: agentConsumerSchema,
});

export const agentRenewRequestSchema = z.strictObject({
  csr: z.string().min(1).max(65_536),
  consumer: agentConsumerSchema,
});

export const agentCertificateResponseSchema = z.strictObject({
  certificatePem: z.string().min(1),
  chainPem: z.string().min(1),
  identityId: ulidSchema,
  serial: z.string().min(1).max(128),
  notAfter: z.iso.datetime(),
});
```

The CSR body is bounded by the existing global 128 KiB request limit; the CSR parser adds its own
ASN.1 resource limits. Private keys are never accepted.

### Schema and migration

Add to `apps/server/src/database/schema.ts`:

```ts
const caKeys = db.table("ca_keys");
caKeys.text("id").check(ulidExpression("id"));
caKeys.text("cert_pem").check(lengthBetween("cert_pem", 1, 16_384));
caKeys.bytea("public_key").check("octet_length(public_key) = 65");
caKeys.bytea("wrapped_key").check("octet_length(wrapped_key) = 32");
caKeys.bytea("wrap_nonce").check("octet_length(wrap_nonce) = 12");
caKeys.bytea("wrap_tag").check("octet_length(wrap_tag) = 16");
caKeys.text("kek_id").check(lengthBetween("kek_id", 1, 64));
caKeys.text("status").check("status IN ('current', 'retired')");
caKeys.timestamptz("created_at").default("now()");
caKeys.timestamptz("activated_at");
caKeys.timestamptz("retired_at").nullable();
caKeys.primaryKey().column("id");
caKeys.checkConstraint(
  "(status = 'retired' AND retired_at IS NOT NULL) OR (status <> 'retired' AND retired_at IS NULL)",
);
caKeys.index().indexName("ca_keys_current_idx").unique().column("status").where("status = 'current'");
```

Add `join_tokens.revoked_at` (`timestamptz`, nullable), an index on
`join_tokens.expires_at`, an index on `workload_certs.not_after`, and the partial unique index:

```ts
principals
  .index()
  .indexName("principals_service_name_active_idx")
  .unique()
  .column("owner_project_id", "name")
  .where("kind = 'service' AND status = 'active'");
```

Use the BlendSDK generator for the schema migration, then review and commit the generated SQL,
snapshot, generated row types, and CType constants. The manual trigger migration is separate
because the model cannot express cross-table credential guards. [AR-17, AR-23]

Add one reviewed manual migration after the generated migration:

```sql
-- blendsdk-migration: 1
-- id: <generated-manual-id>_identity-guards
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

CREATE FUNCTION reject_service_human_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM principals
     WHERE id = NEW.principal_id AND kind = 'service'
  ) THEN
    RAISE EXCEPTION 'service principals cannot have human credentials'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_principal_kind_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'principal kind is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER principals_kind_immutable
  BEFORE UPDATE OF kind ON principals
  FOR EACH ROW EXECUTE FUNCTION reject_principal_kind_change();

CREATE TRIGGER local_credentials_service_guard
  BEFORE INSERT OR UPDATE ON local_credentials
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();

CREATE TRIGGER oidc_identities_service_guard
  BEFORE INSERT OR UPDATE ON oidc_identities
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();

CREATE TRIGGER cli_sessions_service_guard
  BEFORE INSERT OR UPDATE ON cli_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();
```

The human-login and session read paths also require `kind='user'`: `findStatus`,
`findByPrincipalId`, `findActiveContext`, and the OIDC linkage query. This closes the read path
for any legacy row and is defense in depth, not a replacement for the database guard. [AR-14]

The manual migration must use the five-line BlendSDK header shown above; the generated id is the
same id recorded in the migration ledger. A second current CA row, an invalid `principals.kind`
change, or a service-principal credential row is rejected at the database boundary.

### Identity records and repository

`identity-repository.ts` owns SQL for:

- `findIdentity(id)` joined to `projects` with `deleted_at` visibility.
- `findProject(id)` for create/join-token target checks.
- `insertServiceIdentity({id, name, projectId, now})`.
- `listVisible(actorScope, projectId?)` using the authorizer scope.
- `listCertificates(principalId)` ordered `issued_at DESC, id DESC`.
- `findConsumer(principalId)`.
- `revokeIdentity(principalId)` transaction.

Use `newUlid()` for identity and token identifiers. `createdAt`/timestamps are converted to ISO in
the controller. The repository returns domain records; no SQL row leaks to the controller.

### Runtime ownership

`apps/server/src/identity/identity-runtime.ts` is the single owner of the identity repository,
authorizer, service, and join-token service.

```ts
export interface IdentityRuntime {
  readonly repository: IdentityRepository;
  readonly authorizer: IdentityAuthorizer;
  readonly service: IdentityService;
  readonly tokens: AgentTokenService;
}

export async function createIdentityRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly config: OpenVaultConfig;
  readonly onRevoked?: (principalId: string) => void;
}): Promise<IdentityRuntime>;
```

The production agent runtime constructs this single identity runtime with `onRevoked` wired to both
the agent-authenticator and renewal-replay caches. Phase 2 admin tests may create the identity
runtime directly without a callback; the application registers either the test identity runtime or
the production agent runtime, never both. [AR-16]

### Narrow identity authorization

The helper owns the identity slice of the RD-06 matrix until RD-06 replaces it. [AR-10]

```ts
export type IdentityAction =
  | "identity.create"
  | "identity.read"
  | "identity.revoke"
  | "identity.join_token";

export interface IdentityAuthorization {
  can(action: IdentityAction, actorId: string, projectId: string): Promise<boolean>;
  canReadAll(actorId: string): Promise<boolean>;
  readableProjectIds(actorId: string): Promise<readonly string[]>;
}
```

The helper first verifies the actor is an active `kind='user'` principal. It reads unexpired
`role_assignments` where scope is `org` or `project`.

| Scope | Role | Actions |
|---|---|---|
| org | `org.admin`, `project.admin` | create/revoke/join-token/read on every identity |
| org | `auditor` | read on every identity |
| project | `project.admin` | create/revoke/join-token/read on identities owned by that project |
| project | `auditor` | read on identities owned by that project |

The helper ignores object-scope assignments for identity actions. A project-scoped assignment
never authorizes another project or an org-only role. A project-scoped `org.admin` assignment is
not part of the public matrix and must be ignored even though the schema can represent it. A
missing or expired assignment denies. The controller maps a signed-in caller without action to
`403 access_denied`; a foreign identity detail/revoke maps to `404 identity_not_found`. [AR-10, AR-19]

For list when no `projectId` is supplied:

- if `canReadAll` is true, list every service identity;
- otherwise list identities whose `owner_project_id` is in `readableProjectIds`;
- if the set is empty, return an empty list.

If `projectId` is supplied, the caller must cover it; otherwise `403 access_denied`. The target
project must exist and be active for create and join-token issuance. A missing `projectId` on
create is rejected by the service with 422; the contract leaves it optional so the status matches
the requirement.

### Admin routes and behavior

| Method | Path | Action | Success | Errors |
|---|---|---|---|---|
| POST | `/v1/admin/identities` | `identity.create` | 201 summary | 400 schema, 401, 403, 409 name conflict, 422 semantics |
| GET | `/v1/admin/identities` | `identity.read` | 200 list | 400 schema, 401, 403 |
| GET | `/v1/admin/identities/:id` | `identity.read` | 200 detail | 401, 403, 404 |
| POST | `/v1/admin/identities/:id/revoke` | `identity.revoke` | 204 | 401, 403, 404 |
| POST | `/v1/admin/identities/:id/join-tokens` | `identity.join_token` | 201 token | 400 schema, 401, 403, 404, 409 inactive, 422 TTL |

Create trims the name, validates it, verifies the target project is active, authorizes the target
project, inserts `principals(kind='service', owner_project_id, status='active')`, and maps a unique
active-name violation to `409 identity_name_conflict`. It never accepts an email or credential
field. [AR-9, AR-23]

List/detail return only service identities. Detail returns every retained certificate, including
revoked/expired rows, newest first, and the consumer with `selfReported: true`. A malformed path id
is treated as `404 identity_not_found` so it cannot become a validation oracle. [AR-19, AR-20]

Revoke is idempotent. It locks the principal, sets `status='disabled'` and
`disabled_at=COALESCE(disabled_at, now())`, revokes all unexpired certificates and unused join
tokens, marks the consumer `failed`, commits, then invalidates the local agent-authentication and
renewal-replay caches for that principal. The cache invalidation callback is optional so a later
RD-06 caller can use the same service without an agent runtime.

Join-token issuance is a separate 201 response containing the raw token once. The body TTL is
optional; absent uses `OPENVAULT_JOIN_TOKEN_TTL`; values above 24 hours or below one second are
`422 validation_error`. A disabled identity or inactive project returns `409 identity_inactive`.
The service passes the authenticated actor id as `createdBy`; the token is hashed and stored by
`AgentTokenService` in 03-03. The identity repository does not own join-token SQL.

### Controller and app registration

`IdentityController` extends `BaseController`; each route starts with `requirePrincipal(req)` and
then calls the service. The controller uses `this.created`, `this.ok`, and `this.noContent` for
the envelope. It never returns a raw row or a hash.

Register the controller at `/v1/admin/identities` in `apps/server/src/app.ts`. Register the
identity runtime services directly in the application assembly; do not create an identity/agent
plugin or add these routes to the browser auth controller. The browser/CLI auth middleware already
attaches the actor context.

### Error handling

| Error case | Handling | AR |
|---|---|---|
| Missing/expired session or bearer | 401 `authentication_required` from the existing auth boundary | AR-9 |
| Signed-in actor lacks the action | 403 `access_denied` | AR-10 |
| Unknown or foreign identity detail/revoke/token | 404 `identity_not_found` | AR-19 |
| Missing/unknown/inactive project on create | 422 `validation_error` | AR-9 |
| Duplicate active service name | 409 `identity_name_conflict` | AR-9, AR-23 |
| Token request for disabled identity/inactive project | 409 `identity_inactive` | AR-9 |
| Invalid admin body/query/name schema | 400 `validation_error` | AR-9, AR-23 |
| Missing project on create, unknown/inactive target project on create, or TTL range | 422 `validation_error` | AR-9, AR-23 |
| Empty or over-128-character token envelope | 400 `validation_error` | AR-4, AR-13 |
| Agent body/consumer/CSR schema failure | 422 `validation_error` | AR-4, AR-13 |
| In-bound token encoding/unknown/expired/used/revoked | 401 `join_failed` | AR-6 |
| Database failure | Propagate as 500; no raw SQL or key material | AR-9 |
| Service principal passed to a human credential path | 422/400 at service layer; trigger uses SQLSTATE `23514` | AR-14 |

## Testing Requirements

- Contract tests for every schema, strict-field rejection, name/TTL boundaries, status-code
  mapping, and response serialization.
- Migration tests: `ca_keys`, `join_tokens.revoked_at`, indexes, table/column counts, generated
  types, service-principal trigger rejection for the three human-credential tables, principal-kind
  immutability, and a full-credential update.
- Authorizer tests: org/project scope, auditor read-only, project-scoped `org.admin` denial,
  expired assignments, service actors, cross-project denial, and empty readable sets.
- Read-path tests (ST-82): service principals cannot resolve a browser status, CLI family, or
  OIDC linkage.
- Integration tests: create/list/detail/revoke/join-token over real HTTP and PostgreSQL; duplicate
  names; inactive project; idempotent revoke; 404 for foreign identities; all-retained certificate
  detail; no token in read responses.
- Existing auth, schema, transport, readiness, and logging suites remain green.

# Catalog, Schema, and Audit: RD-06 RBAC

> **Document**: 03-01-catalog-schema-audit.md
> **Parent**: [Index](00-index.md)

## Overview

This component freezes the public authorization vocabulary and the persistence that makes the
evaluator reliable. It owns the strict API contracts, the 25-action catalog, the nine-role matrix,
the scope-eligibility table, the `policy_state` row, the stable reason codes, and the audit port.
The evaluator and admin surfaces in [03-02](03-02-policy-evaluator.md) and
[03-03](03-03-assignments-access.md) consume these definitions; they never duplicate them.

The role matrix in [`docs/reference/roles.md`](../../../../../docs/reference/roles.md) is the oracle.
The constants in `apps/server/src/rbac/roles.ts` must match it row for row. A contract test
compares the encoded matrix with an explicit expected table, so a silent copy error fails the
build.

## Architecture

### Current Architecture

`packages/api-contract/src` has strict Zod schemas for identity and agent routes. The database
schema has `role_assignments` but no version row. The identity helper hard-codes four actions;
there is no action or role catalog, no reason vocabulary, and no decision audit port.

### Proposed Changes

1. Add `packages/api-contract/src/rbac.ts` with the action, role, scope, assignment, catalog,
   access-explain, and capability schemas; export it from `index.ts`.
2. Add `apps/server/src/rbac/actions.ts`, `roles.ts`, and `reasons.ts` as the single typed
   catalog. The server and tests import these constants; no string is re-typed at a call site.
3. Add `policy_state` to `apps/server/src/database/schema.ts`, generate the migration and
   snapshot, add one reviewed seed migration, and regenerate row types and CType constants.
4. Add `apps/server/src/rbac/audit.ts` with the decision/mutation event shapes, the audit port,
   and the logger adapter.
5. Add `apps/server/src/rbac/errors.ts` with the policy-unavailable and admin-service error
   families used by controllers.

## Implementation Details

### Action catalog

```ts
/** The 25 fixed actions. The order is the public catalog order. */
export const RBAC_ACTIONS = [
  "project.create", "project.read", "project.update", "project.delete",
  "identity.create", "identity.read", "identity.revoke", "identity.join_token",
  "assignment.read", "assignment.write", "audit.read", "kek.rotate",
  "secret.list", "secret.read", "secret.write", "secret.delete", "secret.recover",
  "secret.purge",
  "certificate.list", "certificate.read", "certificate.read_private",
  "certificate.write", "certificate.delete", "certificate.recover",
  "certificate.purge",
] as const;
```

`ACTION_DEFINITIONS` maps every action to `{ plane: "control" | "data", description }`. The
control-plane set is the first twelve; the data-plane set is the last thirteen. The description is
the one-line meaning published in the role reference.

### Role matrix

```ts
export interface RoleDefinition {
  readonly actions: readonly RbacAction[];
  readonly scopes: readonly RbacScopeType[];
}
```

| Role | Actions | Scopes |
|---|---|---|
| `org.admin` | all 25 | org |
| `project.admin` | `project.read`, `project.update`, `identity.create`, `identity.read`, `identity.revoke`, `identity.join_token`, `assignment.read`, `assignment.write`, all `secret.*`, all `certificate.*` | org, project |
| `secrets.manager` | `secret.list`, `secret.read`, `secret.write`, `secret.delete`, `secret.recover`, `secret.purge` | org, project |
| `secrets.officer` | `secret.list`, `secret.read`, `secret.write`, `secret.delete`, `secret.recover` | org, project |
| `secrets.reader` | `secret.list`, `secret.read` | org, project, object |
| `certificates.officer` | `certificate.list`, `certificate.read`, `certificate.read_private`, `certificate.write`, `certificate.delete`, `certificate.recover` | org, project |
| `certificates.reader` | `certificate.list`, `certificate.read` | org, project, object |
| `auditor` | `project.read`, `identity.read`, `assignment.read`, `audit.read`, `secret.list`, `certificate.list` | org, project |
| `reader` | `project.read`, `secret.list`, `certificate.list` | org, project |

> **Decision per AR-12:** `canManage` maps to `assignment.write`; the other four flags map to the
> object's read/write/delete/purge action.

All actions are unique across roles; a role never contains an action outside the catalog. The
object scope is legal only for `secrets.reader` and `certificates.reader`, matching the existing
database check.

### Contracts

`packages/api-contract/src/rbac.ts` owns these schemas. All objects are strict, so unknown fields
fail with a validation error.

```ts
export const rbacActionSchema = z.enum(RBAC_ACTIONS);
export const rbacRoleSchema = z.enum(RBAC_ROLES);
export const rbacScopeTypeSchema = z.enum(["org", "project", "object"]);

export const roleCatalogSchema = z.strictObject({
  actions: z.array(z.strictObject({
    name: rbacActionSchema,
    plane: z.enum(["control", "data"]),
    description: z.string().min(1).max(160),
  })),
  roles: z.array(z.strictObject({
    name: rbacRoleSchema,
    actions: z.array(rbacActionSchema),
    scopes: z.array(rbacScopeTypeSchema),
  })),
  policyVersion: z.number().int().nonnegative(),
});

export const assignmentSchema = z.strictObject({
  id: ulidSchema,
  principalId: ulidSchema,
  role: rbacRoleSchema,
  scopeType: rbacScopeTypeSchema,
  scopeId: z.string().min(1).max(26),
  grantedBy: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

export const assignmentCreateRequestSchema = z.strictObject({
  principalId: ulidSchema,
  role: rbacRoleSchema,
  scopeType: rbacScopeTypeSchema,
  scopeId: z.string().min(1).max(26),
  expiresAt: z.iso.datetime().optional(),
}).superRefine((value, context) => {
  // org requires scopeId === "org"; project/object require a ULID.
});

export const assignmentListQuerySchema = z.strictObject({
  principalId: ulidSchema.optional(),
  role: rbacRoleSchema.optional(),
  scopeType: rbacScopeTypeSchema.optional(),
  scopeId: z.string().min(1).max(26).optional(),
});

export const accessExplainQuerySchema = z.strictObject({
  action: rbacActionSchema,
  scopeType: rbacScopeTypeSchema.optional(),
  scopeId: z.string().min(1).max(26).optional(),
  objectType: z.enum(["secret", "certificate", "identity"]).optional(),
}).superRefine((value, context) => {
  // org accepts no scopeId or "org"; project/object require a ULID.
});

export const accessExplainConsumerSchema = z.strictObject({
  composeProject: z.string(),
  composeService: z.string(),
  hostname: z.string(),
  state: z.enum(["ok", "degraded", "failed"]),
  lastSeen: z.iso.datetime(),
});

export const accessExplainEntrySchema = z.strictObject({
  principalId: ulidSchema,
  name: z.string(),
  kind: z.enum(["user", "service"]),
  role: rbacRoleSchema,
  assignmentId: ulidSchema,
  scopeType: rbacScopeTypeSchema,
  scopeId: z.string().min(1).max(26),
  consumer: accessExplainConsumerSchema.nullable(),
});

export const accessExplainResponseSchema = z.strictObject({
  policyVersion: z.number().int().nonnegative(),
  action: rbacActionSchema,
  scope: z.strictObject({
    type: rbacScopeTypeSchema,
    id: z.string().min(1).max(26),
  }),
  principals: z.array(accessExplainEntrySchema),
});

export const capabilityFlagsSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
  canPurge: z.boolean(),
  canManage: z.boolean(),
});
```

The `scopeId` cross-field checks return `validation_error`. They do not decide role eligibility;
that is a policy rule and returns `invalid_scope` from the service.

### Policy state

Add to `apps/server/src/database/schema.ts`:

```ts
const policyState = db.table("policy_state");
policyState.smallint("id").default(1);
policyState.bigint("version").default(1);
policyState.timestamptz("updated_at").default("now()");
policyState.primaryKey().column("id");
policyState.checkConstraint("id = 1");
policyState.checkConstraint("version > 0");
```

The table has exactly one row. It exists so assignment changes can share one lock and one
monotonic version. The generated migration creates the table; a separate reviewed manual migration
seeds the row:

```sql
-- blendsdk-migration: 1
-- id: <generated-manual-id>_policy-state-seed
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

INSERT INTO policy_state (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
```

The migration must be generated with the BlendSDK CLI used by the project
(`pnpm --filter @openvault/server exec blendsdk migrate generate rbac-policy-state` with
`OPENVAULT_DB_URL` pointing at the migrated PostgreSQL 16 test database), then reviewed for the
table, checks, and snapshot. The seed migration follows the five-line header used by the existing
manual migrations.

### Reason codes

```ts
export type PolicyReason =
  | "allowed"
  | "inactive_principal"
  | "no_assignment"
  | "scope_mismatch"
  | "expired_assignment"
  | "service_control_plane"
  | "grant_scope_not_covered"
  | "grant_role_not_subset"
  | "grant_org_admin_forbidden"
  | "last_org_admin"
  | "unknown_principal"
  | "invalid_scope"
  | "duplicate_assignment";
```

The evaluator emits the first six. The assignment service emits the remaining seven in audit
events or stable API errors. Reason codes are lowercase snake case and never contain identifiers.

### Audit port

```ts
export interface PolicyAuditContext {
  readonly requestId?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

export interface PolicyDecisionEvent {
  readonly actorId: string;
  readonly actorKind: "user" | "service";
  readonly action: RbacAction;
  readonly scopeType: RbacScopeType | "system";
  readonly scopeId: string | null;
  readonly objectType: "project" | "identity" | "secret" | "certificate" | null;
  readonly objectId: string | null;
  readonly result: "allow" | "deny";
  readonly reason: DecisionReason;
  readonly policyVersion: number;
  readonly denialCount?: number;
  readonly context?: PolicyAuditContext;
}

export interface PolicyMutationEvent {
  readonly actorId: string;
  readonly actorKind: "user";
  readonly action: "assignment.grant" | "assignment.revoke";
  readonly assignmentId: string;
  readonly targetPrincipalId: string;
  readonly role: RbacRole;
  readonly scopeType: RbacScopeType;
  readonly scopeId: string;
  readonly result: "allow";
  readonly reason: "allowed";
  readonly policyVersion: number;
  readonly context?: PolicyAuditContext;
}

export interface PolicyAuditPort {
  recordDecision(event: PolicyDecisionEvent): Promise<void>;
  recordMutation(event: PolicyMutationEvent): Promise<void>;
}
```

`LoggingPolicyAudit` implements the port with the existing WebAFX `Logger`:

```ts
await logger.error("policy decision", { ...event });
await logger.error("policy mutation", { ...event });
```

Policy evidence is written on the error channel so it survives every supported log level. A
deployment that sets `OPENVAULT_LOG_LEVEL=warn` or `error` would otherwise silently drop
`info` records and let authorization proceed without evidence.

The adapter keeps a bounded per-principal denial counter (`Map<principalId, number>`, at most
1,024 principals, oldest insertion evicted). A denied decision includes `denialCount` so abuse
detection can consume the log without a second aggregation path. The counter is process-local and
resets on restart; RD-14 may aggregate it. A denied decision never includes a reason payload that
could leak a resource.

The event contains identifiers, scopes, result, reason, version, and the denial count only. It
never contains a secret value, private key, token, cookie, CSR, password, or request body. A
logger rejection propagates; the policy service maps it to `PolicyUnavailableError`, and the
controller returns 503. This is the accepted fail-closed behavior (AR-9).

### Error families

```ts
/** A policy read, version read, or audit write could not complete. */
export class PolicyUnavailableError extends Error {}

/** A stable admin API failure with an HTTP status and public code. */
export class RbacServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "access_denied"
    | "assignment_not_found"
    | "assignment_conflict"
    | "last_org_admin"
    | "service_control_plane"
    | "validation_error"
    | "service_unavailable";
}
```

`PolicyUnavailableError` is never thrown for an ordinary denial. Denials are successful
evaluations with `allowed: false` and a reason code.

## Integration Points

- [03-02](03-02-policy-evaluator.md) imports the catalog, reasons, audit port, and error families.
- [03-03](03-03-assignments-access.md) imports the contracts, assignment schema, reason codes, and
  error families.
- `packages/api-contract/src/index.ts` re-exports every new schema and inferred type.
- The existing identity runtime imports the policy service through the bridge described in
  [03-02](03-02-policy-evaluator.md) §Identity bridge.

## Error Handling

| Error Case | Handling Strategy | AR Ref |
|---|---|---|
| Unknown action or role in a request | Contract validation failure; 422 `validation_error` | AR-27 |
| org scope with a non-`org` id, or project/object with a non-ULID id | Contract cross-field failure; 422 | AR-27 |
| Missing `policy_state` row or unreadable version | `PolicyUnavailableError`; 503 `service_unavailable` | AR-21, AR-27 |
| Audit adapter rejects | Propagate; mutation transaction rolls back; 503 | AR-9 |
| Duplicate role/action entry in the catalog | Startup/test failure; the catalog is static code | AR-24 |
| Matrix drift from the published reference | Contract test failure; the build does not pass | AR-24 |

## Testing Requirements

- Contract tests for every schema, including strict unknown-field rejection and the org/project/
  object cross-field rules.
- Catalog tests for exactly 25 actions, nine roles, the full matrix, and scope eligibility.
- Migration tests for the `policy_state` table, one-row seed, checks, and generated types.
- Audit tests for the logger adapter field set, no secret content, and propagated failures.

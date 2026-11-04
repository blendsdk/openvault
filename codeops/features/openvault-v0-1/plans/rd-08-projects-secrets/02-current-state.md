# Current State: RD-08 Projects and Secrets

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The database schema already models every RD-08 object. `projects` has a validated name, an
optional display name, timestamps, a soft-delete timestamp, and a partial unique index on the
active name. `secrets` has a project foreign key, a validated name, a deferrable current-version
foreign key, JSONB tags, a content type, purge protection, timestamps, and a retention
timestamp. `secret_versions` stores the AES-GCM envelope columns, the creator, creation time,
and an optional expiry. `consumers` stores one row per service principal. `idempotency_keys`
stores a per-principal key, method, path, request hash, status, resource id, and expiry.
`audit_events` and the audit writer are complete from RD-07.

The database triggers already enforce the hard security rules. Secret versions reject every
update. Version and parent deletes are rejected unless the session user is `openvault_purger`,
the transaction sets `openvault.allow_purge`, the parent is soft-deleted, the retention time
has passed, and purge protection is off. Purge protection cannot be disabled.

The core crypto package exposes `encryptValue` and `decryptValue` with a fresh DEK, AES-256-GCM,
and a value AAD that binds project, object, and version. The DEK-wrap AAD omits the project.
The server's `KeyringProvider` wraps the KEK and zeroes recovered key material, but it is not a
`Keyring` subclass; the crypto functions need a narrow keyring interface that both satisfy. The policy engine evaluates the fixed action matrix over
organization, project, and object scopes and can compute the five secret capability flags.
The audit writer serializes inserts and exposes a persistent policy adapter.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/server/src/database/schema.ts` | Project, secret, version, consumer, idempotency schema | No schema change |
| `apps/server/migrations/20261030094213_triggers-and-seed.up.sql` | Immutability, purge, and audit triggers | No migration |
| `packages/core/src/crypto.ts` | Envelope encryption | Add `objectType`/project AAD, strict validation, and a keyring port |
| `packages/core/src/keyring.ts` | Core keyring | Satisfies the new envelope keyring port |
| `apps/server/src/config/{types,loader,redact}.ts` | Runtime configuration | Add optional purge URL and clamp the value limit |
| `apps/server/src/transport/pre-stack.ts` | Body limits | Add the `/v1/data` guard |
| `apps/server/src/security/keyring.ts` | KEK provider | Implement the envelope keyring port |
| `apps/server/src/rbac/policy-service.ts` | Decisions, list visibility, capabilities | Add multi-resource capabilities and joinable decision mode |
| `apps/server/src/rbac/policy-repository.ts` | Actor snapshot and assignment reads | Exclude assignments for soft-deleted projects |
| `apps/server/src/audit/policy-audit.ts` | Persistent decision adapter | Support joining a caller transaction |
| `apps/server/src/audit/audit-service.ts` | Business event facade | Reuse for purge outcomes and error evidence |
| `apps/server/src/controllers/identity.ts` | Controller pattern | Mirror for projects and secrets |
| `apps/server/src/identity/identity-service.ts` | Service pattern | Mirror for audit context and one-decision flow |
| `apps/server/src/app.ts` | Composition | Register data runtime, controllers, purge pool |
| `packages/api-contract/src/ids.ts` | Name patterns | Reuse `projectNameSchema` and `secretNameSchema` |
| `packages/api-contract/src/index.ts` | Public exports | Export project and secret contracts |

### Code Analysis

- `projects.name` already enforces `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`.
- `secrets.name` already enforces `^[A-Za-z0-9][A-Za-z0-9-]{0,126}$`.
- `secrets.current_version_id` is a deferrable foreign key, so an insert can create the
  secret, insert the version, and update the pointer in one transaction.
- `secret_versions.ciphertext` is limited to 65,536 bytes, but the loader currently allows
  `OPENVAULT_SECRET_MAX_BYTES` up to 1 MiB; the plan clamps it to 65,536 (AR-25).
- The `idempotency_keys.status` check is 100–599, so the final response status can be stored.
- `audit_events.project_id` references `projects`; a soft-deleted project still exists, so its
  audit history stays valid.
- The policy snapshot currently loads every assignment, so an assignment on a deleted project
  would still grant access unless the query is filtered.
- The existing envelope AAD is `ov:v1:{projectId}:{objectId}:{version}`; the wrap AAD omits
  the project, and the object type is absent from both.

## Gaps Identified

### Gap 1: No project or secret API

**Current Behavior:** No controller, route, contract, service, or repository exists for
projects or secrets. The API reference publishes the routes but nothing serves them.

**Required Behavior:** Project and secret routes with strict validation, policy decisions,
audit evidence, and stable error envelopes.

**Fix Required:** Add contracts, repositories, services, controllers, runtime wiring, and
tests.

### Gap 2: Envelope does not bind the object type

**Current Behavior:** A secret envelope and a future certificate envelope use the same AAD
shape, so a row moved between the tables would authenticate.

**Required Behavior:** The AAD must include `objectType=secret` and reject a certificate
envelope in a secret row.

**Fix Required:** Extend `EnvelopeAad` and the domain strings, and update the crypto tests.

### Gap 3: No purge credential path

**Current Behavior:** The trigger rejects deletes from the application role and requires
`openvault_purger`. No configuration or connection exists.

**Required Behavior:** A configured, least-privilege purge pool that checks the session user
and performs the guarded delete.

**Fix Required:** Add optional configuration, a purge connection, a test role helper, and
status mapping.

### Gap 4: Project deletion does not affect policy or access explanations

**Current Behavior:** Policy evaluation ignores project soft-delete state. An assignment on a
deleted project still grants decisions. `findObject` and `listExplainCandidates` can still
resolve objects and principals tied to a deleted project.

**Required Behavior:** A deleted project's secrets, certificates, identities, and assignments
are immediately unreachable, including access-explain and object-scope assignment creation.

**Fix Required:** Filter project- and object-scope assignments in the actor snapshot,
assignment reads, access-explain candidates, and object resolution, and check active projects
in every data route.

### Gap 5: No idempotency path

**Current Behavior:** The idempotency table is unused.

**Required Behavior:** A keyed retry returns the original version and does not create a second
version or decision event.

**Fix Required:** Add a transactional claim/replay mechanism used by secret create and value
write.

### Gap 6: No capability projection for lists

**Current Behavior:** `PolicyService.capabilitiesFor` loads an actor snapshot per call.

**Required Behavior:** A list of up to 100 secrets can return capabilities without 100 actor
snapshots.

**Fix Required:** Add a multi-resource capability method that loads one snapshot.

## Dependencies

### Internal Dependencies
- RD-06 policy engine and role matrix.
- RD-07 audit writer, persistent adapter, and request context.
- RD-05 keyring provider and consumer rows.
- Existing schema and triggers.

### External Dependencies
- Node.js 24 crypto.
- PostgreSQL 16 and 17.
- Existing Vitest, WebAFX, and BlendSDK patterns. No new package.

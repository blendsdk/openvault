# Server Contract: Certificate UI

> **Document**: 03-02-server-contract.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the additive server and contract changes: the certificate list status
filter, the name-or-subject search predicate, the `canRecover` and `canReadPrivate` capability
flags, and the generated browser client. It does not change certificate storage, cryptography,
validation, lifecycle rules, routes, or audit behavior.

## Architecture

### Current architecture

- `certificateListQuerySchema` accepts `q`, `san`, `expiresBefore`, `expiresAfter`, `limit`, and
  `cursor`; it has no status filter (`packages/api-contract/src/certificates.ts:150-172`).
- `CertificateRepository.listActiveCertificates` hard-codes `c.deleted_at IS NULL` and applies `q`
  to `v.subject` only (`apps/server/src/certificates/repository.ts:729-780`).
- `capabilityFlagsSchema` has five booleans (`packages/api-contract/src/rbac.ts:226-232`).
- `PolicyService` maps secret and certificate actions to those flags
  (`apps/server/src/rbac/policy-service.ts:94-107`, `496-558`).
- `WEB_CONTRACT_CONTROLLERS` omits `CertificatesController`
  (`apps/server/scripts/api-contract.ts:556-566`).

### Proposed changes

```text
packages/api-contract/src/certificates.ts   + status on the list query
packages/api-contract/src/rbac.ts           + canRecover + canReadPrivate
apps/server/src/certificates/repository.ts  status branch; name/subject q
apps/server/src/certificates/service.ts     pass status; zero flags; comments
apps/server/src/rbac/policy-service.ts      map the new flags
apps/server/src/secrets/service.ts          zero flags gain the new fields
apps/server/scripts/api-contract.ts         add the browser certificate controller
packages/api-contract/openapi.json          regenerated
apps/web/src/generated/*                    regenerated
```

## Implementation Details

### List query schema

```ts
export const certificateListQuerySchema = z
  .strictObject({
    q: z.string().min(1).max(1_024).refine(/* no control characters */).optional(),
    san: certificateSanSchema.optional(),
    expiresBefore: z.iso.datetime().optional(),
    expiresAfter: z.iso.datetime().optional(),
    status: z.enum(["active", "deleted"]).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .refine(/* expiresAfter <= expiresBefore */);
```

The default is applied by the schema so a caller that omits `status` keeps the old behavior.
[AR-5, PAR-02]

### Repository

Keep one read method; rename `listActiveCertificates` to `listCertificates` and update its call
sites. Add `status` to the filters:

```ts
interface CertificateListFilters {
  readonly q?: string;
  readonly san?: string;
  readonly expiresBefore?: string;
  readonly expiresAfter?: string;
  readonly status: "active" | "deleted";
  readonly cursor?: CertificateCursor;
  readonly limit: number;
}
```

Conditions:

```ts
const conditions = ["c.project_id = :projectId"];
conditions.push(
  filters.status === "deleted" ? "c.deleted_at IS NOT NULL" : "c.deleted_at IS NULL",
);
if (filters.q !== undefined) {
  conditions.push(
    "(c.name ILIKE :pattern ESCAPE '\\' OR v.subject ILIKE :pattern ESCAPE '\\')",
  );
  params.pattern = `%${escapeLike(filters.q)}%`;
}
```

The existing `escapeLike` behavior (replacing `\`, `%`, and `_`) is retained. The SAN and expiry
conditions, the join to the current version, the name/id cursor, and the `limit + 1` page probe are
unchanged. [AR-12, PAR-02]

The service passes `query.status` through. The list response's `status` field already derives from
`deletedAt` in `#metadata` (`apps/server/src/certificates/service.ts:884-912`), so no response
change is needed. [AR-5]

### Capability flags

```ts
export const capabilityFlagsSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
  canRecover: z.boolean(),
  canPurge: z.boolean(),
  canManage: z.boolean(),
  canReadPrivate: z.boolean(),
});
```

Mapping:

```ts
const SECRET_CAPABILITIES = {
  canRead: "secret.read",
  canWrite: "secret.write",
  canDelete: "secret.delete",
  canRecover: "secret.recover",
  canPurge: "secret.purge",
  canManage: "assignment.write",
  canReadPrivate: "secret.read",
} as const;

const CERTIFICATE_CAPABILITIES = {
  canRead: "certificate.read",
  canWrite: "certificate.write",
  canDelete: "certificate.delete",
  canRecover: "certificate.recover",
  canPurge: "certificate.purge",
  canManage: "assignment.write",
  canReadPrivate: "certificate.read_private",
} as const;
```

`capabilitiesFor` and `capabilitiesForMany` return the new fields; the zero-capability returns and
the two `ZERO_CAPABILITIES` constants return `false` for both. Update comments that say “five flags”
to “seven flags” or, preferably, “the capability flags” so they do not drift. [AR-7, AR-14, PAR-03]

### Browser contract

Add to `WEB_CONTRACT_CONTROLLERS`:

```ts
{ basePath: "/v1/data", controller: CertificatesController },
```

Update the comment that says certificates are deliberately absent. The browser document builds
each route from `WEB_ROUTE_DOCS`, so add every certificate route through `sharedRouteDoc`:

```ts
"GET /v1/data/:project/certificates": sharedRouteDoc("GET /v1/data/:project/certificates"),
"POST /v1/data/:project/certificates/import": sharedRouteDoc(
  "POST /v1/data/:project/certificates/import",
),
"POST /v1/data/:project/certificates/generate": sharedRouteDoc(
  "POST /v1/data/:project/certificates/generate",
),
"GET /v1/data/:project/certificates/:name": sharedRouteDoc(
  "GET /v1/data/:project/certificates/:name",
),
"GET /v1/data/:project/certificates/:name/private-key": sharedRouteDoc(
  "GET /v1/data/:project/certificates/:name/private-key",
),
"PATCH /v1/data/:project/certificates/:name": sharedRouteDoc(
  "PATCH /v1/data/:project/certificates/:name",
),
"DELETE /v1/data/:project/certificates/:name": sharedRouteDoc(
  "DELETE /v1/data/:project/certificates/:name",
),
"POST /v1/data/:project/certificates/:name/recover": sharedRouteDoc(
  "POST /v1/data/:project/certificates/:name/recover",
),
"POST /v1/data/:project/certificates/:name/purge": sharedRouteDoc(
  "POST /v1/data/:project/certificates/:name/purge",
),
```

The missing-document check for `WEB_ROUTE_DOCS` then passes, and the browser document uses cookie
authentication by default; the controller's `requirePrincipal` works unchanged. [AR-24, PAR-04]

Run:

```bash
pnpm api:generate
```

Expected generated changes:

- `apps/web/src/generated/client.certificates.ts` (new)
- `apps/web/src/generated/client.ts` (adds the `certificates` group)
- `apps/cli/src/generated/*` (the CLI contract gains the new query field and capability fields)
- `packages/api-contract/openapi.json` (the published CLI contract)
- `apps/web/src/generated/types.ts` (new fields and query parameters)

`pnpm api:check` must report no drift. [PAR-04]

### Compatibility

- The status default preserves the old list behavior for every existing caller.
- The broader `q` only adds results; it removes none.
- The capability fields are additive. Generated clients that ignore them still work.
- No database migration, route path, request field, response field removal, or error-code change.
- The existing rate limits, audit events, and authorization checks are unchanged. [AR-9, AR-11]

### Security

- The list route still authorizes `certificate.list` before reading rows. A caller without it sees
  the same denial as before.
- Deleted rows contain metadata only; the response schema has no PEM or private-key field. The
  public and private reads still reject deleted certificates through `#activeCertificate`.
- The capability projection is not an authorization decision; every route re-checks the action.
- The search pattern is parameterized and escapes LIKE metacharacters; no SQL is built from user
  input.
- The new flags expose only booleans about the caller's own access; they do not reveal another
  principal's grants. [AR-10, AR-11]

## Error Handling

| Error case | Handling | Ref |
|---|---|---|
| Invalid `status` value | Zod 422 `validation_error` | AR-5 |
| Invalid SAN or expiry range | Existing 422 validation | AR-12 |
| Caller lacks `certificate.list` | Existing project-not-found or access-denied behavior | AR-10 |
| Deleted certificate public/private read | Existing 404 `certificate_not_found` from `#activeCertificate` | AR-5 |
| Stale `expectedVersionId` | Existing 409 `certificate_version_conflict` | AR-18 |
| Purge preconditions | Existing 409 codes unchanged | AR-20 |

## Testing Requirements

- A schema test for `status` default, active, deleted, and invalid values.
- A repository/service integration test for active-only default, deleted-only filter, name search,
  subject search, SAN and expiry filters combined with status, and cursor pagination.
- A capability test for `canRecover` and `canReadPrivate` on `certificates.reader`,
  `certificates.officer`, `project.admin`, and `org.admin`.
- A generated-contract check through `pnpm api:check`.
- No test requires a live external service beyond the existing PostgreSQL test harness.
  [AR-25, PAR-11]

# Contracts and Schema: RD-04 CLI Authentication

> **Document**: 03-01-contracts-schema.md
> **Parent**: [Index](00-index.md)
> **References**: [AR-8](00-ambiguity-register.md#ar-8--contracts-and-errors), [AR-13](00-ambiguity-register.md#ar-13--migration-strategy), [AR-24](00-ambiguity-register.md#ar-24--cleanup-bounds)

## Overview

This component owns the public CLI wire contract and the database objects that back it. The
contracts are strict Zod schemas in `@openvault/api-contract`; the server, tests, and the future
CLI import the same definitions. The schema change is additive: one `signing_keys` table, one
partial unique index for live refresh rows, and one expression index for retention cleanup.

## Architecture

### Current architecture

Browser contracts live in `packages/api-contract/src/auth.ts` and are exported from
`packages/api-contract/src/index.ts`. The database schema is authored with
`blendsdk/codegen`'s `DatabaseSchema` in `apps/server/src/database/schema.ts`; generated types
and CType constants are committed. `cli_sessions` exists from the initial migration but has no
live-family uniqueness rule and no cleanup index.

### Proposed changes

1. Add `packages/api-contract/src/cli-auth.ts` with the schemas below and export them.
2. Add a `signing_keys` table to `schema.ts`.
3. Add `cli_sessions` indexes to `schema.ts`.
4. Generate one incremental migration and regenerate the schema snapshot and database types.
5. Extend schema and migration tests for the new objects.

## Implementation Details

### New contracts

```ts
// packages/api-contract/src/cli-auth.ts
import { z } from "zod";
import { authUserSchema, loginRequestSchema } from "./auth.js";
import { ulidSchema } from "./ids.js";

/** The login body; the browser schema already enforces 1–320 / 1–1024 bounds. */
export const cliLoginRequestSchema = loginRequestSchema;

/** A 32-byte refresh token encoded as unpadded base64url. */
export const cliRefreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Login and refresh response. The field names keep the two lifetimes distinct. */
export const cliTokenResponseSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: cliRefreshTokenSchema,
  tokenType: z.literal("Bearer"),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
  user: authUserSchema,
  mustChangePassword: z.boolean(),
});

/** Refresh body. Unknown fields are rejected. */
export const cliRefreshRequestSchema = z.strictObject({
  refreshToken: cliRefreshTokenSchema,
});

/** Logout body. Unknown fields are rejected. */
export const cliLogoutRequestSchema = z.strictObject({
  refreshToken: cliRefreshTokenSchema,
});

/** `/v1/auth/cli/me` response. */
export const cliMeResponseSchema = z.strictObject({
  user: authUserSchema,
  mustChangePassword: z.boolean(),
});

/** One CLI session family, without hashes or row ids. */
export const cliSessionEntrySchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

/** The current principal's CLI families, newest first. */
export const cliSessionListSchema = z.strictObject({
  sessions: z.array(cliSessionEntrySchema),
});
```

Export the schemas and these inferred types from `packages/api-contract/src/index.ts`:

- `CliLoginRequest`
- `CliTokenResponse`
- `CliRefreshRequest`
- `CliLogoutRequest`
- `CliMeResponse`
- `CliSessionEntry`
- `CliSessionList`

The `user` field reuses `authUserSchema`; CLI login always sets `authMethod: "local"`.

### Database model

Add this table to `apps/server/src/database/schema.ts` near the existing audit-key table:

| Column | Type | Constraints |
|---|---|---|
| `kid` | text | ULID check; primary key |
| `public_key` | bytea | `octet_length(public_key) = 32` |
| `wrapped_seed` | bytea | `octet_length(wrapped_seed) = 32` |
| `wrap_nonce` | bytea | `octet_length(wrap_nonce) = 12` |
| `wrap_tag` | bytea | `octet_length(wrap_tag) = 16` |
| `kek_id` | text | length 1–64 |
| `status` | text | `current`, `previous`, or `retired` |
| `created_at` | timestamptz | default `now()` |
| `activated_at` | timestamptz | not null |
| `retired_at` | timestamptz | nullable; required only for `retired` |

Add the consistency check:

```sql
(status = 'retired' AND retired_at IS NOT NULL)
OR (status <> 'retired' AND retired_at IS NULL)
```

Add partial unique indexes:

```sql
CREATE UNIQUE INDEX signing_keys_current_idx
  ON signing_keys (status) WHERE status = 'current';
CREATE UNIQUE INDEX signing_keys_previous_idx
  ON signing_keys (status) WHERE status = 'previous';
```

The first index is a one-row uniqueness rule in practice because `status` is constant within
the partial index. It enforces at most one `current` row. The second enforces at most one
`previous` row.

Add `cli_sessions` indexes:

```sql
-- A family can have only one unrevoked refresh row.
CREATE UNIQUE INDEX cli_sessions_family_live_idx
  ON cli_sessions (family_id) WHERE revoked_at IS NULL;

-- Supports the retention predicate: later of expiry and revocation.
CREATE INDEX cli_sessions_cleanup_idx
  ON cli_sessions ((GREATEST(expires_at, COALESCE(revoked_at, expires_at))));
```

Keep the existing `cli_sessions_refresh_hash_key` (unique), `cli_sessions_principal_idx`, and
`cli_sessions_family_idx`. The principal index covers the list-owner filter; the family index
covers family-wide revocation. Do not add a composite list index unless a query plan shows a
need.

### Migration and type regeneration

Use the repository's migration configuration, not a hand-written history edit:

```text
apps/server/blendsdk.migrations.ts
  schema: ./src/database/schema.ts
  migrationsDir: ./migrations
```

The execution task runs BlendSDK's incremental generator with the name `cli-auth`, reviews the
generated SQL, applies it to a disposable PostgreSQL database, regenerates
`apps/server/migrations/schema.snapshot.json` and the database types, and checks that no
generated file drift remains.

The generated migration must contain only additive objects. It must not alter or drop existing
columns. If the generator proposes a destructive change, stop and correct `schema.ts` before
continuing.

### Error handling

| Error case | Handling strategy | AR |
|---|---|---|
| Unknown body field | Strict Zod schema rejects with `400 validation_error` | AR-8 |
| Malformed refresh token | Contract regex rejects with `400 validation_error` | AR-8 |
| Valid contract with unknown token | Route returns the stable endpoint error, not a validation error | AR-8 |
| Generator proposes a destructive change | Stop; fix the desired schema; do not publish the migration | AR-13 |
| Generated types drift | `db:types:check` fails and blocks completion | AR-13 |
| Cleanup index cannot represent `GREATEST` | Check BlendSDK expression support; if unsupported, use a reviewed manual index migration and document why | AR-13, AR-24 |

> **Traceability:** Every schema and contract decision above is governed by AR-8, AR-13, and
> AR-24. The RD owns the field meanings and acceptance criteria.

## Testing Requirements

- Contract tests for each schema: valid shape, unknown field, malformed refresh token,
  distinct expiry fields, and missing required fields.
- Schema tests for the table inventory, `signing_keys` check constraints, partial unique
  indexes, and the cleanup expression index.
- Migration tests updated for one additional migration and one additional table.
- Generated-type tests must continue to compile and import.

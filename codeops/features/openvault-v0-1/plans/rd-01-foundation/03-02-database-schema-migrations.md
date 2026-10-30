# Database Schema and Migrations: RD-01 Foundation

> **Document**: 03-02-database-schema-migrations.md
> **Parent**: [Index](00-index.md)
> **Implementation**: BlendSDK `DatabaseSchema` + codegen migrations

## Overview

The schema is authored once in `apps/server/src/database/schema.ts` as a BlendSDK
`DatabaseSchema`. BlendSDK generates the baseline migration, validates the migration history,
runs the ledger-backed migration lifecycle, and introspects the migrated database for generated
row types and CType constants.

Objects that the relational model cannot express — audit/version triggers, the organization
seed, and future role/RLS provisioning — live in a reviewed manual migration created with
`blendsdk migrate create`.

## Architecture

- `apps/server/src/database/schema.ts` — desired-state `DatabaseSchema`.
- `apps/server/blendsdk.migrations.ts` — `defineMigrationConfig` with the schema module,
  `./migrations`, and `OPENVAULT_DB_URL`.
- `apps/server/migrations/` — generated baseline plus reviewed manual migrations.
- `apps/server/migrations/schema.snapshot.json` — canonical desired-state snapshot.
- `apps/server/scripts/generate-db-types.mjs` — introspects a migrated database and writes
  `generated-types.ts` and `ctypes.ts`.
- `apps/server/src/db/cli.ts` — CLI wrapper for `runMigrations`, `getMigrationStatus`, and
  `validateMigrations`.
- `apps/server/src/main.ts` — applies migrations before the WebAFX server starts.
- PostgreSQL 16 and 17.

## Schema surface

The model creates 18 product tables:

`org`, `projects`, `principals`, `local_credentials`, `oidc_identities`, `cli_sessions`,
`workload_certs`, `join_tokens`, `consumers`, `role_assignments`, `secrets`, `secret_versions`,
`certificates`, `certificate_versions`, `audit_keys`, `audit_events`, `audit_checkpoints`,
`idempotency_keys`.

BlendSDK adds the `blendsdk_migrations` ledger. The total after migration is 19 tables.

Key invariants:

1. Version rows are immutable after insert; only `current_version_id` moves.
2. Secret/certificate writes and their audit events commit in one transaction.
3. Soft-deleted rows are hidden by default; `purge_after` is derived from retention.
4. Purge protection is one-way and cannot be disabled.
5. Audit rows are never updated or deleted by application code.
6. A service identity must have exactly one owner project.
7. `role_assignments` scope is `org`, `project`, or `object`; object scope is limited to
   reader roles.
8. `bytea` columns store ciphertext, nonces, tags, wrapped keys, and hashes.
9. `inet` columns store source and session addresses.
10. ULID identifiers use the Crockford Base32 shape.

The model uses `bytea`, `inet`, deferrable composite FKs, partial unique indexes, JSONB
defaults, and regex CHECK constraints. These are supported by BlendSDK 5.68.1.

## Generated and manual migrations

### Generated baseline

```bash
pnpm --filter @openvault/server exec blendsdk migrate baseline initial \
  --config ./blendsdk.migrations.ts
```

The baseline contains tables, columns, checks, unique constraints, indexes, and foreign keys.
It is immutable after generation.

### Manual migration

The manual migration
`20261030094213_triggers-and-seed.up.sql` contains:

- the `OpenVault` organization seed;
- append-only audit triggers for events and checkpoints;
- version immutability triggers for secrets and certificates;
- the purge-role delete guard;
- the one-way purge-protection guard.

Manual SQL is reviewed code. It is never overwritten by `generateMigration`. Future manual
objects use:

```bash
pnpm --filter @openvault/server exec blendsdk migrate create <name> \
  --config ./blendsdk.migrations.ts
```

### Future schema changes

```bash
pnpm --filter @openvault/server exec blendsdk migrate generate <name> \
  --config ./blendsdk.migrations.ts
```

The command compares the desired model with `schema.snapshot.json`, publishes one immutable
migration plus the next snapshot, or reports `UP_TO_DATE`. Ambiguous, unsafe, and unsupported
changes are rejected.

## Migration runner

`runMigrations` is the only runtime runner. It:

- acquires the BlendSDK advisory lock;
- validates local files and ledger rows as an exact ordered prefix;
- records exact checksums;
- runs each migration in a transaction unless the file is explicitly marked non-transactional;
- tracks non-transactional dirty state;
- refuses invalid history.

Runtime commands:

```bash
pnpm db:migrate             # apply pending migrations
pnpm db:migrate --status    # report status
pnpm db:migrate --validate  # validate history
pnpm db:migrate --dry-run   # list pending work without mutation
```

`apps/server/src/main.ts` calls `runMigrations({ command: "up" })` before `app.start()`.
Startup exits non-zero on migration failure.

## Generated types and constants

After migrating a database:

```bash
OPENVAULT_DB_URL=postgres://... pnpm db:types
```

The script uses `PostgreSQLIntrospector`, `TypeGenerator`, and `CTypeGenerator`. It maps
`bytea` to `Buffer`, `jsonb` to `unknown`, and `inet` to `string`. The generated files are:

- `apps/server/src/database/generated-types.ts`;
- `apps/server/src/database/ctypes.ts`.

They are committed. `pnpm db:types:check` regenerates and fails on drift. The generated files
are excluded from Biome formatting but are typechecked.

The `blendsdk_migrations` ledger is excluded from generated domain types and constants.

## Test database helper

- Requires `TEST_DATABASE_URL` and `OPENVAULT_TEST_DB=1`.
- Requires a maintenance database whose name ends in `_test`.
- Requires a local host (`localhost`, `127.0.0.1`, `::1`).
- Creates a unique `openvault_test_<ulid>` database per run.
- Sets `OPENVAULT_DB_URL` only for the duration of codegen calls.
- Drops only its own database, with `WITH (FORCE)` after disconnect.
- Never runs `DROP SCHEMA public CASCADE`.
- Runs with `maxWorkers: 1`.

## Error Handling

| Error case | Handling |
|---|---|
| Missing `OPENVAULT_DB_URL` | Startup/CLI exits non-zero before binding HTTP |
| Invalid history or checksum | Codegen aborts with `INVALID_HISTORY` |
| Pending migrations | `PENDING` in dry-run/status |
| Lock contention | Codegen advisory lock; lock timeout surfaced |
| Failed migration SQL | Runner rolls back its transaction |
| Manual trigger SQL invalid | Migration fails; ledger is not advanced |
| Test DB guard fails | Suite exits without touching the database |
| Type drift | `db:types:check` exits non-zero |

## Known limitations

- `DatabaseSchema` does not model triggers, functions, RLS policies, or grants; these use the
  reviewed manual migration lane.
- The audit prune trigger requires the `openvault_pruner` session role. Version and parent
  purge triggers require the `openvault_purger` session role and an eligible retention window.
- Database role separation (`openvault_migrator`, `openvault_app`, `openvault_purger`,
  `openvault_pruner`) is owned by RD-13. Until it lands, deployment must not run the server as
  the table owner; CI uses the owner only to exercise rejection paths.
- The codegen migration ledger is named `blendsdk_migrations`, not `schema_migrations`.
- Generated types include `Buffer`; the server has Node types.
- `json`/`jsonb` map to `unknown`; consumers can use a `ColumnMapper` for object-shaped JSON.
- The version indexes are ascending; the prior `created_at DESC` ordering is not modeled by
  `DatabaseSchema`. This is a performance-only difference.
- `principals_user_email_idx` is rendered as an expression index. The codegen snapshot also
  records the supporting `email` column because the normalizer requires a column; the live
  index is still correct.

## Integration Points

- RD-02 consumes the migration config and startup hook.
- RD-03/04/05 use principals, credentials, sessions, certs.
- RD-06 uses assignments and object scope.
- RD-07 uses audit tables and triggers.
- RD-08/09 use secrets/certificates and immutability triggers.
- RD-13 uses the purge setting, roles, and backup/restore.

## Testing Requirements

- Full baseline + manual migration applies on PostgreSQL 16 and 17.
- Re-applying is a no-op.
- `getMigrationStatus` and `validateMigrations` report `UP_TO_DATE`.
- Dry-run reports pending migrations without creating tables or the ledger.
- Startup refuses a missing database URL.
- Test database helper creates and drops only its own database.
- Schema constraints, FKs, indexes, triggers, and org seed are asserted by the integration
  suite.
- Generated types and CType constants exist and compile.
- Codegen's own migration edge cases (checksum corruption, lock behavior, ordering) are
  covered by the upstream `blendsdk/codegen` test suite.

# Database Schema and Migrations: RD-01 Foundation

> **Document**: 03-02-database-schema-migrations.md
> **Parent**: [Index](00-index.md)

## Overview

This component defines the PostgreSQL schema, constraints, indexes, and the migration runner.
It is the persistence contract every later RD uses. The schema stores ciphertext and wrapped
keys only; it never stores plaintext secret values or private keys.

## Architecture

- PostgreSQL 16 and 17.
- Plain SQL migrations in `apps/server/migrations/`, applied in filename order.
- A TypeScript runner in `apps/server/src/db/migrate.ts` and a CLI in
  `apps/server/src/db/cli.ts`.
- `schema_migrations` records filename and SHA-256 checksum.
- One transaction for the complete migration run, guarded by a transaction-scoped advisory
  lock with a 30-second `lock_timeout`.
- Forward-only migrations; restoring an older backup is the rollback path.

## Migration files

```text
apps/server/migrations/
├── 0001_org_projects_principals.sql
├── 0002_auth_credentials_sessions.sql
├── 0003_workload_identity_consumers.sql
├── 0004_rbac.sql
├── 0005_secrets.sql
├── 0006_certificates.sql
├── 0007_audit.sql
└── 0008_idempotency.sql
```

`schema_migrations` is created by the runner after the advisory lock is acquired. The DDL
below shows its shape for reference; the runner owns creation and never treats it as a
product migration.

## Schema

### Organization, projects, principals

```sql
CREATE TABLE schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO org (id, name) VALUES (1, 'OpenVault') ON CONFLICT (id) DO NOTHING;

CREATE TABLE projects (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX projects_name_active_idx ON projects (name) WHERE deleted_at IS NULL;

CREATE TABLE principals (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL CHECK (kind IN ('user', 'service')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email text,
  owner_project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((kind = 'service' AND owner_project_id IS NOT NULL) OR
         (kind = 'user' AND owner_project_id IS NULL)),
  CHECK ((status = 'active' AND disabled_at IS NULL) OR
         (status = 'disabled' AND disabled_at IS NOT NULL)),
  UNIQUE (id, owner_project_id)
);
CREATE INDEX principals_owner_idx ON principals (owner_project_id);
CREATE UNIQUE INDEX principals_user_email_idx ON principals (lower(email))
  WHERE kind = 'user' AND email IS NOT NULL;
```

### Credentials and CLI sessions

```sql
CREATE TABLE local_credentials (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash ~ '^\$argon2id\$'),
  must_change boolean NOT NULL DEFAULT true,
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oidc_identities (
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 255),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE cli_sessions (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  refresh_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_hash) = 32),
  family_id text NOT NULL CHECK (family_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);
CREATE INDEX cli_sessions_principal_idx ON cli_sessions (principal_id);
CREATE INDEX cli_sessions_family_idx ON cli_sessions (family_id);
```

### Workload identity and consumers

```sql
CREATE TABLE workload_certs (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  serial text NOT NULL UNIQUE CHECK (length(serial) BETWEEN 1 AND 128),
  fingerprint text NOT NULL UNIQUE CHECK (length(fingerprint) BETWEEN 1 AND 128),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  revoked_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CHECK (not_after > not_before)
);
CREATE INDEX workload_certs_principal_idx ON workload_certs (principal_id);

CREATE TABLE join_tokens (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  principal_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (principal_id, project_id)
    REFERENCES principals (id, owner_project_id) ON DELETE CASCADE
);
CREATE INDEX join_tokens_principal_idx ON join_tokens (principal_id);

CREATE TABLE consumers (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  principal_id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  compose_project text NOT NULL CHECK (length(compose_project) BETWEEN 1 AND 100),
  compose_service text NOT NULL CHECK (length(compose_service) BETWEEN 1 AND 100),
  hostname text NOT NULL CHECK (hostname ~ '^[A-Za-z0-9._-]{1,255}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'degraded', 'failed')),
  FOREIGN KEY (principal_id, project_id)
    REFERENCES principals (id, owner_project_id) ON DELETE CASCADE
);
CREATE INDEX consumers_project_idx ON consumers (project_id);
```

### RBAC

```sql
CREATE TABLE role_assignments (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN (
    'org.admin', 'project.admin', 'secrets.manager', 'secrets.officer',
    'secrets.reader', 'certificates.officer', 'certificates.reader',
    'auditor', 'reader'
  )),
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'project', 'object')),
  scope_id text NOT NULL,
  granted_by text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CHECK (
    (scope_type = 'org' AND scope_id = 'org') OR
    (scope_type IN ('project', 'object') AND scope_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
  ),
  CHECK (
    scope_type <> 'object' OR role IN ('secrets.reader', 'certificates.reader')
  ),
  UNIQUE (principal_id, role, scope_type, scope_id)
);
CREATE INDEX role_assignments_principal_idx ON role_assignments (principal_id);
CREATE INDEX role_assignments_scope_idx ON role_assignments (scope_type, scope_id);
```

### Secrets

```sql
CREATE TABLE secrets (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$'),
  current_version_id text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tags) = 'object'),
  content_type text NOT NULL DEFAULT 'text/plain' CHECK (length(content_type) BETWEEN 1 AND 128),
  purge_protected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  CHECK (purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at)),
  UNIQUE (id, current_version_id)
);
CREATE UNIQUE INDEX secrets_name_active_idx ON secrets (project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX secrets_project_idx ON secrets (project_id);

CREATE TABLE secret_versions (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  secret_id text NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) <= 65536),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) = 32),
  wrap_nonce bytea NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrap_tag bytea NOT NULL CHECK (octet_length(wrap_tag) = 16),
  kek_id text NOT NULL CHECK (length(kek_id) BETWEEN 1 AND 64),
  created_by text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (secret_id, id)
);
CREATE INDEX secret_versions_secret_idx ON secret_versions (secret_id, created_at DESC);

ALTER TABLE secrets
  ADD CONSTRAINT secrets_current_version_fk
  FOREIGN KEY (id, current_version_id) REFERENCES secret_versions (secret_id, id)
  DEFERRABLE INITIALLY DEFERRED;
```

### Certificates

```sql
CREATE TABLE certificates (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$'),
  current_version_id text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tags) = 'object'),
  purge_protected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  CHECK (purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at)),
  UNIQUE (id, current_version_id)
);
CREATE UNIQUE INDEX certificates_name_active_idx ON certificates (project_id, name)
  WHERE deleted_at IS NULL;
CREATE INDEX certificates_project_idx ON certificates (project_id);

CREATE TABLE certificate_versions (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  certificate_id text NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  chain_pem text NOT NULL CHECK (length(chain_pem) <= 131072),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) <= 131072),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) = 32),
  wrap_nonce bytea NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrap_tag bytea NOT NULL CHECK (octet_length(wrap_tag) = 16),
  kek_id text NOT NULL CHECK (length(kek_id) BETWEEN 1 AND 64),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  subject text NOT NULL CHECK (length(subject) <= 1024),
  sans jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sans) = 'array'),
  issuer text NOT NULL CHECK (length(issuer) <= 1024),
  serial text NOT NULL CHECK (length(serial) BETWEEN 1 AND 128),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (certificate_id, id),
  CHECK (not_after > not_before)
);
CREATE INDEX certificate_versions_certificate_idx ON certificate_versions (certificate_id, created_at DESC);

ALTER TABLE certificates
  ADD CONSTRAINT certificates_current_version_fk
  FOREIGN KEY (id, current_version_id) REFERENCES certificate_versions (certificate_id, id)
  DEFERRABLE INITIALLY DEFERRED;
```

### Audit

```sql
CREATE TABLE audit_keys (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  wrapped_key bytea NOT NULL CHECK (octet_length(wrapped_key) = 32),
  wrap_nonce bytea NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrap_tag bytea NOT NULL CHECK (octet_length(wrap_tag) = 16),
  kek_id text NOT NULL CHECK (length(kek_id) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  ts timestamptz NOT NULL DEFAULT now(),
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
  actor_id text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service', 'system')),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'project', 'object', 'system')),
  scope_id text,
  object_type text CHECK (object_type IS NULL OR length(object_type) <= 64),
  object_id text CHECK (object_id IS NULL OR length(object_id) <= 64),
  result text NOT NULL CHECK (result IN ('allow', 'deny', 'error')),
  source_ip inet,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  prev_hash bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  hmac bytea NOT NULL CHECK (octet_length(hmac) = 32),
  audit_key_id text NOT NULL REFERENCES audit_keys(id),
  CHECK (
    (scope_type IN ('project', 'object') AND project_id IS NOT NULL) OR
    (scope_type IN ('org', 'system'))
  ),
  CHECK (actor_kind <> 'system' OR actor_id IS NULL)
);
CREATE INDEX audit_events_ts_idx ON audit_events (ts);
CREATE INDEX audit_events_project_idx ON audit_events (project_id, ts);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id);
CREATE INDEX audit_events_action_idx ON audit_events (action);
CREATE INDEX audit_events_object_idx ON audit_events (object_type, object_id);
CREATE INDEX audit_events_result_idx ON audit_events (result);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);

CREATE TABLE audit_checkpoints (
  id bigserial PRIMARY KEY,
  last_event_id bigint NOT NULL UNIQUE,
  last_hash bytea NOT NULL CHECK (octet_length(last_hash) = 32),
  hmac bytea NOT NULL CHECK (octet_length(hmac) = 32),
  audit_key_id text NOT NULL REFERENCES audit_keys(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### Idempotency

```sql
CREATE TABLE idempotency_keys (
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  method text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  resource_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
```

### Immutability and protection triggers

```sql
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('openvault.allow_audit_prune', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_checkpoints_no_delete BEFORE DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'version rows are immutable';
END;
$$;
CREATE TRIGGER secret_versions_no_update BEFORE UPDATE ON secret_versions
  FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE TRIGGER certificate_versions_no_update BEFORE UPDATE ON certificate_versions
  FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();

CREATE FUNCTION reject_version_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('openvault.allow_purge', true) = 'on'
     AND session_user = 'openvault_purger' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'version rows can only be deleted by the purge role';
END;
$$;
CREATE TRIGGER secret_versions_no_delete BEFORE DELETE ON secret_versions
  FOR EACH ROW EXECUTE FUNCTION reject_version_delete();
CREATE TRIGGER certificate_versions_no_delete BEFORE DELETE ON certificate_versions
  FOR EACH ROW EXECUTE FUNCTION reject_version_delete();

CREATE FUNCTION reject_purge_protection_disable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purge_protected AND NOT NEW.purge_protected THEN
    RAISE EXCEPTION 'purge protection cannot be disabled';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER secrets_purge_protection BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION reject_purge_protection_disable();
CREATE TRIGGER certificates_purge_protection BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION reject_purge_protection_disable();
```

### Maintenance roles

- `openvault_app`: runtime role. It has SELECT/INSERT/UPDATE on product tables but no DELETE
  or TRUNCATE on `audit_events`, `audit_checkpoints`, `secret_versions`, or
  `certificate_versions`.
- `openvault_purger`: may execute the secret/certificate purge functions only.
- `openvault_pruner`: may execute the audit prune function only.
- Roles are created by the RD-13 install/bootstrap script, not by migrations. RD-01 defines the
  trigger and function contract and tests the rejection paths; RD-13 tests a successful purge
  and prune.
- Purge functions check `purge_protected = false`, `deleted_at IS NOT NULL`, and
  `purge_after <= now()` before setting `openvault.allow_purge` and deleting.
- The audit prune function writes a checkpoint, sets `openvault.allow_audit_prune`, and
  deletes only events older than the retention window. RD-07 owns the exact function.
- The application role cannot set either GUC or TRUNCATE the tables.

## Migration runner

```ts
export interface Migration { id: string; checksum: string; sql: string; }

export async function migrate(db: PostgreSQLDatabase, dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("No migrations found");

  await db.withTransaction(async (tx) => {
    await tx.executeQuery("SET LOCAL lock_timeout = '30s'");
    await tx.executeQuery("SET LOCAL statement_timeout = '5min'");
    await tx.executeQuery("SELECT pg_advisory_xact_lock(hashtext('openvault_migrations'))");
    await tx.executeQuery(`CREATE TABLE IF NOT EXISTS schema_migrations (...)`);

    const applied = await tx.executeQuery<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM schema_migrations ORDER BY id",
    );
    const onDisk = new Map<string, string>();
    for (const file of files) {
      const sql = await readFile(join(dir, file), "utf8");
      const stripped = stripCommentsStringsAndDollarQuotes(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\s*;/im.test(stripped)) {
        throw new Error(`Migration ${file} must not contain top-level transaction control`);
      }
      onDisk.set(file, createHash("sha256").update(sql).digest("hex"));
    }
    const appliedIds = new Set(applied.records.map((r) => r.id));
    for (const row of applied.records) {
      if (!onDisk.has(row.id)) throw new Error(`Applied migration missing: ${row.id}`);
      if (onDisk.get(row.id) !== row.checksum) {
        throw new Error(`Migration checksum mismatch: ${row.id}`);
      }
    }
    const maxApplied = applied.records.at(-1)?.id;
    for (const file of files) {
      if (appliedIds.has(file)) continue;
      if (maxApplied && file < maxApplied) {
        throw new Error(`New migration ${file} sorts before the latest applied migration`);
      }
      await tx.executeQuery(await readFile(join(dir, file), "utf8"));
      await tx.executeQuery(
        "INSERT INTO schema_migrations (id, checksum) VALUES (:id, :checksum)",
        { id: file, checksum: onDisk.get(file)! },
      );
    }
  });
}
```

`stripCommentsStringsAndDollarQuotes` removes `--` comments, `/* */` comments, single-quoted
strings, and `$tag$...$tag$` blocks before the transaction-control scan. PL/pgSQL trigger
bodies therefore do not trigger a false positive. Top-level `BEGIN;`/`COMMIT;`/`ROLLBACK;`
still fail.

Runner rules:

- Advisory lock is acquired before `schema_migrations` creation.
- `lock_timeout` and `statement_timeout` prevent an indefinite startup hang.
- Applied migrations missing from disk, renamed, checksummed differently, or added out of
  order abort the run.
- Transaction-control statements in a migration are rejected.
- All migrations run in one transaction; a failure rolls back the whole run.
- `db:migrate --dry-run` lists pending ids and checksums without executing DDL.
- `apps/server/src/main.ts` calls the runner before `app.start()` using `OPENVAULT_DB_URL`.
  RD-02 later owns the full configuration layer; this bootstrap read is the migration
  contract. The integration helper sets `OPENVAULT_DB_URL` to the unique test database when
  it spawns the server for ST-19.
- The CLI exits non-zero on any failure and logs only migration ids.
- `db:migrate` accepts `OPENVAULT_DB_URL`; `--dry-run` does not require a writable database.

## Test database helper

- Requires `TEST_DATABASE_URL` and `OPENVAULT_TEST_DB=1`.
- `TEST_DATABASE_URL` points at a maintenance database whose name ends in `_test`.
- Requires the host to be `localhost`, `127.0.0.1`, `::1`, or the CI service name.
- Creates a unique database `openvault_test_<ulid>` for each run, connects to it, runs
  migrations, and drops that database after terminating its connections. The `_test` suffix
  guard applies to the maintenance `TEST_DATABASE_URL`, not to the generated name.
- The maintenance database is never modified.
- Never runs `DROP SCHEMA public CASCADE` and never reuses a database across runs.
- Runs with `maxWorkers: 1`; the unique database isolates parallel local runs.
- Requires `CREATEDB` privilege for the test user, documented in CONTRIBUTING.

## Error Handling

| Error case | Handling | AR Ref |
|---|---|---|
| Database unavailable | Startup fails; `/ready` 503 | P-01 |
| Checksum mismatch | Abort, log filename only, exit 1 | P-02 |
| Missing/renamed applied migration | Abort, log id only | P-02 |
| Out-of-order new migration | Abort, log id only | P-02 |
| Invalid SQL | Whole run rolls back, exit 1 | P-02 |
| Concurrent migrator | Advisory lock wait up to 30 s, then fail | P-02 |
| Transaction control in SQL | Abort | P-02 |
| Test DB guard fails | Suite exits without touching the database | P-15 |

## Integration Points

- RD-02 calls the runner before serving and uses the same DB connection.
- RD-03/04/05 use principals, credentials, sessions, certs.
- RD-06 uses assignments and the object-scope CHECK.
- RD-07 uses audit tables and the append-only triggers.
- RD-08/09 use secrets/certificates and the immutability triggers.
- RD-13 uses the purge setting and backup/restore.

## Testing Requirements

- Apply all migrations to empty PostgreSQL 16 and 17 databases.
- Apply twice; second run is a no-op.
- Checksum mismatch, missing applied migration, renamed migration, out-of-order migration,
  empty directory, failed SQL, and transaction-control SQL all abort.
- Two migrators on separate `PostgreSQLDatabase` instances finish without duplicate rows.
- Every table, FK, unique constraint, partial index, and CHECK exists.
- Cross-secret and cross-certificate current-version references are rejected.
- Direct UPDATE/DELETE on audit rows fails; direct UPDATE on version rows fails; direct
  DELETE fails unless `openvault.allow_purge=on`.
- Purge protection cannot be disabled.
- `org` row exists exactly once.
- Integration helper refuses a non-`_test` database, non-local host, or missing opt-in.

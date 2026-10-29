-- Workload certificates, join tokens, and registered Compose consumers.

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

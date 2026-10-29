-- Encrypted secret values and immutable secret versions.

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

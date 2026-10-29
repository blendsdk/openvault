-- Imported and self-signed certificates with immutable versions.

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

CREATE INDEX certificate_versions_certificate_idx ON certificate_versions (
  certificate_id,
  created_at DESC
);

ALTER TABLE certificates
  ADD CONSTRAINT certificates_current_version_fk
  FOREIGN KEY (id, current_version_id) REFERENCES certificate_versions (certificate_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Local credentials, OIDC identities, and rotating CLI sessions.

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

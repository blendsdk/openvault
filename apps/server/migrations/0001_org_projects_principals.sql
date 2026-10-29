-- Core organization, project, and principal records.

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
  CHECK (
    (kind = 'service' AND owner_project_id IS NOT NULL) OR
    (kind = 'user' AND owner_project_id IS NULL)
  ),
  CHECK (
    (status = 'active' AND disabled_at IS NULL) OR
    (status = 'disabled' AND disabled_at IS NOT NULL)
  ),
  UNIQUE (id, owner_project_id)
);

CREATE INDEX principals_owner_idx ON principals (owner_project_id);
CREATE UNIQUE INDEX principals_user_email_idx ON principals (lower(email))
  WHERE kind = 'user' AND email IS NOT NULL;

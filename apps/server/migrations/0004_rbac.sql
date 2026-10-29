-- Fixed roles and their organization, project, or object scopes.

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

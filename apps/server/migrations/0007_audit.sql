-- Hash-chained audit events, checkpoints, and immutable-row triggers.

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

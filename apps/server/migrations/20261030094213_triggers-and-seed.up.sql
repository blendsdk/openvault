-- blendsdk-migration: 1
-- id: 20261030094213_triggers-and-seed
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

INSERT INTO org (id, name) VALUES (1, 'OpenVault') ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('openvault.allow_audit_prune', true) = 'on'
     AND session_user = 'openvault_pruner' THEN
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
DECLARE
  parent_protected boolean;
  parent_deleted timestamptz;
  parent_purge_after timestamptz;
BEGIN
  IF current_setting('openvault.allow_purge', true) = 'on'
     AND session_user = 'openvault_purger' THEN
    IF TG_TABLE_NAME = 'secret_versions' THEN
      SELECT purge_protected, deleted_at, purge_after
        INTO parent_protected, parent_deleted, parent_purge_after
        FROM secrets WHERE id = OLD.secret_id;
    ELSE
      SELECT purge_protected, deleted_at, purge_after
        INTO parent_protected, parent_deleted, parent_purge_after
        FROM certificates WHERE id = OLD.certificate_id;
    END IF;

    IF FOUND
       AND parent_protected = false
       AND parent_deleted IS NOT NULL
       AND parent_purge_after IS NOT NULL
       AND parent_purge_after <= now() THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'version rows can only be deleted by the purge role after retention';
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

CREATE FUNCTION reject_parent_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_protected boolean;
  parent_deleted timestamptz;
  parent_purge_after timestamptz;
BEGIN
  IF current_setting('openvault.allow_purge', true) = 'on'
     AND session_user = 'openvault_purger' THEN
    IF TG_TABLE_NAME = 'secrets' THEN
      SELECT purge_protected, deleted_at, purge_after
        INTO parent_protected, parent_deleted, parent_purge_after
        FROM secrets WHERE id = OLD.id;
    ELSE
      SELECT purge_protected, deleted_at, purge_after
        INTO parent_protected, parent_deleted, parent_purge_after
        FROM certificates WHERE id = OLD.id;
    END IF;

    IF FOUND
       AND parent_protected = false
       AND parent_deleted IS NOT NULL
       AND parent_purge_after IS NOT NULL
       AND parent_purge_after <= now() THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'secrets and certificates can only be deleted by the purge role after retention';
END;
$$;

CREATE TRIGGER secrets_no_delete BEFORE DELETE ON secrets
  FOR EACH ROW EXECUTE FUNCTION reject_parent_delete();
CREATE TRIGGER certificates_no_delete BEFORE DELETE ON certificates
  FOR EACH ROW EXECUTE FUNCTION reject_parent_delete();

CREATE FUNCTION reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is not allowed on protected tables';
END;
$$;

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
CREATE TRIGGER secret_versions_no_truncate BEFORE TRUNCATE ON secret_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
CREATE TRIGGER certificate_versions_no_truncate BEFORE TRUNCATE ON certificate_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
CREATE TRIGGER secrets_no_truncate BEFORE TRUNCATE ON secrets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
CREATE TRIGGER certificates_no_truncate BEFORE TRUNCATE ON certificates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

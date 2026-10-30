-- blendsdk-migration: 1
-- id: 20261030094213_triggers-and-seed
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

INSERT INTO org (id, name) VALUES (1, 'OpenVault') ON CONFLICT (id) DO NOTHING;

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

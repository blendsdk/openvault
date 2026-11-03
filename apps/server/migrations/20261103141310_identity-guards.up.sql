-- blendsdk-migration: 1
-- id: 20261103141310_identity-guards
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

CREATE FUNCTION reject_service_human_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM principals
     WHERE id = NEW.principal_id
       AND kind = 'service'
  ) THEN
    RAISE EXCEPTION 'service principals cannot have human credentials'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_principal_kind_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'principal kind is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER principals_kind_immutable
  BEFORE UPDATE OF kind ON principals
  FOR EACH ROW EXECUTE FUNCTION reject_principal_kind_change();

CREATE TRIGGER local_credentials_service_guard
  BEFORE INSERT OR UPDATE ON local_credentials
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();

CREATE TRIGGER oidc_identities_service_guard
  BEFORE INSERT OR UPDATE ON oidc_identities
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();

CREATE TRIGGER cli_sessions_service_guard
  BEFORE INSERT OR UPDATE ON cli_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_service_human_credential();

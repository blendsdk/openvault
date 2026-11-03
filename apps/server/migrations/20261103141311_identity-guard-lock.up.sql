-- blendsdk-migration: 1
-- id: 20261103141311_identity-guard-lock
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

CREATE OR REPLACE FUNCTION reject_service_human_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  principal_kind text;
BEGIN
  SELECT p.kind
    INTO principal_kind
    FROM principals p
   WHERE p.id = NEW.principal_id
     FOR KEY SHARE;

  IF principal_kind = 'service' THEN
    RAISE EXCEPTION 'service principals cannot have human credentials'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

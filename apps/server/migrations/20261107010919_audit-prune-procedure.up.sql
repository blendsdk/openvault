-- blendsdk-migration: 1
-- id: 20261107010919_audit-prune-procedure
-- transaction: true
-- from-snapshot: 6806576fdf7e758415a6314cd8ba0dbd1a6e53be30375a4ef8a25cd80c2e10a5
-- to-snapshot: 6806576fdf7e758415a6314cd8ba0dbd1a6e53be30375a4ef8a25cd80c2e10a5

-- Deletes an audit prefix only when a short-lived authorization proves that the
-- application verified the retained chain, exported the prefix, and wrote the
-- boundary checkpoint. The pruner login role receives EXECUTE on this function
-- and no primitive table authority.
CREATE FUNCTION public.openvault_prune_audit_prefix(p_authorization_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_record public.audit_prune_authorizations%ROWTYPE;
  boundary_hash bytea;
  prefix_count integer;
  newest_ts timestamptz;
  deleted integer;
BEGIN
  IF session_user <> 'openvault_pruner' THEN
    RAISE EXCEPTION 'prune procedure requires the openvault_pruner session';
  END IF;

  -- Bound table growth without touching consumed authorizations that a
  -- receipt still references.
  DELETE FROM public.audit_prune_authorizations
   WHERE consumed_at IS NULL
     AND expires_at < now() - interval '1 day';

  SELECT * INTO auth_record
    FROM public.audit_prune_authorizations
   WHERE id = p_authorization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prune authorization not found';
  END IF;
  IF auth_record.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'prune authorization already consumed';
  END IF;
  IF auth_record.expires_at <= now() THEN
    RAISE EXCEPTION 'prune authorization expired';
  END IF;
  IF auth_record.database_name <> current_database() THEN
    RAISE EXCEPTION 'prune authorization database mismatch';
  END IF;

  SELECT hash INTO boundary_hash
    FROM public.audit_events
   WHERE id = auth_record.last_event_id;
  IF boundary_hash IS NULL OR boundary_hash <> auth_record.last_hash THEN
    RAISE EXCEPTION 'prune boundary mismatch';
  END IF;

  SELECT count(*)::int INTO prefix_count
    FROM public.audit_events
   WHERE id <= auth_record.last_event_id;
  IF prefix_count <> auth_record.expected_count THEN
    RAISE EXCEPTION 'prune prefix count mismatch';
  END IF;

  -- The boundary must not hide an event whose timestamp is newer than the
  -- retention cutoff. The application's boundary query enforces the same rule.
  SELECT max(ts) INTO newest_ts
    FROM public.audit_events
   WHERE id <= auth_record.last_event_id;
  IF newest_ts IS NOT NULL AND newest_ts >= auth_record.cutoff THEN
    RAISE EXCEPTION 'prune cutoff mismatch';
  END IF;

  PERFORM set_config('openvault.allow_audit_prune', 'on', true);
  DELETE FROM public.audit_events WHERE id <= auth_record.last_event_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> auth_record.expected_count THEN
    RAISE EXCEPTION 'prune delete count mismatch';
  END IF;

  UPDATE public.audit_prune_authorizations
     SET consumed_at = now()
   WHERE id = auth_record.id;

  INSERT INTO public.audit_prune_receipts
    (authorization_id, database_name, last_event_id, last_hash,
     deleted_count, export_sha256, completed_at)
  VALUES
    (auth_record.id, auth_record.database_name, auth_record.last_event_id,
     auth_record.last_hash, deleted, auth_record.export_sha256, now());

  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.openvault_prune_audit_prefix(text) FROM PUBLIC;

-- Keep the privilege contract self-contained for an existing database that
-- applies migrations without the separate grants job. The role guards make the
-- migration safe in development and test databases that do not create roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_pruner') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_pruner';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_pruner';
    EXECUTE 'REVOKE SELECT (id) ON audit_keys FROM openvault_pruner';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO openvault_pruner';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.openvault_prune_audit_prefix(text) TO openvault_pruner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_app') THEN
    EXECUTE 'REVOKE ALL ON audit_prune_authorizations, audit_prune_receipts FROM openvault_app';
    EXECUTE 'GRANT SELECT, INSERT ON audit_prune_authorizations TO openvault_app';
    EXECUTE 'GRANT SELECT ON audit_prune_receipts TO openvault_app';
  END IF;
END
$$;

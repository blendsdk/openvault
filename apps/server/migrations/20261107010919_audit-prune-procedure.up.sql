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

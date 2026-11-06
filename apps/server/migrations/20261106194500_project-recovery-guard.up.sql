-- blendsdk-migration: 1
-- id: 20261106194500_project-recovery-guard
-- transaction: true
-- from-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c
-- to-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c

-- A soft-deleted project has no supported recovery route. A direct database
-- write that clears deleted_at would make previously inert project/object
-- assignments live again, so reject it for every role.
CREATE OR REPLACE FUNCTION projects_guard_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_name text;
BEGIN
  SELECT tableowner INTO owner_name
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename = 'projects';

  -- The owner/migrator may repair a project during an operator-run restore.
  -- The runtime role never owns the table and cannot use this bypass.
  IF current_user = owner_name THEN
    RETURN NEW;
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'project recovery is not supported';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_guard_recovery ON projects;
CREATE TRIGGER projects_guard_recovery
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION projects_guard_recovery();

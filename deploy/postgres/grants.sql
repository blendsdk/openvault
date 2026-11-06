-- Runtime, purge, and prune grants for OpenVault.
--
-- Run after migrations as openvault_migrator. The file is idempotent and is
-- safe to re-run after a schema migration that adds a table the purge or prune
-- paths need explicitly.

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO openvault_app, openvault_purger, openvault_pruner;

-- The runtime role gets DML on application tables but never DDL and never
-- DELETE on the audit chain. The append-only trigger is defense in depth.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openvault_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openvault_app;
REVOKE DELETE ON audit_events FROM openvault_app;
REVOKE DELETE ON audit_checkpoints FROM openvault_app;
-- Key rows are append-only for the runtime role. CA and audit keys are never
-- updated after creation; signing keys need status updates for rotation.
REVOKE INSERT, UPDATE, DELETE ON ca_keys FROM openvault_app;
REVOKE UPDATE, DELETE ON audit_keys FROM openvault_app;
REVOKE DELETE ON signing_keys FROM openvault_app;

-- The purge role sees only the project name and the objects it may delete.
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificates TO openvault_purger;
GRANT SELECT, DELETE ON certificate_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificate_expiry_notifications TO openvault_purger;

-- The prune role can read the chain, delete a verified prefix, and write the
-- boundary checkpoint. It cannot read or modify application data.
GRANT SELECT, DELETE ON audit_events TO openvault_pruner;
GRANT SELECT, INSERT ON audit_checkpoints TO openvault_pruner;
GRANT SELECT (id) ON audit_keys TO openvault_pruner;
GRANT USAGE, SELECT ON SEQUENCE audit_checkpoints_id_seq TO openvault_pruner;

-- The migrator owns every table; assert the ownership contract explicitly so a
-- drifted deployment fails loudly instead of silently granting the app DDL.
DO $$
DECLARE
  wrong_owner integer;
BEGIN
  SELECT count(*) INTO wrong_owner
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT LIKE 'blendsdk_%'
     AND tableowner <> 'openvault_migrator';
  IF wrong_owner <> 0 THEN
    RAISE EXCEPTION 'openvault_migrator does not own % application tables', wrong_owner;
  END IF;
END
$$;

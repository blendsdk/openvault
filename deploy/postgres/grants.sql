-- Runtime, purge, prune, and backup grants for OpenVault.
--
-- Run after migrations as openvault_migrator. The file is idempotent and is
-- safe to re-run after a schema migration that adds a table the purge, prune,
-- backup, or runtime paths need explicitly.

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO openvault_app, openvault_auth, openvault_backup, openvault_purger, openvault_pruner;

-- Reset stale object privileges before granting the explicit allowlist. This
-- also removes privileges inherited from earlier blanket grants.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvault_pruner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvault_pruner;
REVOKE SELECT (id) ON audit_keys FROM openvault_pruner;

-- The data plane reads only projects, secrets, certificates, idempotency,
-- audit writing, and KEK-wrapped key material. It has no access to password,
-- refresh, join-token, OIDC-link, assignment, principal, consumer, workload
-- certificate, or policy-state tables.
GRANT SELECT, INSERT, UPDATE ON projects TO openvault_app;
GRANT SELECT, INSERT, UPDATE ON secrets TO openvault_app;
GRANT SELECT, INSERT ON secret_versions TO openvault_app;
GRANT SELECT, INSERT, UPDATE ON certificates TO openvault_app;
GRANT SELECT, INSERT ON certificate_versions TO openvault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON certificate_expiry_notifications TO openvault_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO openvault_app;
GRANT SELECT, INSERT ON audit_events TO openvault_app;
GRANT SELECT, INSERT ON audit_checkpoints TO openvault_app;
GRANT SELECT, INSERT ON audit_keys TO openvault_app;
GRANT SELECT, INSERT, UPDATE ON signing_keys TO openvault_app;
GRANT SELECT ON ca_keys TO openvault_app;
GRANT SELECT, INSERT ON audit_prune_authorizations TO openvault_app;
GRANT SELECT ON audit_prune_receipts TO openvault_app;
GRANT SELECT ON secret_consumer_summaries TO openvault_app;
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq, audit_checkpoints_id_seq, certificate_expiry_notifications_id_seq TO openvault_app;

-- New tables are not automatically readable by the data plane. A migration
-- that adds a runtime table must add its explicit grant above.
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM openvault_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM openvault_app;

-- The read-only backup role sees every application table and nothing else.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openvault_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO openvault_backup;

-- The control-plane role owns authentication, authorization, and agent
-- identity writes. It keeps the reads needed by policy, lock, and audit joins.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON principals, local_credentials, role_assignments, oidc_identities,
     cli_sessions, join_tokens, workload_certs, consumers
  TO openvault_auth;
GRANT SELECT, UPDATE ON projects TO openvault_auth;
GRANT SELECT ON secrets, certificates TO openvault_auth;
GRANT SELECT, UPDATE ON policy_state TO openvault_auth;
GRANT SELECT, INSERT ON audit_events, audit_checkpoints, audit_keys TO openvault_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openvault_auth;

-- The purge role sees only the project name and the objects it may delete.
GRANT SELECT ON projects TO openvault_purger;
GRANT SELECT, DELETE ON secrets TO openvault_purger;
GRANT SELECT, DELETE ON secret_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificates TO openvault_purger;
GRANT SELECT, DELETE ON certificate_versions TO openvault_purger;
GRANT SELECT, DELETE ON certificate_expiry_notifications TO openvault_purger;

-- The application records a single-use authorization after verification,
-- export, and checkpoint creation. The pruner can only execute the definer
-- procedure; it has no direct table, sequence, or column authority.
GRANT EXECUTE ON FUNCTION public.openvault_prune_audit_prefix(text) TO openvault_pruner;

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

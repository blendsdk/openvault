-- Ensures the read-only backup role exists on every deployment.
--
-- The Postgres init directory only runs on an empty data directory, so an
-- existing OpenVault database would otherwise miss openvault_backup. This file
-- is idempotent and is run by the openvault-roles job with the bootstrap
-- superuser before grants.sql. The migrator is intentionally NOCREATEROLE.
--
-- Required psql variable: backup_password (fed through stdin, never argv).

\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE openvault_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'backup_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_backup')
\gexec

ALTER ROLE openvault_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'backup_password';

REVOKE openvault_app, openvault_auth, openvault_purger, openvault_pruner, openvault_migrator
  FROM openvault_backup;

GRANT USAGE ON SCHEMA public TO openvault_backup;

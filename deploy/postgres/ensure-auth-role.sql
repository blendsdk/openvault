-- Ensures the control-plane role exists on every deployment.
--
-- The Postgres init directory only runs on an empty data directory, so an
-- existing OpenVault database would otherwise miss openvault_auth. This file is
-- idempotent and is run by the openvault-roles job with the bootstrap superuser
-- before grants.sql. The migrator role is intentionally not allowed to create
-- or alter roles.
--
-- Required psql variable: auth_password (fed through stdin, never argv).

\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'auth_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_auth')
\gexec

ALTER ROLE openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'auth_password';
ALTER ROLE openvault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE openvault_purger LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE openvault_pruner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Remove memberships in both directions. A stale GRANT openvault_auth TO
-- openvault_app would let the data plane SET ROLE and recover control-plane
-- access; a stale GRANT openvault_migrator TO openvault_pruner would restore
-- direct audit deletion. The bootstrap superuser runs this file, so it can
-- revoke memberships the migrator cannot.
REVOKE openvault_app, openvault_backup, openvault_purger, openvault_pruner, openvault_migrator FROM openvault_auth;
REVOKE openvault_auth FROM openvault_app, openvault_backup, openvault_purger, openvault_pruner, openvault_migrator;
REVOKE openvault_migrator, openvault_auth, openvault_backup, openvault_purger, openvault_pruner FROM openvault_app;
REVOKE openvault_migrator, openvault_auth, openvault_app, openvault_backup, openvault_purger FROM openvault_pruner;
REVOKE openvault_migrator, openvault_auth, openvault_app, openvault_backup, openvault_pruner FROM openvault_purger;
REVOKE openvault_app, openvault_auth, openvault_backup, openvault_purger, openvault_pruner FROM openvault_migrator;
REVOKE pg_read_all_data, pg_write_all_data, pg_execute_server_program, pg_signal_backend, pg_monitor FROM openvault_auth;

REVOKE CREATE ON SCHEMA public FROM openvault_auth;
GRANT USAGE ON SCHEMA public TO openvault_auth;

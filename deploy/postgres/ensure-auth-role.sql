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
  'CREATE ROLE openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'auth_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_auth')
\gexec

ALTER ROLE openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'auth_password';

REVOKE openvault_app, openvault_purger, openvault_pruner, openvault_migrator FROM openvault_auth;

GRANT USAGE ON SCHEMA public TO openvault_auth;

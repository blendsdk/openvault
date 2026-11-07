-- OpenVault least-privilege PostgreSQL roles.
--
-- This file is applied by init-roles.sh during first database creation, before
-- migrations run. It creates six login roles and makes the migrator the owner
-- of the database and schema. The runtime, backup, purge, and prune roles never
-- own a table and never receive DDL privileges.
--
-- Required psql variables:
--   dbname, migrator_password, app_password, auth_password, backup_password,
--   purger_password, pruner_password
--
-- Re-running the file is safe: role creation is guarded and ALTER ROLE only
-- resets the password and attributes.

\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE openvault_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_migrator')
\gexec

SELECT format(
  'CREATE ROLE openvault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_app')
\gexec

SELECT format(
  'CREATE ROLE openvault_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'auth_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_auth')
\gexec

SELECT format(
  'CREATE ROLE openvault_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'backup_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_backup')
\gexec

SELECT format(
  'CREATE ROLE openvault_purger LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'purger_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_purger')
\gexec

SELECT format(
  'CREATE ROLE openvault_pruner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'pruner_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_pruner')
\gexec

ALTER ROLE openvault_migrator PASSWORD :'migrator_password';
ALTER ROLE openvault_app PASSWORD :'app_password';
ALTER ROLE openvault_auth PASSWORD :'auth_password';
ALTER ROLE openvault_backup PASSWORD :'backup_password';
ALTER ROLE openvault_purger PASSWORD :'purger_password';
ALTER ROLE openvault_pruner PASSWORD :'pruner_password';

-- The migrator owns DDL. The runtime role must never be the table owner.
ALTER DATABASE :"dbname" OWNER TO openvault_migrator;
ALTER SCHEMA public OWNER TO openvault_migrator;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO openvault_app, openvault_auth, openvault_backup, openvault_purger, openvault_pruner;

-- Tables created by later migrations are not automatically exposed to the
-- data plane. Runtime privileges are granted explicitly in grants.sql. The
-- read-only backup role may see every new table.
ALTER DEFAULT PRIVILEGES FOR ROLE openvault_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO openvault_backup;

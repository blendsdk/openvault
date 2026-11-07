#!/bin/sh
# Creates the OpenVault PostgreSQL roles on first database initialisation.
#
# The official postgres image runs this script only when the data directory is
# empty. Passwords arrive as Docker secrets. They are fed to psql through stdin
# rather than command-line arguments so they do not appear in process lists.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

read_secret() {
  file="/run/secrets/$1"
  if [ ! -r "$file" ]; then
    echo "missing Docker secret: $1" >&2
    exit 1
  fi
  tr -d '\n' <"$file"
}

{
  printf "\\set dbname '%s'\n" "$POSTGRES_DB"
  printf "\\set migrator_password '%s'\n" "$(read_secret db_migrator_password)"
  printf "\\set app_password '%s'\n" "$(read_secret db_app_password)"
  printf "\\set auth_password '%s'\n" "$(read_secret db_auth_password)"
  printf "\\set backup_password '%s'\n" "$(read_secret db_backup_password)"
  printf "\\set purger_password '%s'\n" "$(read_secret db_purger_password)"
  printf "\\set pruner_password '%s'\n" "$(read_secret db_pruner_password)"
  cat /sql/roles.sql
} | psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1

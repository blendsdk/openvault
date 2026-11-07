#!/bin/sh
# Prepares the reference Compose stack's host directories and Docker secrets.
#
# Run once before the first `docker compose up`. The script is idempotent: it
# never overwrites an existing non-empty secret file or an existing data
# directory. It refuses symlinked paths so a local user cannot redirect a
# privileged chmod/chown/write.
#
# The service UIDs match the images: postgres 70, Caddy nobody 65534,
# OpenVault and the web server 10001/101. Run as root or with sudo-capable
# permissions so the ownership can be applied.
#
# `--quiet` suppresses the guidance and the non-root ownership warnings.
# `--secrets-only` also skips the directory section; the review script uses it
# because it applies the directory ownership afterwards through a one-shot
# container.
set -eu

QUIET=0
SECRETS_ONLY=0
case "${1:-}" in
  --quiet)
    QUIET=1
    ;;
  --secrets-only)
    # The review script applies the directory ownership itself. Skipping the
    # directory probes keeps a non-root re-run from descending into a directory
    # that is already owned by a container user.
    QUIET=1
    SECRETS_ONLY=1
    ;;
esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_DIR=${OPENVAULT_DATA_DIR:-$ROOT/data}
SECRETS_DIR=${OPENVAULT_SECRETS_DIR:-$ROOT/secrets}
UMASK=$(umask)
umask 077

fail() {
  echo "prepare: $*" >&2
  exit 1
}

assert_not_symlink() {
  if [ -L "$1" ]; then
    fail "refusing symlink: $1"
  fi
  return 0
}

# Reject relative traversal, trailing slashes, the filesystem root, and any
# symlinked path component. A missing final component is allowed; existing
# parents are checked.
assert_safe_path() {
  _safe_path=$1
  case "$_safe_path" in
    "")
      fail "empty path"
      ;;
    /)
      fail "refusing filesystem root"
      ;;
    *..*)
      fail "path must not contain '..': $_safe_path"
      ;;
    */)
      fail "path must not end with a slash: $_safe_path"
      ;;
  esac
  case "$_safe_path" in
    /*) ;;
    *) _safe_path=$PWD/$_safe_path ;;
  esac
  while [ "$_safe_path" != "/" ] && [ "${_safe_path%/}" != "$_safe_path" ]; do
    _safe_path=${_safe_path%/}
  done
  while [ "$_safe_path" != "/" ]; do
    assert_not_symlink "$_safe_path"
    _safe_path=$(dirname -- "$_safe_path")
  done
  return 0
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Writes stdin to a temporary file in the destination directory and moves it
# into place. The move replaces a final symlink instead of following it.
replace_file() {
  _replace_path=$1
  _replace_dir=$(dirname -- "$_replace_path")
  assert_safe_path "$_replace_dir"
  assert_not_symlink "$_replace_path"
  if [ -d "$_replace_path" ]; then
    fail "refusing directory at file path: $_replace_path"
  fi
  _replace_tmp=$(mktemp "$_replace_dir/.$(basename -- "$_replace_path").XXXXXX") ||
    fail "mktemp failed in $_replace_dir"
  trap 'rm -f "$_replace_tmp"' EXIT HUP INT TERM
  cat >"$_replace_tmp" || fail "write failed: $_replace_path"
  [ -s "$_replace_tmp" ] || fail "refusing to write an empty file: $_replace_path"
  chmod 0444 "$_replace_tmp"
  mv -f -- "$_replace_tmp" "$_replace_path"
  trap - EXIT HUP INT TERM
}

ensure_secret() {
  _secret_name=$1
  _secret_path="$SECRETS_DIR/$_secret_name"
  assert_safe_path "$_secret_path"
  if [ -e "$_secret_path" ] || [ -L "$_secret_path" ]; then
    assert_not_symlink "$_secret_path"
    [ -f "$_secret_path" ] || fail "secret path is not a regular file: $_secret_path"
    if [ -s "$_secret_path" ]; then
      chmod 0444 "$_secret_path"
      return 0
    fi
  fi
  if ! _secret_value=$(random_hex); then
    fail "secret generation failed: $_secret_name"
  fi
  if [ "${#_secret_value}" -ne 48 ]; then
    fail "secret generation returned an unexpected length: $_secret_name"
  fi
  printf '%s\n' "$_secret_value" | replace_file "$_secret_path"
}

install_dir() {
  _dir_path=$1
  _dir_owner=$2
  _dir_mode=$3
  assert_safe_path "$_dir_path"
  if [ -e "$_dir_path" ] || [ -L "$_dir_path" ]; then
    assert_not_symlink "$_dir_path"
    [ -d "$_dir_path" ] || fail "not a directory: $_dir_path"
  else
    mkdir -p -- "$_dir_path"
  fi
  assert_not_symlink "$_dir_path"
  if [ "$(id -u)" -eq 0 ]; then
    chown "$_dir_owner" "$_dir_path"
    chmod "$_dir_mode" "$_dir_path"
  elif [ "$QUIET" -eq 0 ]; then
    echo "warning: run as root to set ownership $_dir_owner and mode $_dir_mode on $_dir_path" >&2
  fi
}

assert_safe_path "$DATA_DIR"
mkdir -p -- "$DATA_DIR"
assert_not_symlink "$DATA_DIR"
chmod 0700 "$DATA_DIR"
assert_safe_path "$SECRETS_DIR"
mkdir -p -- "$SECRETS_DIR"
assert_not_symlink "$SECRETS_DIR"
chmod 0700 "$SECRETS_DIR"

if [ "$SECRETS_ONLY" -eq 0 ]; then
  install_dir "$DATA_DIR/postgres" "70:70" 0700
  install_dir "$DATA_DIR/openvault" "10001:10001" 0700
  install_dir "$DATA_DIR/bootstrap" "10001:10001" 0700
  install_dir "$DATA_DIR/tls" "10001:10001" 0700
  install_dir "$DATA_DIR/ca" "10001:10001" 0755
  install_dir "$DATA_DIR/caddy" "65534:65534" 0700
  install_dir "$DATA_DIR/caddy/data" "65534:65534" 0700
  install_dir "$DATA_DIR/caddy/config" "65534:65534" 0700
fi

ensure_secret postgres_password
ensure_secret db_migrator_password
ensure_secret db_app_password
ensure_secret db_auth_password
ensure_secret db_backup_password
ensure_secret db_purger_password
ensure_secret db_pruner_password

write_url() {
  _url_name=$1
  _url_user=$2
  _url_password_file=$3
  _url_path="$SECRETS_DIR/$_url_name"
  assert_safe_path "$_url_path"
  if [ -e "$_url_path" ] || [ -L "$_url_path" ]; then
    assert_not_symlink "$_url_path"
    [ -f "$_url_path" ] || fail "URL path is not a regular file: $_url_path"
    if [ -s "$_url_path" ]; then
      chmod 0444 "$_url_path"
      return 0
    fi
  fi
  assert_safe_path "$_url_password_file"
  assert_not_symlink "$_url_password_file"
  [ -f "$_url_password_file" ] || fail "password source is not a regular file: $_url_password_file"
  if ! _url_password=$(cat "$_url_password_file"); then
    fail "password source is unreadable: $_url_password_file"
  fi
  [ -n "$_url_password" ] || fail "password source is empty: $_url_password_file"
  printf 'postgres://%s:%s@postgres:5432/openvault\n' "$_url_user" "$_url_password" |
    replace_file "$_url_path"
}

write_url db_migrator_url openvault_migrator "$SECRETS_DIR/db_migrator_password"
write_url db_app_url openvault_app "$SECRETS_DIR/db_app_password"
write_url db_auth_url openvault_auth "$SECRETS_DIR/db_auth_password"
write_url db_backup_url openvault_backup "$SECRETS_DIR/db_backup_password"
write_url db_purger_url openvault_purger "$SECRETS_DIR/db_purger_password"

if [ ! -L "$ROOT/prepare.sh" ]; then
  chmod 0755 "$ROOT/prepare.sh" 2>/dev/null || true
fi

if [ "$QUIET" -eq 0 ]; then
  cat <<EOF
Prepared the OpenVault reference stack:
  data:    $DATA_DIR
  secrets: $SECRETS_DIR

Next:
  1. Set OPENVAULT_BASE_URL in the environment or a .env file.
  2. docker compose -f deploy/compose/compose.yaml up -d
  3. Read the one-time bootstrap password through the init container:
       install -m 0600 /dev/null /tmp/openvault-bootstrap
       docker compose -f deploy/compose/compose.yaml cp \
         openvault-init:/bootstrap/bootstrap-password /tmp/openvault-bootstrap
       cat /tmp/openvault-bootstrap
       rm -f /tmp/openvault-bootstrap
EOF
fi

umask "$UMASK"

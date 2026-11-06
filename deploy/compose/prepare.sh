#!/bin/sh
# Prepares the reference Compose stack's host directories and Docker secrets.
#
# Run once before the first `docker compose up`. The script is idempotent: it
# never overwrites an existing secret file or an existing data directory.
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

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

ensure_secret() {
  name=$1
  path="$SECRETS_DIR/$name"
  if [ ! -s "$path" ]; then
    random_hex >"$path"
  fi
  # Compose file secrets are bind mounts, so the container user must be able
  # to read the file. The 0700 secrets directory keeps other host users out;
  # inside the container only the single service process can reach the mount.
  chmod 0444 "$path"
}

install_dir() {
  path=$1
  owner=$2
  mode=$3
  if [ ! -d "$path" ]; then
    mkdir -p "$path"
  fi
  if [ "$(id -u)" -eq 0 ]; then
    chown "$owner" "$path"
    chmod "$mode" "$path"
  elif [ "$QUIET" -eq 0 ]; then
    echo "warning: run as root to set ownership $owner and mode $mode on $path" >&2
  fi
}

mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"
mkdir -p "$SECRETS_DIR"
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
ensure_secret db_purger_password
ensure_secret db_pruner_password

write_url() {
  name=$1
  user=$2
  password_file=$3
  path="$SECRETS_DIR/$name"
  if [ ! -s "$path" ]; then
    password=$(cat "$password_file")
    printf 'postgres://%s:%s@postgres:5432/openvault\n' "$user" "$password" >"$path"
  fi
  chmod 0444 "$path"
}

write_url db_migrator_url openvault_migrator "$SECRETS_DIR/db_migrator_password"
write_url db_app_url openvault_app "$SECRETS_DIR/db_app_password"
write_url db_purger_url openvault_purger "$SECRETS_DIR/db_purger_password"

chmod 0755 "$ROOT/prepare.sh" 2>/dev/null || true

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

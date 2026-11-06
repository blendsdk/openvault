#!/bin/sh
# Local, disposable review environment for OpenVault.
#
# The script builds the server and web images from the current checkout,
# prepares host directories and Docker secrets, starts the reference stack on
# loopback only, copies the generated CA and bootstrap password into
# data/review/, and seeds synthetic projects, secrets, certificates, and
# identities.
#
# Usage:
#   ./deploy/compose/review.sh up [--build] [--no-seed]
#   ./deploy/compose/review.sh status|password|forget-password|ca|seed|cli|logs|down|reset
#
# `reset` deletes the review database, keyring, generated CA, and Docker
# secrets. It refuses to delete custom data or secrets directories.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$ROOT/../.." && pwd)
DATA_DIR=${OPENVAULT_DATA_DIR:-$ROOT/data}
SECRETS_DIR=${OPENVAULT_SECRETS_DIR:-$ROOT/secrets}
PORT=${OPENVAULT_REVIEW_PORT:-8443}
BASE_URL="https://localhost:$PORT"
IMAGE_WAS_SET=${OPENVAULT_IMAGE:+1}
WEB_IMAGE_WAS_SET=${OPENVAULT_WEB_IMAGE:+1}
IMAGE=${OPENVAULT_IMAGE:-openvault:review}
WEB_IMAGE=${OPENVAULT_WEB_IMAGE:-openvault-web:review}
ADMIN_EMAIL=${OPENVAULT_REVIEW_ADMIN:-admin@openvault.local}

DATA_DIR=${DATA_DIR%/}
SECRETS_DIR=${SECRETS_DIR%/}

case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR=$(pwd)/$DATA_DIR ;;
esac
case "$SECRETS_DIR" in
  /*) ;;
  *) SECRETS_DIR=$(pwd)/$SECRETS_DIR ;;
esac

REVIEW_DIR=$DATA_DIR/review
SEEDED_MARKER=$REVIEW_DIR/.seeded

export OPENVAULT_IMAGE="$IMAGE"
export OPENVAULT_WEB_IMAGE="$WEB_IMAGE"
export OPENVAULT_DATA_DIR="$DATA_DIR"
export OPENVAULT_SECRETS_DIR="$SECRETS_DIR"
export OPENVAULT_BASE_URL="$BASE_URL"
export OPENVAULT_SITE_ADDRESS=localhost
export OPENVAULT_REVIEW_PORT="$PORT"
export OPENVAULT_REVIEW_ADMIN="$ADMIN_EMAIL"

die() {
  printf 'review: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'review: warning: %s\n' "$*" >&2
}

case "$PORT" in
  '' | *[!0-9]*) die "OPENVAULT_REVIEW_PORT must be a number between 1 and 65535" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "OPENVAULT_REVIEW_PORT must be between 1 and 65535"
fi

compose() {
  docker compose -f "$ROOT/compose.yaml" -f "$ROOT/compose.review.yaml" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required"
  docker compose version >/dev/null 2>&1 ||
    die "Docker Compose v2.24 or newer is required for the review overlay"
  docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon"
  command -v curl >/dev/null 2>&1 || die "curl is required"
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

ensure_images() {
  if [ "$IMAGE_WAS_SET" = 1 ]; then
    image_exists "$IMAGE" ||
      die "OPENVAULT_IMAGE=$IMAGE is not present; pull it or unset OPENVAULT_IMAGE to build local review images"
  elif [ "${BUILD:-0}" = 1 ] || ! image_exists "$IMAGE"; then
    printf 'Building %s from %s\n' "$IMAGE" "$REPO_ROOT"
    docker build -f "$ROOT/../docker/server.Dockerfile" -t "$IMAGE" "$REPO_ROOT"
  fi

  if [ "$WEB_IMAGE_WAS_SET" = 1 ]; then
    image_exists "$WEB_IMAGE" ||
      die "OPENVAULT_WEB_IMAGE=$WEB_IMAGE is not present; pull it or unset OPENVAULT_WEB_IMAGE to build local review images"
  elif [ "${BUILD:-0}" = 1 ] || ! image_exists "$WEB_IMAGE"; then
    printf 'Building %s from %s\n' "$WEB_IMAGE" "$REPO_ROOT"
    docker build -f "$ROOT/../docker/web.Dockerfile" -t "$WEB_IMAGE" "$REPO_ROOT"
  fi
}

proxy_running() {
  id=$(compose ps -q proxy 2>/dev/null || true)
  [ -n "$id" ] &&
    [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = "true" ]
}

check_port() {
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
      die "port $PORT is already in use; set OPENVAULT_REVIEW_PORT to another port"
    fi
  fi
}

apply_ownership() {
  # File-backed Compose secrets are bind mounts. The container users must be
  # able to read them, and the data directories must match the image UIDs.
  # Docker access is already root-equivalent on the host; this helper uses the
  # same trust boundary that `docker compose up` uses.
  docker run --rm --user 0 \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -v "$DATA_DIR:/data" \
    --entrypoint sh "$IMAGE" -c '
      set -eu
      mkdir -p /data/postgres /data/openvault /data/bootstrap /data/tls \
        /data/ca /data/caddy/data /data/caddy/config /data/review
      chown 70:70 /data/postgres
      chmod 0700 /data/postgres
      chown 10001:10001 /data/openvault /data/bootstrap /data/tls
      chmod 0700 /data/openvault /data/bootstrap /data/tls
      chown 10001:10001 /data/ca
      chmod 0755 /data/ca
      chown 65534:65534 /data/caddy /data/caddy/data /data/caddy/config
      chmod 0700 /data/caddy /data/caddy/data /data/caddy/config
      chown "$HOST_UID:$HOST_GID" /data/review
      chmod 0700 /data/review
    '
}

prepare_host() {
  printf 'Preparing host directories and Docker secrets\n'
  "$ROOT/prepare.sh" --secrets-only
  mkdir -p "$REVIEW_DIR"
  chmod 0700 "$REVIEW_DIR"
  apply_ownership
}

export_review_files() {
  docker run --rm --user 0 \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -v "$DATA_DIR:/data" \
    --entrypoint sh "$IMAGE" -c '
      set -eu
      if [ -f /data/caddy/data/caddy/pki/authorities/local/root.crt ]; then
        cp /data/caddy/data/caddy/pki/authorities/local/root.crt /data/review/ca.crt
        chown "$HOST_UID:$HOST_GID" /data/review/ca.crt
        chmod 0644 /data/review/ca.crt
      fi
      if [ -f /data/bootstrap/bootstrap-password ]; then
        cp /data/bootstrap/bootstrap-password /data/review/bootstrap-password
        chown "$HOST_UID:$HOST_GID" /data/review/bootstrap-password
        chmod 0600 /data/review/bootstrap-password
      fi
    '
}

wait_ready() {
  tried=0
  while [ "$tried" -lt 120 ]; do
    if curl -ksf --max-time 2 "$BASE_URL/ready" >/dev/null 2>&1; then
      return 0
    fi
    tried=$((tried + 1))
    sleep 2
  done
  compose ps >&2 || true
  die "the stack did not become ready; run '$0 logs' and check the output"
}

seed_stack() {
  if [ ! -s "$REVIEW_DIR/bootstrap-password" ]; then
    warn "the bootstrap password file is missing; skipping synthetic data"
    return 1
  fi
  if [ ! -s "$REVIEW_DIR/ca.crt" ]; then
    warn "the generated CA is missing; skipping synthetic data"
    return 1
  fi
  proxy=$(compose ps -q proxy)
  [ -n "$proxy" ] || die "the proxy container is not running"

  docker run --rm --network "container:$proxy" --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e OPENVAULT_URL=https://localhost \
    -e OPENVAULT_CA_FILE=/review/ca.crt \
    -e OPENVAULT_REVIEW_PASSWORD_FILE=/review/bootstrap-password \
    -e OPENVAULT_REVIEW_ADMIN="$ADMIN_EMAIL" \
    -v "$REVIEW_DIR/ca.crt:/review/ca.crt:ro" \
    -v "$REVIEW_DIR/bootstrap-password:/review/bootstrap-password:ro" \
    -v "$ROOT/review-seed.sh:/review/seed.sh:ro" \
    --entrypoint sh "$IMAGE" /review/seed.sh
}

print_summary() {
  printf 'OpenVault review environment is ready.\n\n'
  printf '  URL:       %s\n' "$BASE_URL"
  printf '  Admin:     %s\n' "$ADMIN_EMAIL"
  if [ -s "$REVIEW_DIR/bootstrap-password" ]; then
    printf '  Password:  %s\n' "$REVIEW_DIR/bootstrap-password"
  else
    printf '  Password:  removed; use the password you set in the UI\n'
  fi
  printf '  CA:        %s\n\n' "$REVIEW_DIR/ca.crt"

  if [ -s "$REVIEW_DIR/bootstrap-password" ]; then
    printf 'Read the password with:\n  %s password\n\n' "$0"
  fi

  cat <<EOF
The first browser visit shows a certificate warning because the proxy uses a
local CA. Choose "Advanced" and continue, or import the CA certificate above.
Change the password in the UI after the first login, then remove both host
copies of the one-time password:
  $0 forget-password

Useful commands:
  $0 status     health and container state
  $0 seed       add or repair the synthetic review data
  $0 cli        open a signed-in CLI shell
  $0 logs       recent service logs
  $0 down       stop the stack, keep the data
  $0 reset      delete the review data and start over
EOF
}

cmd_up() {
  require_docker
  if ! proxy_running; then
    check_port
  fi
  ensure_images
  if ! proxy_running; then
    prepare_host
  fi
  compose up -d
  wait_ready
  export_review_files
  if [ "$SEED" = 1 ] && [ ! -f "$SEEDED_MARKER" ]; then
    if seed_stack; then
      touch "$SEEDED_MARKER"
    else
      warn "synthetic data seeding failed; the stack is running, so you can retry with '$0 seed'"
    fi
  fi
  print_summary
}

cmd_status() {
  require_docker
  compose ps
  printf '\n'
  if curl -ksf --max-time 3 "$BASE_URL/health" >/dev/null 2>&1; then
    printf 'liveness: ready (%s/health)\n' "$BASE_URL"
  else
    printf 'liveness: not reachable (%s/health)\n' "$BASE_URL"
  fi
  if curl -ksf --max-time 3 "$BASE_URL/ready" >/dev/null 2>&1; then
    printf 'readiness: ready (%s/ready)\n' "$BASE_URL"
  else
    printf 'readiness: not ready (%s/ready)\n' "$BASE_URL"
  fi
}

cmd_password() {
  [ -s "$REVIEW_DIR/bootstrap-password" ] ||
    die "no bootstrap password is available; it may have been removed after the first login"
  cat "$REVIEW_DIR/bootstrap-password"
}

cmd_forget_password() {
  require_docker
  [ -d "$DATA_DIR" ] || die "the review environment has not been created"
  docker run --rm --user 0 \
    -v "$DATA_DIR:/data" \
    --entrypoint sh "$IMAGE" -c \
    'rm -f /data/bootstrap/bootstrap-password /data/review/bootstrap-password'
  printf 'Removed the one-time bootstrap password from the host data directory.\n'
  printf 'The current password is unchanged; use the browser or sign in again in the CLI.\n'
}

cmd_ca() {
  [ -s "$REVIEW_DIR/ca.crt" ] ||
    die "no generated CA is available; start the stack with '$0 up'"
  printf 'CA certificate: %s\n\n' "$REVIEW_DIR/ca.crt"
  printf 'Browser: continue past the local certificate warning, or import this file.\n'
  printf 'CLI: use --ca %s or OPENVAULT_CA_FILE=%s\n' \
    "$REVIEW_DIR/ca.crt" "$REVIEW_DIR/ca.crt"
  printf '\nOptional host trust store (may not affect every browser):\n'
  printf '  sudo cp %s /usr/local/share/ca-certificates/openvault-review.crt\n' \
    "$REVIEW_DIR/ca.crt"
  printf '  sudo update-ca-certificates\n'
}

cmd_seed() {
  require_docker
  export_review_files
  seed_stack
  touch "$SEEDED_MARKER"
}

cmd_cli() {
  require_docker
  export_review_files
  proxy=$(compose ps -q proxy)
  [ -n "$proxy" ] || die "the proxy container is not running"

  password_mount=$REVIEW_DIR/bootstrap-password
  password_mount_temp=
  if [ ! -s "$password_mount" ]; then
    password_mount_temp=$(mktemp "${TMPDIR:-/tmp}/openvault-review-password.XXXXXX")
    password_mount=$password_mount_temp
  fi
  trap 'rm -f "$password_mount_temp"' EXIT HUP INT TERM

  printf 'OpenVault CLI examples:\n'
  printf '  ov project list\n'
  printf '  ov cert list --project payments\n'
  printf '  ov access explain stripe-api-key --project payments --target-type secret\n'
  printf '  ov audit verify\n\n'

  tty=-i
  if [ -t 0 ] && [ -t 1 ]; then
    tty=-it
  fi

  # The interactive shell's credentials stay in the container's /tmp and are
  # discarded when the shell exits.
  # shellcheck disable=SC2086
  docker run --rm $tty \
    --network "container:$proxy" \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e OPENVAULT_URL=https://localhost \
    -e OPENVAULT_CA_FILE=/review/ca.crt \
    -e OPENVAULT_REVIEW_PASSWORD_FILE=/review/bootstrap-password \
    -e OPENVAULT_REVIEW_ADMIN="$ADMIN_EMAIL" \
    -v "$REVIEW_DIR/ca.crt:/review/ca.crt:ro" \
    -v "$password_mount:/review/bootstrap-password:ro" \
    --entrypoint sh "$IMAGE" -c '
      if ov auth login --identifier "$OPENVAULT_REVIEW_ADMIN" \
        --password-stdin < /review/bootstrap-password >/dev/null 2>&1; then
        printf "Signed in as %s.\n" "$OPENVAULT_REVIEW_ADMIN"
      else
        printf "The bootstrap password no longer works. Sign in inside the shell:\n"
        printf "  ov auth login --identifier %s\n" "$OPENVAULT_REVIEW_ADMIN"
      fi
      exec sh
    '
}

cmd_logs() {
  require_docker
  compose logs --tail=200 "$@"
}

cmd_down() {
  require_docker
  compose down --remove-orphans
  printf 'Stopped the review stack. Data is kept in %s\n' "$DATA_DIR"
}

remove_contents() {
  directory=$1
  [ -d "$directory" ] || return 0
  docker run --rm --user 0 \
    -v "$directory:/target" \
    --entrypoint sh "$IMAGE" -c \
    'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
}

cmd_reset() {
  require_docker
  [ "$DATA_DIR" = "$ROOT/data" ] ||
    die "refusing to delete custom OPENVAULT_DATA_DIR=$DATA_DIR; remove it manually"
  [ "$SECRETS_DIR" = "$ROOT/secrets" ] ||
    die "refusing to delete custom OPENVAULT_SECRETS_DIR=$SECRETS_DIR; remove it manually"

  if [ "$YES" != 1 ]; then
    printf 'This deletes the review database, keyring, generated CA, and Docker\n'
    printf 'secrets under:\n  %s\n  %s\n' "$DATA_DIR" "$SECRETS_DIR"
    printf "Type 'reset' to continue: "
    read -r answer
    [ "$answer" = reset ] || die "aborted"
  fi

  compose down --remove-orphans
  remove_contents "$DATA_DIR"
  remove_contents "$SECRETS_DIR"
  rmdir "$DATA_DIR" 2>/dev/null || true
  rmdir "$SECRETS_DIR" 2>/dev/null || true
  printf 'Removed the review data and secrets.\n'
  printf 'Run %s up to create a fresh environment.\n' "$0"
}

usage() {
  cat <<EOF
Usage: $0 <command> [options]

Commands:
  up [--build] [--no-seed]  Build if needed, start, and seed the review stack
  status                    Show container state and readiness
  password                  Print the one-time bootstrap password
  forget-password           Remove both host copies of the bootstrap password
  ca                        Show the generated CA path and trust options
  seed                      Add or repair the synthetic review data
  cli                       Open a signed-in shell for the ov CLI
  logs [service...]         Show the last 200 log lines
  down                      Stop the stack and keep the data
  reset [--yes]             Delete the review data and secrets

Environment:
  OPENVAULT_REVIEW_PORT     Host loopback port for the UI (default 8443)
  OPENVAULT_REVIEW_ADMIN    Bootstrap administrator email
  OPENVAULT_IMAGE           Override the server image (must already exist)
  OPENVAULT_WEB_IMAGE       Override the web image (must already exist)
EOF
}

COMMAND=${1:-up}
if [ $# -gt 0 ]; then
  shift
fi

BUILD=0
SEED=1
YES=0

case "$COMMAND" in
  up|start)
    while [ $# -gt 0 ]; do
      case "$1" in
        --build) BUILD=1 ;;
        --no-seed) SEED=0 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
      esac
      shift
    done
    cmd_up
    ;;
  status)
    cmd_status
    ;;
  password)
    cmd_password
    ;;
  forget-password|forget)
    cmd_forget_password
    ;;
  ca)
    cmd_ca
    ;;
  seed)
    cmd_seed
    ;;
  cli)
    cmd_cli
    ;;
  logs)
    cmd_logs "$@"
    ;;
  down|stop)
    cmd_down
    ;;
  reset)
    while [ $# -gt 0 ]; do
      case "$1" in
        --yes|-y) YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
      esac
      shift
    done
    cmd_reset
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    die "unknown command: $COMMAND"
    ;;
esac

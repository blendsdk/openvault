#!/bin/sh
# Local-only playground for the current checkout.
#
# It builds local playground images, starts an isolated reference stack on the
# loopback interface, seeds synthetic data, and prints the URL, credentials,
# and CA path. It does not publish images, create a release, or change the
# normal review stack.
#
# Usage:
#   ./deploy/compose/playground.sh up [--build] [--no-seed]
#   ./deploy/compose/playground.sh status|password|forget-password|ca|seed
#   ./deploy/compose/playground.sh logs [service...]|cli|down
#   ./deploy/compose/playground.sh reset [--yes]
#
# Everything lives under .playground/ by default. Override the directory or
# port with OPENVAULT_PLAYGROUND_DIR and OPENVAULT_PLAYGROUND_PORT.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$ROOT/../.." && pwd)
PLAYGROUND_DIR=${OPENVAULT_PLAYGROUND_DIR:-$REPO_ROOT/.playground}
PORT=${OPENVAULT_PLAYGROUND_PORT:-10443}
PROJECT=${OPENVAULT_PLAYGROUND_PROJECT:-openvault-playground}
IMAGE=${OPENVAULT_PLAYGROUND_IMAGE:-openvault:playground}
WEB_IMAGE=${OPENVAULT_PLAYGROUND_WEB_IMAGE:-openvault-web:playground}
ADMIN=${OPENVAULT_PLAYGROUND_ADMIN:-admin@playground.local}
SUBNET=${OPENVAULT_PLAYGROUND_SUBNET:-10.42.0.0/24}
PROXY_IP=${OPENVAULT_PLAYGROUND_PROXY_IP:-10.42.0.2}
SERVER_IP=${OPENVAULT_PLAYGROUND_SERVER_IP:-10.42.0.3}
BASE_URL="https://localhost:$PORT"
DATA_DIR=$PLAYGROUND_DIR/data
SECRETS_DIR=$PLAYGROUND_DIR/secrets
OVERRIDE=$ROOT/compose.playground.yaml

export COMPOSE_PROJECT_NAME="$PROJECT"
export OPENVAULT_DATA_DIR="$DATA_DIR"
export OPENVAULT_SECRETS_DIR="$SECRETS_DIR"
export OPENVAULT_REVIEW_PORT="$PORT"
export OPENVAULT_BASE_URL="$BASE_URL"
export OPENVAULT_SITE_ADDRESS=localhost
export OPENVAULT_REVIEW_ADMIN="$ADMIN"
export OPENVAULT_IMAGE="$IMAGE"
export OPENVAULT_WEB_IMAGE="$WEB_IMAGE"
export OPENVAULT_COMPOSE_EXTRA_FILE="$OVERRIDE"
export OPENVAULT_REVIEW_QUIET=1
export OPENVAULT_PLAYGROUND_SUBNET="$SUBNET"
export OPENVAULT_PLAYGROUND_PROXY_IP="$PROXY_IP"
export OPENVAULT_PLAYGROUND_SERVER_IP="$SERVER_IP"

die() {
  printf 'playground: %s\n' "$*" >&2
  exit 1
}

case "$PORT" in
  '' | *[!0-9]*) die "OPENVAULT_PLAYGROUND_PORT must be a number between 1 and 65535" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "OPENVAULT_PLAYGROUND_PORT must be between 1 and 65535"
fi

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required"
  docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon"
  docker compose version >/dev/null 2>&1 ||
    die "Docker Compose v2.24 or newer is required for the playground overlay"
}

build_images() {
  if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    printf 'Building %s from %s\n' "$IMAGE" "$REPO_ROOT"
    docker build -f "$REPO_ROOT/deploy/docker/server.Dockerfile" -t "$IMAGE" "$REPO_ROOT"
  fi
  if [ "$BUILD" = 1 ] || ! docker image inspect "$WEB_IMAGE" >/dev/null 2>&1; then
    printf 'Building %s from %s\n' "$WEB_IMAGE" "$REPO_ROOT"
    docker build -f "$REPO_ROOT/deploy/docker/web.Dockerfile" -t "$WEB_IMAGE" "$REPO_ROOT"
  fi
}

print_summary() {
  printf 'OpenVault playground is ready.\n\n'
  printf '  URL:       %s\n' "$BASE_URL"
  printf '  Admin:     %s\n' "$ADMIN"
  printf '  Password:  %s\n' "$DATA_DIR/review/bootstrap-password"
  printf '  CA:        %s\n\n' "$DATA_DIR/review/ca.crt"
  printf 'Read the one-time password with: %s password\n' "$0"
  printf 'The first browser visit shows a certificate warning; continue past it,\n'
  printf 'or import the generated CA.\n\n'
  printf 'Useful commands:\n'
  printf '  %s status|logs|seed|down|reset\n' "$0"
  printf '  %s up [--build]   rebuild after code changes\n' "$0"
}

cmd_up() {
  require_docker
  mkdir -p "$PLAYGROUND_DIR"
  build_images
  # review.sh owns the prepared host directories, Docker secrets, startup,
  # readiness wait, and synthetic seed. Its own summary is suppressed above.
  if [ "$SEED" = 1 ]; then
    "$ROOT/review.sh" up
  else
    "$ROOT/review.sh" up --no-seed
  fi
  print_summary
}

cmd_status() {
  require_docker
  "$ROOT/review.sh" status
}

cmd_logs() {
  require_docker
  "$ROOT/review.sh" logs "$@"
}

cmd_seed() {
  require_docker
  "$ROOT/review.sh" seed
}

cmd_password() {
  "$ROOT/review.sh" password
}

cmd_forget_password() {
  require_docker
  "$ROOT/review.sh" forget-password
}

cmd_ca() {
  "$ROOT/review.sh" ca
}

cmd_cli() {
  require_docker
  "$ROOT/review.sh" cli
}

cmd_down() {
  require_docker
  "$ROOT/review.sh" down
}

cmd_reset() {
  require_docker
  if [ "$YES" != 1 ]; then
    printf 'This deletes the playground database, keyring, CA, and secrets under:\n'
    printf '  %s\n  %s\n' "$DATA_DIR" "$SECRETS_DIR"
    printf "Type 'reset' to continue: "
    read -r answer
    [ "$answer" = reset ] || die "aborted"
  fi
  "$ROOT/review.sh" down || true
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker run --rm --user 0 -v "$PLAYGROUND_DIR:/playground" \
      --entrypoint sh "$IMAGE" -c 'rm -rf /playground/data /playground/secrets'
  else
    rm -rf "$DATA_DIR" "$SECRETS_DIR"
  fi
  printf 'Playground data removed. Local images are kept; run %s up to recreate.\n' "$0"
}

usage() {
  cat <<EOF
Usage: $0 <command> [options]

Commands:
  up [--build] [--no-seed]  Build if needed, start, and seed the playground
  status                    Show container state and readiness
  password                  Print the one-time bootstrap password
  forget-password           Remove both host copies of the bootstrap password
  ca                        Show the generated CA path and trust options
  seed                      Add or repair the synthetic playground data
  cli                       Open a signed-in shell for the ov CLI
  logs [service...]         Show the last 200 log lines
  down                      Stop the stack and keep the data
  reset [--yes]             Delete the playground data and secrets

Environment:
  OPENVAULT_PLAYGROUND_DIR       Data directory (default .playground)
  OPENVAULT_PLAYGROUND_PORT      Host loopback port (default 10443)
  OPENVAULT_PLAYGROUND_PROJECT   Compose project name (default openvault-playground)
  OPENVAULT_PLAYGROUND_ADMIN     Bootstrap administrator email
  OPENVAULT_PLAYGROUND_SUBNET    Private admin subnet; override the two IPs too
  OPENVAULT_PLAYGROUND_PROXY_IP  Proxy address on the admin subnet
  OPENVAULT_PLAYGROUND_SERVER_IP Server address on the admin subnet
  OPENVAULT_PLAYGROUND_IMAGE     Local server image tag
  OPENVAULT_PLAYGROUND_WEB_IMAGE Local web image tag
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

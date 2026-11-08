#!/bin/sh
# Prepare the host paths and start the environment-variable example.
#
# Run this from the example directory after starting the reference stack. It
# needs the one-time join token in .env and permission to create the agent's
# host directories (sudo is used when the current user is not root).
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Paste the one-time join token into OPENVAULT_JOIN_TOKEN, then run this script again." >&2
  exit 1
fi

. ./.env
: "${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME in .env}"
: "${OPENVAULT_JOIN_TOKEN:?set OPENVAULT_JOIN_TOKEN in .env}"

ca=../../deploy/compose/data/ca/ca.pem
if [ ! -r "$ca" ]; then
  echo "Cannot read $ca." >&2
  echo "Start the reference stack first: ./deploy/compose/prepare.sh && docker compose -f deploy/compose/compose.yaml up -d" >&2
  exit 1
fi

output_dir=/dev/shm/openvault/quickstart/$COMPOSE_PROJECT_NAME/api
state_dir=./openvault-state/quickstart/$COMPOSE_PROJECT_NAME/api

if [ "$(id -u)" -eq 0 ]; then
  SUDO=
else
  SUDO=sudo
fi
$SUDO install -d -m 0700 -o 10001 -g 10001 "$output_dir" "$state_dir"
$SUDO install -m 0444 -o 10001 -g 10001 "$ca" ./openvault-ca.pem

docker compose up -d

tries=0
while [ "$tries" -lt 60 ]; do
  if docker compose logs --no-color api 2>/dev/null | grep -q 'APP_API_TOKEN is set'; then
    echo "APP_API_TOKEN is set in the api container."
    exit 0
  fi
  tries=$((tries + 1))
  sleep 1
done

docker compose logs --no-color api >&2 || true
echo "The app did not report APP_API_TOKEN. Check the agent: docker compose logs openvault-agent-api" >&2
exit 1

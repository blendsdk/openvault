#!/bin/sh
# Load the agent's secret files as environment variables, then exec the app.
#
# The map is one NAME=file pair per line. Blank lines and lines starting with
# # are ignored. The loader validates both names, refuses symlinks and path
# components, and never evaluates file content as shell text.
#
# Environment-variable injection is for single-line values. A trailing newline
# is removed by the command substitution, and a NUL byte cannot be represented
# in an environment variable. Use the file delivery mode for binary or
# multi-line secrets.
set -eu
LC_ALL=C
export LC_ALL

env_map=${OPENVAULT_ENV_MAP:-/opt/openvault/env.map}
secret_dir=${OPENVAULT_SECRET_DIR:-/run/secrets}

if [ "$#" -eq 0 ]; then
  echo "load-env: no command to execute" >&2
  exit 2
fi
if [ ! -r "$env_map" ]; then
  echo "load-env: cannot read $env_map" >&2
  exit 1
fi
if [ ! -d "$secret_dir" ]; then
  echo "load-env: secret directory is missing: $secret_dir" >&2
  exit 1
fi

while IFS='=' read -r name file; do
  case "$name" in
    '' | '#'*) continue ;;
  esac
  case "$name" in
    '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "load-env: invalid environment name: $name" >&2
      exit 1
      ;;
  esac
  case "$file" in
    '' | */* | *..* | .* | *[!A-Za-z0-9._-]*)
      echo "load-env: invalid secret file for $name" >&2
      exit 1
      ;;
  esac
  path=$secret_dir/$file
  if [ -L "$path" ] || [ ! -f "$path" ]; then
    echo "load-env: missing regular secret file: $file" >&2
    exit 1
  fi
  value=$(cat "$path")
  export "$name=$value"
done < "$env_map"

exec "$@"

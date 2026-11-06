# Prepare Symlink Safety: Security Findings Remediation

> **Document**: 03-03-prepare-symlink-safety.md
> **Parent**: [Index](00-index.md)

## Overview

Harden `deploy/compose/prepare.sh` so operator-selected paths cannot redirect privileged writes, chmod, or chown through symlinks. Preserve the existing idempotency contract: a non-empty secret is never overwritten.

## Helpers

Use POSIX sh, unique variable names (no `local`), and explicit `if` blocks so `set -e` does not abort on a successful non-symlink check.

```sh
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

# Reject relative traversal, trailing slashes, and symlinked components.
assert_safe_path() {
  _safe_path=$1
  case "$_safe_path" in
    "") fail "empty path" ;;
    /) fail "refusing filesystem root" ;;
    *..*) fail "path must not contain ..: $_safe_path" ;;
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
```

The walk checks every existing component. `/tmp` and `/home` must not be symlinks on the supported Linux host; document that operator roots must be real directories. A nonexistent final component is allowed; its existing parents are checked.

## Atomic Creation

```sh
replace_file() {
  _replace_path=$1
  _replace_dir=$(dirname -- "$_replace_path")
  assert_safe_path "$_replace_dir"
  assert_not_symlink "$_replace_path"
  if [ -d "$_replace_path" ]; then
    fail "refusing directory at secret path: $_replace_path"
  fi
  _replace_tmp=$(mktemp "$_replace_dir/.$(basename -- "$_replace_path").XXXXXX") ||
    fail "mktemp failed in $_replace_dir"
  trap 'rm -f "$_replace_tmp"' EXIT HUP INT TERM
  cat >"$_replace_tmp" || fail "write failed: $_replace_path"
  chmod 0444 "$_replace_tmp"
  mv -f -- "$_replace_tmp" "$_replace_path"
  trap - EXIT HUP INT TERM
}
```

`mktemp` is not POSIX, but it is available in the supported Alpine/Linux images and is already used by the test stack. The script must keep a documented Linux requirement.

## Secret Rules

`ensure_secret`:

- If the path exists or is a symlink, reject a symlink and any non-regular entry.
- If it is a non-empty regular file, only `chmod 0444` it; never replace bytes.
- If it is absent or empty, generate through `replace_file`.

`write_url`:

- If the path exists or is a symlink, reject a symlink and any non-regular entry.
- If it is a non-empty regular file, only `chmod 0444` it; never replace bytes.
- If it is absent or empty, read the password file and write through `replace_file`.

`install_dir` and the roots:

- Call `assert_safe_path` before `mkdir` and again on the final path after `mkdir`.
- Reject a symlink or non-directory final entry.
- Keep `chown`/`chmod` only after the checks.

`--secrets-only` still creates both roots and all secret/URL files. Preserve `--quiet` output behavior.

Do not `chmod` `$ROOT/prepare.sh` when it is a symlink.

## Required Files

The script must continue to create:

- `postgres_password`, `db_migrator_password`, `db_app_password`, `db_auth_password`, `db_purger_password`, `db_pruner_password`.
- `db_migrator_url`, `db_app_url`, `db_auth_url`, `db_purger_url`.

The Phase 1 auth additions must survive the Phase 3 rewrite. ST-14 asserts every expected file.

## Tests

`apps/server/tests/security/prepare-symlink.spec.test.ts`:

- ST-11: non-empty target + `postgres_password` symlink → non-zero, content/mode unchanged.
- ST-12: empty target + `db_app_url` symlink → non-zero, target empty.
- ST-13: `OPENVAULT_DATA_DIR` symlink → non-zero, target mode unchanged.
- ST-14: normal `--secrets-only` run → both roots, every secret/URL file, `0444`, URL prefix.
- ST-14b: second run → exact byte equality for every secret and URL.
- ST-14c: trailing slash, `..`, and symlink-to-directory secret path → non-zero.
- ST-14d: fake `id`/`chown` PATH shim records calls; assert no chown/chmod targets `/` or a symlink target.
- ST-14e: assert the expected data subdirectories (`data/postgres`, `data/openvault`, etc.) exist in a full run.

Every test sets both `OPENVAULT_SECRETS_DIR` and `OPENVAULT_DATA_DIR` to a temporary tree. The script is invoked from the repository, but the test does not let it create repository secrets.

## Review Stack

`deploy/compose/review.sh:144-150` calls `prepare.sh --secrets-only` and relies on the top-level roots. Keep that contract and add a happy-path `--secrets-only` assertion.

## Acceptance

See `07-testing-strategy.md` ST-11…ST-14e and `01-requirements.md` R3.

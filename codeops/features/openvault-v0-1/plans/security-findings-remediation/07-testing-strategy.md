# Testing Strategy: Security Findings Remediation

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Specification Test Cases

These cases are the immutable oracle for this plan. They are written before implementation. A failing case after implementation means the implementation is wrong, not the test, unless the case itself is corrected through the plan’s ambiguity process.

### R1 — Control-plane database boundary

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-1 | Connect as `openvault_app`; check INSERT/UPDATE/DELETE on the eight control-plane tables | Every check is false | AR-2, AR-3, R1 |
| ST-2 | Connect as `openvault_auth`; check the same verbs | Every check is true | AR-2, R1 |
| ST-3 | `assertControlPlaneSeparation` with a writable app connection | Throws `AuthPrivilegeError` naming table and verb | AR-5, AR-14, R1 |
| ST-4 | `assertControlPlaneSeparation` with a correct app/auth pair | Resolves | AR-5, AR-14, R1 |
| ST-5 | Auth URL on a different database | Config error: must target the same database | AR-4, R1 |
| ST-6 | Test mode without auth URL | Valid; runtime falls back to app URL | AR-5, R1 |
| ST-7 | Restricted app/auth connections: local login, credential update, CLI family create/rotate | Login and credential update succeed on auth; app cannot write the credential tables | AR-2, R1 |
| ST-8 | Restricted connections: assignment insert/delete, OIDC identity insert, identity create/revoke, join-token issue/revoke, agent join/renew | All succeed through auth; app cannot write the control-plane tables | AR-2, AR-3, R1 |

### R2 — Signing-key integrity

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-9 | Previous row with a public key not derived from its seed; token signed by that key | `CliTokenError`; current-key token still verifies | AR-6, AR-7, R2 |
| ST-10 | Previous row with random seed and invalid tag | Not imported; current key works; rejection callback fires | AR-6, AR-7, R2 |
| ST-11 | `UPDATE signing_keys SET activated_at = ...` | PostgreSQL error; value unchanged | AR-6, R2 |
| ST-12 | `retired→current`, `current→retired`, `previous→current` | Rejected by trigger | AR-6, R2 |
| ST-13 | Normal `rotate()` and previous-key verification during overlap; `retired→retired` no-op | Rotation succeeds; previous token verifies until overlap ends; no-op allowed | AR-6, R2 |

### R3 — Prepare symlink safety

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-14 | Non-empty target; `postgres_password` symlink | Non-zero; content/mode unchanged | AR-8, R3 |
| ST-15 | Empty target; `db_app_url` symlink | Non-zero; target empty | AR-8, R3 |
| ST-16 | `OPENVAULT_DATA_DIR` symlink | Non-zero; target mode unchanged | AR-8, R3 |
| ST-17 | Clean roots; normal `--secrets-only` run | Both roots; every secret/URL file including auth; `0444`; URL prefix | AR-8, R3 |
| ST-18 | Second run | Every secret/URL byte is identical | AR-8, R3 |
| ST-19 | Trailing slash, `..`, symlink-to-directory secret path | Non-zero; no target change | AR-8, R3 |
| ST-20 | Fake `id`/`chown` shim; full run | No chown/chmod targets `/` or a symlink target; expected data subdirectories exist | AR-8, R3 |

### R4 — OIDC endpoint trust

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-21 | Cross-origin token endpoint, no allowlist | `OidcUnavailableError`; no fetch to that origin | AR-9, R4 |
| ST-22 | Cross-origin JWKS, UserInfo, authorization endpoint, no allowlist | Same rejection for each field | AR-9, R4 |
| ST-23 | Same four fields with the origin allowlisted | Discovery succeeds; requests reach the listed origin | AR-9, R4 |
| ST-24 | `http:` endpoint, wildcard origin, path/credentials in origin | `OidcUnavailableError` or ConfigError | AR-9, R4 |
| ST-25 | Redirect-aware stub; response has `Location` | Stub asserts `init.redirect === "error"`; no second request | AR-9, R4 |
| ST-26 | Existing same-origin fixture; full login/exchange in the integration suite | Login succeeds | AR-9, R4 |

### R5 — Purge evidence

| ST | Input | Expected output | Trace |
|---|---|---|---|
| ST-27 | Pre-delete audit failure | 503; secret exists; no delete | AR-10, R5 |
| ST-28 | First audit write succeeds, completion write throws | Secret deleted; `authorized` event exists; `completed` absent; 503 | AR-10, R5 |
| ST-29 | Successful secret purge | `authorized` then `completed`, exactly one each | AR-10, R5 |
| ST-30 | Delete failure | `authorized` + `failed`; no `completed` | AR-10, R5 |
| ST-31 | Certificate purge, ST-27…ST-30 | Same behavior for `certificate.purge` | AR-10, R5 |

### R6 — Collection visibility

| ST | Principal / route | Existing | Missing |
|---|---|---|---|
| ST-32 | Unassigned / secret read | 404 `secret_not_found` / `Resource not found` | Same |
| ST-33 | Unassigned / secret list existing project | 404 `project_not_found` / `Project not found` | Same |
| ST-34 | `reader`/`auditor` / secret read | 403 `access_denied` | 404 `secret_not_found` |
| ST-35 | Object-scope `secrets.reader` / assigned secret | 200 | — |
| ST-36 | Object-scope `secrets.reader` / other secret | 404 `secret_not_found` | 404 same |
| ST-37 | Other-project reader / secret in target project | 404 `secret_not_found` | 404 same |
| ST-38 | Unassigned / secret consumers existing vs missing | 404 same body | 404 same |
| ST-39 | Unassigned / certificate read | 404 `certificate_not_found` / `Resource not found` | Same |
| ST-40 | `reader`/`auditor` / certificate read | 403 `access_denied` | 404 `certificate_not_found` |
| ST-41 | `certificates.reader` / private key | 403 `access_denied` | 404 `certificate_not_found` |
| ST-42 | Object-scope `certificates.reader` / private key on assigned cert | 403 `access_denied` | — |
| ST-43 | Unassigned / certificate lifecycle (delete, recover, purge) | 404 `certificate_not_found` | 404 same |
| ST-44 | List-capable / certificate lifecycle missing name | 403 `access_denied` | 403 `access_denied` (documented) |

Every 404 pair asserts identical status, code, and message. The denial audit count is exactly one per request.

## Implementation Test Files

- `apps/server/tests/integration/security/auth-boundary.spec.test.ts` — ST-1…ST-8.
- `apps/server/tests/integration/auth/signing-keys.spec.test.ts` — ST-9…ST-13.
- `apps/server/tests/security/prepare-symlink.spec.test.ts` — ST-14…ST-20.
- `apps/server/tests/auth/oidc.impl.test.ts` and `apps/server/tests/config.spec.test.ts` — ST-21…ST-25.
- `apps/server/tests/integration/auth.oidc.test.ts` — ST-26.
- `apps/server/tests/integration/purge.spec.test.ts` — ST-27…ST-31.
- `apps/server/tests/integration/secrets.spec.test.ts`, `secrets-consumer-state.spec.test.ts`, `certificates-read.spec.test.ts`, `certificates-http.spec.test.ts` — ST-32…ST-44.

## Verification

- `pnpm verify`.
- `OPENVAULT_TEST_DB=1 TEST_DATABASE_URL=postgres://.../openvault_test pnpm test:integration` on PostgreSQL 16 and 17.
- `sh -n deploy/compose/prepare.sh`.
- `pnpm check:compose`.
- `pnpm security:evidence:check`, `pnpm security:claims:check`, `pnpm docs:build`.

## Red Phase

Each phase’s spec test must fail before its implementation. Record the failure reason in the execution plan. Compatibility tests (same-origin OIDC success, normal prepare run) do not need to fail on the old code; label them as compatibility coverage.

## Coverage Notes

The role-based suite uses real PostgreSQL roles and a disposable database, not the superuser maintenance connection. It covers representative auth, RBAC, identity, and agent paths. A full route-by-actor matrix covers the enumeration contract. The external review remains the release gate for adversarial review beyond these regressions.

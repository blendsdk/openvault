# Findings Ledger: RD-13 Operations

> **Status**: Active until merge
> **Last Updated**: 2026-11-06

| ID | Source | Finding | Resolution | Status |
|---|---|---|---|---|
| F-13-01 | Implementation | Docker builds initially failed because only the target package was built; workspace dependencies were not. | Build commands now use pnpm's `...` dependency selector. All three images build. | Closed |
| F-13-02 | Security review SEC-03 | The runtime container received the migrator URL and ran startup migrations. | Compose sets `OPENVAULT_RUN_MIGRATIONS=false`, removes the migrator secret from `openvaultd`, and runs migrations in the init job with the owner role. | Closed |
| F-13-03 | Security review ADR-03 | The runtime role had broad DML on key tables. | Grants now revoke insert/update/delete on `ca_keys`, update/delete on `audit_keys`, and delete on `signing_keys`; required runtime updates remain and are recorded as residual. | Closed with residual |
| F-13-04 | Security review ADR-04 | Role passwords were visible in psql argv. | Init feeds psql variables through stdin; the grants job reads the URL into libpq environment variables. | Closed |
| F-13-05 | Security review ADR-05 | The systemd units could not write their own target. | Install commands create `0700 openvault` directories and chown the environment file; the off-box copy is optional. | Closed |
| F-13-06 | Security review ADR-06 | Caddy was fixed to `localhost` while docs used another host. | `OPENVAULT_SITE_ADDRESS` now controls the Caddy site address and is documented next to `OPENVAULT_BASE_URL`. | Closed |
| F-13-07 | Security review ADR-08 | Host paths were keyed only by Compose project and service. | Paths now include the OpenVault project; the renderer test proves two projects with the same service do not collide. | Closed |
| F-13-08 | Security review ADR-09 | The Compose check missed UID 0, capability additions, non-required services, and mutable images. | The checker now covers those cases and has negative self-tests. | Closed |
| F-13-09 | Security review ADR-10 | Concurrent restores could overlap. | `restoreDatabase` takes a session advisory lock on the target database. | Closed |
| F-13-10 | Security review ADR-07 | A lost join response still needs a new token. | Accepted v0.1 limitation; documented. | Accepted |

## Verification Evidence

- `pnpm verify`: passed.
- PostgreSQL 16 integration: 90 files, 701 tests passed.
- PostgreSQL 17 integration: 90 files, 701 tests passed.
- `pnpm check:compose --self-test`: `COMPOSE CONTRACT OK`.
- Server, agent, and web images built locally; web smoke test served the SPA with CSP and `healthz`.

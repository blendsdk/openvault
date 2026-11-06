# Ambiguity Register: RD-13 Operations

> **Status**: ✅ GATE PASSED — all 12 items resolved
> **Last Updated**: 2026-11-06 18:00

| # | Category | Ambiguity / Gap | Options Presented | Decision | Status |
|---|----------|-----------------|-------------------|----------|--------|
| 1 | Scope | Which RD-13 Must Haves are already delivered by RD-11? | Re-implement / extend | Extend `ov backup`, `ov restore`, and `ov kek rotate`; do not add a second backup format. | ✅ Resolved |
| 2 | Technical | How to verify a pre-backup agent certificate when agent PEMs are not stored | Store every agent cert / accept an operator-supplied PEM / skip | Add optional `--agent-certificate` to restore. The drill captures a live agent certificate before backup and verifies chain, principal, and validity after restore. | ✅ Resolved |
| 3 | Security | Where does the database password live in Compose? | Environment interpolation / Docker secret / file | Docker secret containing the full app URL for the server, and a password file for PostgreSQL. Add `OPENVAULT_*_DB_URL_FILE` support so no secret is rendered into the Compose model. | ✅ Resolved |
| 4 | Technical | Who owns the schema? | Runtime role owns / migrator owns | Database and tables are owned by `openvault_migrator`; the server starts with `OPENVAULT_DB_URL` as `openvault_app` and runs migrations with `OPENVAULT_MIGRATION_DB_URL`. | ✅ Resolved |
| 5 | Deployment | Is the UI a separate service or served by the API? | Separate static container / server-served SPA | Add a non-root `web` static container. The proxy routes `/v1`, `/health`, and `/ready` to the API and everything else to `web`. The server retains its optional SPA support for non-Compose deployments. | ✅ Resolved |
| 6 | Deployment | Proxy ports | 80 and 443 / 443 only | Publish 443 only. The reference stack uses `tls internal`; HTTP-01 is not needed. | ✅ Resolved |
| 7 | Operations | How is the pre-backup agent certificate captured? | New API route / read audit / operator file | Operator file. The drill stores the certificate PEM next to the backup and passes it to restore; no schema change. | ✅ Resolved |
| 8 | Operations | Scheduled off-box checkpoint export | New service / systemd units / cron only | Ship systemd service and timer units plus documented cron equivalents. No new daemon. | ✅ Resolved |
| 9 | Operations | Backup age check in `ov doctor` | Server API / local filesystem | Local filesystem. `--backup-dir` (or `OPENVAULT_BACKUP_DIR`) selects the directory; the newest `*.age` file must be within the 24-hour RPO. | ✅ Resolved |
| 10 | Build | Base images and digests | Floating tags / digest pins | Pin every third-party base image by digest in Dockerfiles and the reference Compose file. First-party images use an explicit release tag until the RD-14 pipeline publishes digests. | ✅ Resolved |
| 11 | Verification | How is Compose hardening kept honest? | Review only / scripted contract | Add `scripts/check-compose.mjs` to `pnpm verify`. It checks read-only roots, capability drops, no-new-privileges, limits, logging, published ports, internal networks, and Docker-secret use. | ✅ Resolved |
| 12 | Scope | Should the plan add `ov migrate`? | New command / startup migration | Startup migration already exists. Use `OPENVAULT_MIGRATION_DB_URL` for startup and keep `pnpm db:migrate` for development. | ✅ Resolved |

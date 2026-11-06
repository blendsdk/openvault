# Preflight Report: RD-13 Operations

> **Status**: ✅ PASS — no unresolved Critical or Major finding
> **Date**: 2026-11-06 18:00
> **Scope**: RD-13 requirements against `main` at `cae3197`

## Method

Read the RD-13 requirement, the RD-11 operations plan, the current Compose files, the backup,
restore, KEK, init, doctor, audit-checkpoint, logging, readiness, role, and migration code, and
the integration tests. Every claimed gap below was checked against the working tree.

## Findings

| ID | Severity | Finding | Evidence | Resolution |
|---|---|---|---|---|
| PF-13-01 | Major | The reference Compose file has no hardening, no UI service, no resource limits, no log rotation, no DB secret, and no image digest pins. | `deploy/compose/compose.yaml:1-95` | Task 2.1 adds the hardened four-service stack and a scripted contract. |
| PF-13-02 | Major | The server always runs migrations with `OPENVAULT_DB_URL`, so it cannot connect as the runtime role while a migrator owns DDL. | `apps/server/src/main.ts:21` | Task 1.2 adds a separate migration URL for startup. |
| PF-13-03 | Major | The deployment has no SQL that creates `openvault_migrator`, `openvault_app`, `openvault_purger`, or `openvault_pruner`. | `docs/reference/configuration.md:126-160` describes manual grants only | Task 1.3 adds a role-provisioning script and integration proof. |
| PF-13-04 | Major | Restore verifies the CA key but not a pre-backup agent certificate. | `apps/server/src/ops/restore.ts:220-280` | Task 1.1 adds optional agent-certificate verification and a drill test. |
| PF-13-05 | Minor | `ov doctor` checks readiness, TLS, credentials, and clock, but not the database, keyring, or backup age. | `apps/cli/src/commands/doctor.ts:20-115` | Task 1.4 adds the missing checks. |
| PF-13-06 | Minor | The existing checkpoint exporter is only an internal npm script, so it cannot be scheduled on a host with the CLI. | `apps/server/package.json:11`, `apps/server/src/audit/checkpoint-cli.ts:75-107` | Task 1.5 exposes `ov audit checkpoint`. |
| PF-13-07 | Minor | There are no server, agent, or web Dockerfiles, so the reference stack cannot build its own images. | No `Dockerfile` under `deploy/` or the workspace | Task 2.1 adds multi-stage images. |
| PF-13-08 | Minor | The compose guide and reference README describe the stack as unbootable and the CLI as unfinished. | `deploy/compose/README.md:3-5,60-67`, `docs/guide/docker-compose.md:3-5` | Task 3.2 refreshes the operator docs. |
| PF-13-09 | Minor | Base images use floating tags. | `deploy/compose/compose.yaml:4,67` | Task 2.1 pins third-party images by digest. |
| PF-13-10 | Info | The v0.1 schema does not store agent certificate PEMs, so the restore check needs an operator-supplied certificate. | `docs/security/limitations.md:47` | Accepted; documented and tested through the optional file. |

## Security Review Notes

- File-backed URLs are read once at startup; they are not written to logs or redacted output.
- Restore keeps its existing preflight-before-touch ordering and staged-file publication.
- The migration URL must target the same database as the app URL; the loader will enforce it.
- The Compose check fails closed if a service loses its hardening fields.

## Verdict

No unresolved Critical or Major finding. The plan is ready to execute.

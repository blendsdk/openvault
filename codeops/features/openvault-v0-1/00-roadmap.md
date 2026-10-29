# Roadmap: OpenVault v0.1

> **Feature-Set**: OpenVault v0.1
> **Status**: In Progress
> **Created**: 2026-10-29
> **Last Updated**: 2026-10-29 15:20
> **Progress**: 0 / 14 (0%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID | Title | RD | Plan | Stage | Status | Last Updated | Depends-on / Blocker |
|----|-------|----|------|-------|--------|--------------|----------------------|
| RD-01 | Foundation, data model, build security | [RD-01](requirements/RD-01-foundation-data-build.md) | [rd-01-foundation](plans/rd-01-foundation/00-index.md) | Executing | 🔄 | 2026-10-29 | — |
| RD-02 | Transport, configuration, readiness | [RD-02](requirements/RD-02-transport-config-readiness.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-01 |
| RD-03 | Human authentication and sessions | [RD-03](requirements/RD-03-human-auth-sessions.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-02 |
| RD-04 | CLI authentication | [RD-04](requirements/RD-04-cli-auth.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-03 |
| RD-05 | Service identities and mTLS | [RD-05](requirements/RD-05-service-identities-mtls.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-03 |
| RD-06 | RBAC | [RD-06](requirements/RD-06-rbac.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-03, RD-05 |
| RD-07 | Audit | [RD-07](requirements/RD-07-audit.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-02, RD-03, RD-06 |
| RD-08 | Projects and secrets | [RD-08](requirements/RD-08-projects-secrets.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-06, RD-07 |
| RD-09 | Certificates | [RD-09](requirements/RD-09-certificates.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-08 |
| RD-10 | Agent delivery and Compose | [RD-10](requirements/RD-10-agent-compose.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-05, RD-07, RD-08 |
| RD-11 | CLI | [RD-11](requirements/RD-11-cli.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-04, RD-06, RD-08, RD-09, RD-10 |
| RD-12 | Web UI | [RD-12](requirements/RD-12-web-ui.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-03, RD-06, RD-08, RD-10 |
| RD-13 | Backup, rotation, operations | [RD-13](requirements/RD-13-backup-rotation-ops.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on RD-02, RD-08, RD-09 |
| RD-14 | Security assurance and release | [RD-14](requirements/RD-14-security-release.md) | — | RD Drafted | ✏️ | 2026-10-29 | depends on all prior RDs |

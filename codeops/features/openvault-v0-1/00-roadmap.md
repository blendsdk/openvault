# Roadmap: OpenVault v1.0

> **Feature-Set**: OpenVault v1.0
> **Status**: Done
> **Created**: 2026-10-29
> **Last Updated**: 2026-11-08
> **Progress**: 14 / 14 RDs (100%) · remediation complete
> **Release**: v1.0.1 (2026-11-08) · <https://github.com/blendsdk/openvault/releases/tag/v1.0.1>
> **First stable**: v1.0.0
> **Images**: `blendsdk/openvault`, `blendsdk/openvault-agent`, `blendsdk/openvault-web`
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID | Title | RD | Plan | Stage | Status | Last Updated | Depends-on / Blocker |
|----|-------|----|------|-------|--------|--------------|----------------------|
| RD-01 | Foundation, data model, build security | [RD-01](requirements/RD-01-foundation-data-build.md) | [rd-01-foundation](plans/rd-01-foundation/00-index.md) | Done | ✅ | 2026-10-30 | — |
| RD-02 | Transport, configuration, readiness | [RD-02](requirements/RD-02-transport-config-readiness.md) | [rd-02-transport-config-readiness](plans/rd-02-transport-config-readiness/00-index.md) | Done | ✅ | 2026-11-07 | depends on RD-01 |
| RD-03 | Human authentication and sessions | [RD-03](requirements/RD-03-human-auth-sessions.md) | [rd-03-human-auth-sessions](plans/rd-03-human-auth-sessions/00-index.md) | Done | ✅ | 2026-10-31 | depends on RD-02 |
| RD-04 | CLI authentication | [RD-04](requirements/RD-04-cli-auth.md) | [rd-04-cli-auth](plans/rd-04-cli-auth/00-index.md) | Done | ✅ | 2026-11-01 | depends on RD-03 |
| RD-05 | Service identities and mTLS | [RD-05](requirements/RD-05-service-identities-mtls.md) | [rd-05-service-identities-mtls](plans/rd-05-service-identities-mtls/00-index.md) | Done | ✅ | 2026-11-03 | server-side scope; residual AC in RD-06, RD-07, RD-08, RD-10, RD-13, RD-14 |
| RD-06 | RBAC | [RD-06](requirements/RD-06-rbac.md) | [rd-06-rbac](plans/rd-06-rbac/00-index.md) | Done | ✅ | 2026-11-03 | depends on RD-03, RD-05 |
| RD-07 | Audit | [RD-07](requirements/RD-07-audit.md) | [rd-07-audit](plans/rd-07-audit/00-index.md) | Done | ✅ | 2026-11-04 | depends on RD-02, RD-03, RD-06 |
| RD-08 | Projects and secrets | [RD-08](requirements/RD-08-projects-secrets.md) | [rd-08-projects-secrets](plans/rd-08-projects-secrets/00-index.md) | Done | ✅ | 2026-11-04 | depends on RD-06, RD-07 |
| RD-09 | Certificates | [RD-09](requirements/RD-09-certificates.md) | [rd-09-certificates](plans/rd-09-certificates/00-index.md) | Done | ✅ | 2026-11-05 | depends on RD-08 |
| RD-10 | Agent delivery and Compose | [RD-10](requirements/RD-10-agent-compose.md) | [rd-10-agent-compose](plans/rd-10-agent-compose/00-index.md) | Done | ✅ | 2026-11-05 | depends on RD-05, RD-07, RD-08 |
| RD-11 | CLI | [RD-11](requirements/RD-11-cli.md) | [rd-11-cli](plans/rd-11-cli/00-index.md) | Done | ✅ | 2026-11-05 | depends on RD-04, RD-06, RD-08, RD-09, RD-10; backup/restore/KEK rotate delivered; remaining operations program completed by RD-13 |
| RD-12 | Web UI | [RD-12](requirements/RD-12-web-ui.md) | [rd-12-web-ui](plans/rd-12-web-ui/00-index.md) | Done | ✅ | 2026-11-06 | depends on RD-03, RD-06, RD-08, RD-10 |
| RD-13 | Backup, rotation, operations | [RD-13](requirements/RD-13-backup-rotation-ops.md) | [rd-13-operations](plans/rd-13-operations/00-index.md) | Done | ✅ | 2026-11-06 | depends on RD-02, RD-05, RD-08, RD-09; backup/restore/KEK rotate delivered by RD-11 |
| RD-14 | Security assurance and release | [RD-14](requirements/RD-14-security-release.md) | [rd-14-release](plans/rd-14-release/00-index.md) | Done | ✅ | 2026-11-08 | depends on all prior RDs; v1.0.1 published to Docker Hub; the OpenAI Codex Security scan remains manual and advisory |

**Remediation:** [Security findings #39–#44](plans/security-findings-remediation/00-index.md) — Done ✅ (2026-11-06 20:52).

**Remediation:** [Security findings #46–#52](plans/security-findings-wave2/00-index.md) — Done ✅ (2026-11-07 03:42).

**Requirements preflight:** [RD-02 reconciled](requirements/00-preflight-report-RD-02.md) — Done ✅ (2026-11-07, PR #54).

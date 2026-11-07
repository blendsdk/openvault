# Findings Ledger: Security Findings Wave 2

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Open — populated by the post-phase quality loop

| ID | Phase | Severity | Finding | Ruling | Status |
|---|---|---|---|---|---|
| RV-101 | Post-implementation | 🔴 Critical | Prune migration did not remove legacy direct pruner grants | Self-contained migration revokes + runtime guard | ✅ Fixed |
| RV-102 | Post-implementation | 🟠 Major | CLI could reload a changed credential after transport construction | Pass the original base URL into the authenticated client | ✅ Fixed |
| RV-103 | Post-implementation | 🟠 Major | Backup did not bind the dump and audit databases | Compare database identities before dumping | ✅ Fixed |
| RV-104 | Post-implementation | 🟠 Major | Prune cutoff was stored but not enforced | Boundary query and procedure reject hidden newer timestamps | ✅ Fixed |
| RV-105 | Post-implementation | 🟠 Major | Ensure scripts did not remove reverse role memberships | Revoke both directions and reject memberships at startup/prune | ✅ Fixed |
| RV-106 | Post-implementation | 🟠 Major | Backup role attributes were not fully reset | Reset REPLICATION/BYPASSRLS and revoke schema CREATE | ✅ Fixed |
| RV-107 | Post-implementation | 🟠 Major | Scaffold 422 create path omitted the allow decision | Record the decision before the 422 | ✅ Fixed |
| RV-108 | Post-implementation | 🟠 Major | Docs still described old pruner grants, four roles, and app-role bootstrap | Updated audit, CLI, Compose, systemd, install, and configuration docs | ✅ Fixed |
| RV-109 | Post-implementation | 🟠 Major | Missing grant/view/backup/procedure regression coverage | Added the recheck tests | ✅ Fixed |

## Accepted Residuals

| Residual | Why accepted | Revisit trigger |
|---|---|---|
| App role can still insert malformed secret versions | The read path now writes an error event and fails closed; the app role is the trusted writer in the threat model | A constrained version-insert procedure is approved |
| App role can insert audit events | The audit writer is an application responsibility; writes are chained and verified | A separate audit-writer role is approved |
| Clipboard clearing is best effort | Browsers and OS clipboards can deny or ignore the clear; the UI warns and the token is single-use | A file/stdin enrollment flow is approved |
| Prune completion event can be missing after a crash | The receipt table is durable and atomic with the delete; the chained event is best effort | Off-box reconciliation is approved |
| Backup role can read all table data | A backup must read everything; the role is dedicated, read-only, and separate from the server process | Encrypted column-level backup export is approved |

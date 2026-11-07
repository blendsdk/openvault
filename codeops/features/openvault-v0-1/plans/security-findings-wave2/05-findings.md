# Findings Ledger: Security Findings Wave 2

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Open — populated by the post-phase quality loop

| ID | Phase | Severity | Finding | Ruling | Status |
|---|---|---|---|---|---|
| — | — | — | No post-phase findings recorded yet | — | — |

## Accepted Residuals

| Residual | Why accepted | Revisit trigger |
|---|---|---|
| App role can still insert malformed secret versions | The read path now writes an error event and fails closed; the app role is the trusted writer in the threat model | A constrained version-insert procedure is approved |
| App role can insert audit events | The audit writer is an application responsibility; writes are chained and verified | A separate audit-writer role is approved |
| Clipboard clearing is best effort | Browsers and OS clipboards can deny or ignore the clear; the UI warns and the token is single-use | A file/stdin enrollment flow is approved |
| Prune completion event can be missing after a crash | The receipt table is durable and atomic with the delete; the chained event is best effort | Off-box reconciliation is approved |
| Backup role can read all table data | A backup must read everything; the role is dedicated, read-only, and separate from the server process | Encrypted column-level backup export is approved |

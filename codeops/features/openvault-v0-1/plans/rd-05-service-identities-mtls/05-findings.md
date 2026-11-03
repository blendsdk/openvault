# Findings Ledger: RD-05 Service Identities and mTLS

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | 1 | MAJOR | tests/schema | fixed |
| RV-002 | 1 | MINOR | tests/identity | fixed |
| RV-003 | 1 | MINOR | tests/triggers | fixed |
| RV-004 | 1 | MINOR | tests/contracts | fixed |
| RV-005 | 1 | MINOR | tests/generated | fixed |
| SA-001 | 1 | MINOR | security/triggers | fixed |
| SA-002 | 1 | MINOR | security/identity | fixed |
| PE-001 | 1 | MINOR | concurrency/triggers | fixed |
| PE-002 | 1 | MINOR | tests/harness | accepted and fixed |

All Phase 1 findings were accepted for remediation and the scoped re-review passed.

## Phase 2

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | 2 | MAJOR | identity/project atomicity | fixed |
| PE-001 | 2 | MAJOR | auth lock order | fixed |
| RV-002 | 2 | MINOR | detail authorization | fixed |
| RV-003 | 2 | MINOR | CLI refresh | fixed |
| RV-004 | 2 | MINOR | deleted-project listing | fixed |
| RV-005 | 2 | MINOR | test coverage | fixed |
| RV-006 | 2 | MINOR | test environment | fixed |
| RV-007 | 2 | MINOR | service-actor oracle | fixed |
| RV-008 | 2 | MINOR | race test oracle | fixed |
| SA-001 | 2 | MINOR | deleted-project listing | fixed |
| SA-002 | 2 | MINOR | token project lock | fixed |
| SA-003 | 2 | MINOR | ID oracle | fixed |
| PE-002 | 2 | MINOR | project race | fixed |
| PE-003 | 2 | MINOR | race test oracle | fixed |

All Phase 2 findings were accepted for remediation and the scoped re-review passed.

# Findings Ledger: RD-01 Foundation

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | 1 | CRITICAL | package.json | fixed |
| SA-001 | 1 | MAJOR | package.json | fixed |
| RV-002 | 1 | MINOR | clean-checkout | deferred |
| RV-003 | 1 | MINOR | react-scanner | fixed |
| SA-002 | 1 | MINOR | react-scanner | fixed |
| RV-004 | 1 | MINOR | workspace-test | fixed |
| RV-005 | 1 | MINOR | workspace-test | fixed |
| SA-003 | 1 | MINOR | workspace-test | fixed |
| RV-006 | 1 | MINOR | execution-plan | fixed |
| RV-007 | 1 | MINOR | plan-docs | fixed |
| RV-008 | 1 | MINOR | name-docs | fixed |
| RV-009 | 1 | MINOR | ulid-docs | accepted |
| RV-010 | 1 | MINOR | contract-tests | fixed |
| RV-011 | 1 | MINOR | scope-record | fixed |
| SA-004 | 1 | MINOR | dependency-policy | deferred |
| RR-001 | 1 | MINOR | plan-docs | fixed |
| RR-002 | 1 | MINOR | react-scanner-test | fixed |
| RR-003 | 1 | MINOR | findings-ledger | fixed |
| RV-201 | 2.5 | MAJOR | migration-atomicity | fixed |
| RV-202 | 2.5 | MAJOR | migration-coverage | fixed |
| RV-203 | 2.5 | MINOR | index-order | accepted |
| RV-204 | 2.5 | MINOR | snapshot-index | accepted |
| RV-205 | 2.5 | MINOR | cli-exit | fixed |
| RV-206 | 2.5 | MINOR | startup-test | fixed |
| RV-207 | 2.5 | MINOR | test-docs | fixed |
| RV-208 | 2.5 | MINOR | url-parser | fixed |
| RV-209 | 2.5 | MINOR | type-generator | fixed |
| SA-201 | 2.5 | MAJOR | audit-prune | fixed |
| SA-202 | 2.5 | MAJOR | truncate-guard | fixed |
| SA-203 | 2.5 | MAJOR | purge-guard | fixed |
| SA-204 | 2.5 | MAJOR | role-separation | deferred |
| SA-205 | 2.5 | MINOR | tls-parser | fixed |
| SA-206 | 2.5 | MINOR | error-redaction | fixed |
| SA-207 | 2.5 | MINOR | migration-coverage | fixed |

Deferral targets: RV-002 → Phase 3 task 3.1.8 (CONTRIBUTING clean-checkout commands);
SA-004 → Phase 3 task 3.1.6 (exact dependency pins and peer policy).
SA-204 → RD-13 (database role separation); until then the deployment must not run the server as
the table owner, and purge/prune success paths remain untested.

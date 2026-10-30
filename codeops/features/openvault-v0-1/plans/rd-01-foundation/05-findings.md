# Findings Ledger: RD-01 Foundation

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | 1 | CRITICAL | package.json | fixed |
| SA-001 | 1 | MAJOR | package.json | fixed |
| RV-002 | 1 | MINOR | clean-checkout | accepted |
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
| SA-004 | 1 | MINOR | dependency-policy | fixed |
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
| RR-201 | 2.5 | MINOR | purge-order | fixed |
| RR-202 | 2.5 | MINOR | rd13-role-requirement | fixed |
| RR-203 | 2.5 | MINOR | partial-failure-test | fixed |
| RR-204 | 2.5 | MINOR | truncate-test | fixed |
| RR-205 | 2.5 | MINOR | ssl-parser | fixed |
| RR-206 | 2.5 | MINOR | cli-test | fixed |
| RR-207 | 2.5 | MINOR | pre-release-note | fixed |
| RV-301 | 3 | MINOR | artifact-symlinks | fixed |
| RV-302 | 3 | MINOR | artifact-tests | fixed |
| RV-303 | 3 | MINOR | ci-env-scope | fixed |
| RV-304 | 3 | MINOR | schema-drift | accepted |
| RV-305 | 3 | MINOR | audit-fail-open | fixed |
| RV-306 | 3 | MINOR | ci-test-strength | fixed |
| RV-307 | 3 | MINOR | ssl-false-values | fixed |
| RV-308 | 3 | MINOR | ledger-state | fixed |
| RV-309 | 3 | MINOR | scope-record | fixed |
| RV-310 | 3 | MINOR | branch-readback | fixed |
| SA-301 | 3 | MINOR | artifact-large-file | fixed |
| SA-302 | 3 | MINOR | sentinel-key | fixed |
| SA-303 | 3 | MINOR | admin-bypass | fixed |
| SA-304 | 3 | MINOR | type-pins | fixed |

Deferral target: SA-204 → RD-13 (database role separation); until then the deployment must not
run the server as the table owner, and purge/prune success paths remain untested. RV-002 is
accepted because the documented setup runs `pnpm verify` (which builds first); RV-304 is
accepted and documented as a schema-drift limitation.

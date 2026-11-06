# Findings Ledger: Security Findings Remediation

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Open — populated by the post-phase quality loop

| ID | Phase | Severity | Finding | Ruling | Status |
|---|---|---|---|---|---|
| RV-001 | Post-implementation | 🔴 Critical | Role upgrade ran as non-`CREATEROLE` migrator | Run ensure script as bootstrap superuser | ✅ Fixed |
| RV-002 | Post-implementation | 🟠 Major | Startup assertion missed role attributes/memberships | Added attribute, membership, schema checks | ✅ Fixed |
| RV-003 | Post-implementation | 🟠 Major | Double disconnect of shared fallback pool | Register auth disposer only for a distinct pool | ✅ Fixed |
| RV-004 | Post-implementation | 🟠 Major | Secret create/write leaked hidden existence through body validation | Authorize before body validation; uniform 404 | ✅ Fixed |
| RV-005 | Post-implementation | 🟠 Major | App role could write `policy_state` and undelete projects | Revoked writes; added project-recovery trigger | ✅ Fixed |
| RV-006 | Post-implementation | 🟠 Major | `prepare.sh` could write empty secrets / read symlinked password source | Length check, empty rejection, source checks | ✅ Fixed |
| RV-007 | Post-implementation | 🟠 Major | Role test reset production passwords | Disposable-role guard | ✅ Fixed |
| RV-008 | Post-implementation | 🟠 Major | Signing-key INSERT availability residual | Documented as limitation #77 | ✅ Accepted |

## Accepted Residuals

| Residual | Why accepted | Revisit trigger |
|---|---|---|
| App role retains `SELECT` on password/refresh/OIDC rows for backup | Read exposure, not the reported write-forgery path; backup migration is a separate change | Move `ov backup` to the migrator/owner URL |
| Timing can distinguish a missing name from an existing denied name | Status/code/message oracle is closed; timing is noisy and out of the Low finding’s scope | A timing-oracle test or threat-model change |
| Completion event can be missing after a crash/audit outage | Authorization evidence is durable; absence of completion means unknown, not success | An outbox/reconciliation design is approved |

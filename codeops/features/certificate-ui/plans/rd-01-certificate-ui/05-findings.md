# Findings Ledger: Certificate UI

> **Plan**: rd-01-certificate-ui
> **Review**: independent post-implementation review of `1e7ee11..caac4f9`
> **Last Updated**: 2026-11-08 18:32

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | all | MAJOR | certificate-import-dialog.tsx / AR-18 | fixed |
| RV-002 | all | MAJOR | certificate-detail-page.tsx / AC-21 | fixed |
| RV-003 | all | MINOR | docs.ts / certificates.md anchor | fixed |
| RV-004 | all | MINOR | certificate-detail-page.tsx metadata paging | fixed |
| RV-005 | all | MINOR | certificate-detail-page.tsx loaded-version label | fixed |
| RV-006 | all | MINOR | certificate-detail-page.tsx deleted timestamps | fixed |
| RV-007 | all | MINOR | certificates-page.tsx load-more stale state | fixed |
| RV-008 | all | MINOR | certificate-detail-page.tsx purge reason/deadline | fixed |
| RV-009 | all | MINOR | certificate-detail-page.tsx reveal deadline | fixed |
| RV-010 | all | MINOR | dialogs close during submit | fixed |
| RV-011 | all | MINOR | reference/api.md secret capability example | fixed |
| RV-012 | all | MINOR | server list capability projection test | fixed |
| RV-013 | all | MINOR | server name-only search test | fixed |
| RV-014 | all | MINOR | web load-more filter test | fixed |
| RV-015 | all | MINOR | web empty-SAN dialog test | fixed |
| RV-016 | all | MINOR | docs read-and-renew anchor test | fixed |
| RV-017 | all | MINOR | server backslash escaping test | fixed |
| RV-018 | all | MINOR | private-key route-change test | fixed |
| RV-019 | all | MINOR | private-key console/storage coverage | fixed |
| RV-020 | all | OBSERVATION | execution-plan red-phase evidence | fixed |
| RV-021 | all | OBSERVATION | service comment and CLI help | fixed |
| RV-022 | all | OBSERVATION | responsive jsdom limitation | accepted — recorded in 3.3.2 and 7.3.2 |
| RV-023 | all | OBSERVATION | dialog form reset on close | fixed |

## Review evidence

- Independent reviewer scope: correctness, security, generated contract, tests, and regressions.
- No CRITICAL findings. Both MAJOR findings were fixed, tested, and re-verified.
- `pnpm verify` exit 0 after the fixes; web suite 149 tests; integration 20 tests; axe 6 tests.

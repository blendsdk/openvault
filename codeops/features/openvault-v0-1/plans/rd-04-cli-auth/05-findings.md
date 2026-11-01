# Findings Ledger: RD-04 CLI Authentication

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001 | 1 | CRITICAL | spec oracle | fixed |
| RV-002 | 1 | MAJOR | key lifecycle tests | fixed |
| RV-003 / SA-001 / SA-002 / F1 / F2 | 1 | MAJOR | signing-key cache | fixed |
| F3 | 1 | MINOR | rotation timestamp | fixed |
| F4 | 1 | MINOR | verification snapshot | fixed |
| SA-003 | 1 | MINOR | seed zeroization | fixed |
| RV-004 | 1 | MINOR | overlap constant | fixed |
| RV-005 | 1 | MINOR | JWT skew boundary | fixed |
| RV-006 | 1 | MINOR | dead type | fixed |
| RV-007 / RV-009 | 1 | MINOR | documentation | fixed |
| RV-008 | 1 | MINOR | helper naming | fixed |
| RV-010 | 1 | CRITICAL | spec oracle | fixed |
| RV-011 | 1 | MINOR | cache documentation | fixed |
| RV-001/P2 | 2 | MINOR | login lock documentation | fixed |
| RV-002/P2 | 2 | MINOR | bootstrap test coverage | fixed |
| RV-003/P2 | 2 | MINOR | sign-failure test coverage | fixed |
| RV-004/P2 | 2 | MINOR | controller documentation | fixed |
| RV-005/P2 | 2 | MINOR | plugin documentation | fixed |
| RV-001/P3 | 3 | CRITICAL | spec oracle fixture | fixed |
| RV-002/P3 | 3 | MAJOR | tampered-token helper | fixed |
| SA-001/P3 | 3 | MINOR | browser refresh + bearer header | fixed |
| RV-003/P3 | 3 | MINOR | refresh sign-failure test | fixed |
| RV-004/P3 | 3 | MINOR | middleware documentation | fixed |
| SA-002/P3 | 3 | MINOR | logout rate limit | accepted |
| CON-R1/P3 | 3 | MINOR | revoke backstop lock | fixed |
| CON-R4/P3 | 3 | MINOR | logout/refresh test gap | accepted |
| RV-001/P4 | 4 | MINOR | maintenance logger wiring | fixed |
| RV-002/P4 | 4 | MINOR | race-helper database scope | fixed |
| RV-003/P4 | 4 | MINOR | revocation documentation | fixed |
| RV-004/P4 | 4 | MINOR | plugin service documentation | fixed |
| RV-005/P4 | 4 | MINOR | test harness size | deferred |
| CA-1/P4 | 4 | MINOR | cleanup snapshot drift | fixed |
| CA-2/P4 | 4 | MINOR | cleanup/revocation lock overlap | fixed |
| CA-3/P4 | 4 | MINOR | maintenance timer race | fixed |
| RV-001/SA-001/P5 | 5 | MINOR | error-shape assertion | fixed |
| RV-002/SA-003/P5 | 5 | MINOR | binary log forms | fixed |
| SA-002/P5 | 5 | MINOR | refresh-error log coverage | fixed |
| SA-004/P5 | 5 | MINOR | nested header redaction | fixed |
| SA-005/P5 | 5 | MINOR | signing-key retirement docs | fixed |

Phase 2 security audit: no findings. Phase 2 concurrency audit: no findings.
Phase 3 concurrency audit: no findings beyond the two accepted residual notes.
Phase 4 security audit: no findings. Phase 4 concurrency audit: three minor
items fixed; one test-only harness size follow-up deferred.
Phase 5 security audit: no critical/major findings; all five minor items fixed.
The Phase 4 password-change task now explicitly requires the principal lock
before revocation.

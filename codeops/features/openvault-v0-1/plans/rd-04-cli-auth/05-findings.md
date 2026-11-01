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

Phase 2 security audit: no findings. Phase 2 concurrency audit: no findings.
The Phase 4 password-change task now explicitly requires the principal lock
before revocation.

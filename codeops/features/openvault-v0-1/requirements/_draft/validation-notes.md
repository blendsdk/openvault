# Validation Notes — openvault-v0-1

> Draft. Records the Phase 4 checks for the initial RD set.

## Cross-reference validation

| Check | Result |
|---|---|
| All 14 RD links in `README.md` resolve | ✅ |
| Every RD has a `Depends On` header | ✅ |
| Dependencies form a DAG with no cycles | ✅ |
| Every RD has `## Security Considerations` | ✅ |
| Every RD has `## Acceptance Criteria` | ✅ |
| Every RD has `## Scope Decisions` with AR references | ✅ |
| No `TODO`, `TBD`, or placeholder text | ✅ |
| Every AR row is resolved | ✅ |

## Dependency order

```text
RD-01
  RD-02
    RD-03
      RD-04
      RD-05
        RD-06
          RD-07
            RD-08
              RD-09
              RD-10
                RD-11
                RD-12
              RD-13
  RD-14 (all prior)
```

## "Did You Consider…" checklist

| # | Concern | Addressed | Where |
|---|---|---|---|
| 1 | Audit logging / activity trail | Yes | RD-07 |
| 2 | Data export | Yes | RD-07 audit export; RD-13 backup |
| 3 | API versioning | Yes | RD-02 `/v1`, new prefix for breaking changes |
| 4 | Rate limiting | Yes | RD-03 login, RD-05 join, RD-08 data plane |
| 5 | Error messages and UX | Yes | RD-02 envelope, RD-03 auth errors, RD-12 states |
| 6 | Data retention | Yes | RD-07 audit, RD-08/09 soft delete |
| 7 | Backup / disaster recovery | Yes | RD-13 |
| 8 | Internationalization | Deferred | RD-12 English-only v0.1; provider present |
| 9 | GDPR / privacy | Yes | Single-org operator email only; retention and export in RD-07/13 |
| 10 | Soft vs hard delete | Yes | RD-08, RD-09 |
| 11 | Time zones | Yes | RD-01 UTC |
| 12 | Onboarding | Yes | RD-03 bootstrap, RD-13 install, README |
| 13 | Security testing | Yes | RD-14 and security sections in every RD |
| 14 | Concurrency | Yes | RD-07 audit lock, RD-08 versions, RD-03 sessions |
| 15 | Idempotency | Yes | RD-08 |
| 16 | Pagination / filtering | Yes | RD-07, RD-08, RD-12 |
| 17 | Accessibility | Yes | RD-12 |
| 18 | Observability | Yes | RD-02 health/readiness, RD-13 logs |
| 19 | Rollback / restore | Yes | RD-01 migrations, RD-13 restore |
| 20 | Mixed-version compatibility | Yes | RD-01 forward-only, single-node drain |
| 21 | Notifications | Yes | RD-09 certificate expiry webhook |
| 22 | File upload / download | Yes | RD-09 certificate bodies only; no UI upload |
| 23 | Clock skew | Yes | RD-02 30-second tolerance, NTP |
| 24 | Secret zero | Yes | RD-05 join token, RD-10 agent |
| 25 | Key custody | Yes | RD-02 keyring, RD-13 backup/rotation |
| 26 | Supply chain | Yes | RD-01 audit/CI, RD-14 signing/SBOM/scan |
| 27 | Documentation accuracy | Yes | RD-14 docs-accuracy gate |
| 28 | Independent review | Yes | RD-14 external review |

## Security items (non-negotiable)

| Item | Where |
|---|---|
| Server-side input validation | RD-02, RD-03, RD-05, RD-08, RD-09 |
| Injection prevention | RD-01 parameterized SQL, RD-02 no SQL from config, RD-08/09 parsers |
| Auth and authorization model | RD-03, RD-04, RD-05, RD-06 |
| Rate limiting on auth/public endpoints | RD-03, RD-05, RD-08 |
| Secrets management | RD-02 keyring, RD-05 mTLS, RD-08/09 envelope |
| Encryption at rest and in transit | RD-02 TLS, RD-08/09 envelope, RD-13 backups |
| Infrastructure hardening | RD-02 listeners, RD-13 containers |
| Security testing | RD-14 |

## Zero-Ambiguity final verification

- [x] `00-ambiguity-register.md` exists.
- [x] All 30 entries are `✅ Resolved`.
- [x] Every RD scope decision references an AR entry.
- [x] No deferred decision appears in executable requirements.
- [x] The user reviewed the complete register through the batch confirmation and
  "best possible option" decision.
- [x] The only complexity packet (AR-7/AR-23) has an independent `Simplify` verdict and an
  explicit recorded choice.
- [x] No AI-assumed defaults remain in the RDs.

## Specialist check

Selected lenses: web application, data and migration, distributed and concurrent.
Specialist needs: security, data integrity, concurrency. The project has installed
`security-auditor`, `correctness-reviewer`, `concurrency-auditor`, `design-challenger`, and
`preflight-auditor` agents. RD-14 binds them to phase gates.

## Remaining work

1. User review and approval of the 14 draft RDs.
2. `make-plan` for RD-01 (foundation) and then the dependent RDs.
3. `preflight` on the RD set and the plan.
4. Specification tests before implementation.

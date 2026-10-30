# Findings Ledger: RD-02 Transport, Configuration, and Readiness

> **Purpose**: execution-phase review rulings. Preflight findings and their resolutions live in
> [00-preflight-report.md](00-preflight-report.md); this ledger is the durable home for
> phase-review findings required by `99-execution-plan.md` Success Criterion 5.

## Preflight

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| PF-001–PF-024 | Preflight | 6 major, 17 minor, 1 observation | plan set | Fixed; see [00-preflight-report.md](00-preflight-report.md) |

## Execution Reviews

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-001, SA-002 | 1 | MAJOR | config/zod | fixed |
| SA-001 | 1 | MAJOR | keyring/privacy | fixed |
| RV-101 | 1 re-review | MAJOR | config/blank-values | fixed |
| RV-002, SA-006 | 1 | MINOR | config/errors | fixed |
| RV-003 | 1 | MINOR | config/cidr | fixed |
| RV-004, SA-004 | 1 | MINOR | keyring/zeroize | fixed |
| RV-005 | 1 | MINOR | tests/config | fixed |
| RV-006 | 1 | MINOR | config/ports | fixed |
| SA-003 | 1 | MINOR | keyring/file-race | fixed |
| SA-005 | 1 | MINOR | crypto/errors | fixed |
| RV-102 | 1 re-review | MINOR | keyring/symlink | fixed |
| RV-103 | 1 re-review | MINOR | crypto/errors | fixed |
| RV-104 | 1 re-review | MINOR | config/dead-code | fixed |
| SA-007 | 1 | MINOR | config/serialization | deferred |
| RV-007 | 1 | MINOR | plan/traceability | deferred |
| RV-201, SA-201 | 2 | MAJOR | transport/lifecycle-trust | fixed |
| RV-202 | 2 | MINOR | transport/readiness-seam | fixed |
| RV-203 | 2 | MINOR | tests/transport-settings | fixed |
| RV-204 | 2 | MINOR | transport/trust-proxy | fixed |
| RV-205 | 2 | MINOR | tests/parser-order | fixed |
| RV-206 | 2 | MINOR | tests/host-assumption | fixed |
| RV-207 | 2 | MINOR | transport/lifecycle-hooks | fixed |
| SA-202 | 2 | MINOR | scope/dot-segments | fixed |
| SA-203 | 2 | MINOR | transport/media-limits | fixed |
| SA-204 | 2 | MINOR | transport/loopback-policy | accepted |
| SA-205 | 2 | MINOR | transport/tls-di | fixed |
| SA-206 | 2 | MINOR | transport/cert-validity | fixed |
| SA-207 | 2 | MINOR | transport/parser-error | fixed |
| SA-208 | 2 | MINOR | logging/duplicate-entry | dismissed |
| RV-301, RV-302 | 2 re-review | MINOR | transport/lifecycle-tests | fixed |

**Phase 1 review notes**

- Fixed the Zod design deviation, the keyring privacy bypass, and the re-review
  blank-value regression; `pnpm verify` passes after the fixes.
- SA-007: `OpenVaultConfig` still lacks a defensive `toJSON`; the redacted
  support function remains the only serializer. Owner: RD-11. Revisit when any
  code path serializes the full config object.
- RV-007: the `.env` loading override is part of task 2.2.4, not the Phase 1
  settings bridge. Revisit at the Phase 2 gate.

**Phase 2 review notes**

- Fixed the stop-cleanup and agent forwarded-header trust majors; transport
  spec+impl passes 24/24 and `pnpm verify` passes after the fixes.
- SA-204 accepted: the loopback health-only rule is the approved listener
  policy, and trusted-proxy tests use a non-loopback source.
- SA-208 dismissed: pre-stack rejections carry no `req.services`, so the
  terminal handler cannot log a second entry; the suite observes one entry.
- SA-206: `checkReady` validity checks are wired when the readiness service
  lands in Phase 3.
- Re-review residual RV-301/RV-302 fixed; no third review was run per the
  one-scoped-re-review cap.

## Ruling Vocabulary

`fixed` · `accepted` · `deferred` · `superseded`. A deferred finding records the owner and the
observable revisit trigger in the phase review note.

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

**Phase 1 review notes**

- Fixed the Zod design deviation, the keyring privacy bypass, and the re-review
  blank-value regression; `pnpm verify` passes after the fixes.
- SA-007: `OpenVaultConfig` still lacks a defensive `toJSON`; the redacted
  support function remains the only serializer. Owner: RD-11. Revisit when any
  code path serializes the full config object.
- RV-007: the `.env` loading override is part of task 2.2.4, not the Phase 1
  settings bridge. Revisit at the Phase 2 gate.

## Ruling Vocabulary

`fixed` · `accepted` · `deferred` · `superseded`. A deferred finding records the owner and the
observable revisit trigger in the phase review note.

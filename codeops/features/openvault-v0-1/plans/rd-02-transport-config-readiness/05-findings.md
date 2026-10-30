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
| RV-401 | 3 | MINOR | readiness/probe-translation | fixed |
| RV-402, SA-406 | 3 | MINOR | readiness/error-split | fixed |
| RV-403 | 3 | MINOR | readiness/timeout-scope | accepted |
| RV-404, SA-405 | 3 | MINOR | readiness/logger-wiring | fixed |
| RV-405 | 3 | MINOR | tests/readiness-correlation | fixed |
| SA-401 | 3 | MINOR | logging/request-id-trust | accepted |
| SA-402 | 3 | MINOR | clock/inverted-window | fixed |
| SA-403 | 3 | MINOR | logging/query-strings | accepted |
| SA-404 | 3 | MINOR | logging/redaction-depth | accepted |
| RV-501 | 4 | MAJOR | deploy/formatting | fixed |
| RV-502 | 4 | MAJOR | deploy/network-name | fixed |
| RV-503, SA-503 | 4 | MAJOR | docs/backup-claim | fixed |
| SA-501 | 4 | MAJOR | deploy/proxy-key-mount | fixed |
| RV-504, SA-505 | 4 | MINOR | deploy/caddy-validation | fixed |
| RV-505, SA-504 | 4 | MINOR | docs/readiness-path | fixed |
| RV-506 | 4 | MINOR | docs/ports | fixed |
| RV-507 | 4 | MINOR | docs/internal-ids | fixed |
| SA-502 | 4 | MINOR | docs/admin-network | fixed |
| SA-506 | 4 | MINOR | deploy/container-hardening | deferred |

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

**Phase 3 review notes**

- No critical or major findings. Production probe translation, the 500 branch,
  timeout logging, and request-id correlation now have direct tests.
- RV-403 accepted and documented: the 2 s timeout ends the response, not an
  in-flight query; the pool cap and connection timeout bound residual work.
- SA-401 accepted: valid inbound request IDs are reused by design; the ID is a
  correlation aid, not an authorization control. Revisit if it becomes an
  audit key.
- SA-403 accepted: credentials must stay out of query strings; re-open as a
  major concern when RD-03/RD-05 add query parameters.
- SA-404 accepted: pino wildcard redaction is one level deep; handlers must log
  explicit fields and never raw nested objects.

**Phase 4 review notes**

- Fixed the proxy key mount, the external network name, the stale backup claim, the
  readiness path references, the port list, the internal-ID references, and the Caddy
  validation reporting.
- SA-506 deferred to RD-14: the release image owns non-root execution and a read-only
  rootfs. Revisit when the image is built and scanned.
- `caddy validate` now runs against the pinned `caddy:2.10-alpine` image when available
  (and an explicit skip otherwise); the text assertions still run everywhere.

## Ruling Vocabulary

`fixed` · `accepted` · `deferred` · `superseded`. A deferred finding records the owner and the
observable revisit trigger in the phase review note.

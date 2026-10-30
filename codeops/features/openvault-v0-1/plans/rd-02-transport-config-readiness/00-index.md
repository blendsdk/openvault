# RD-02 Transport, Configuration, and Readiness Implementation Plan

> **Feature**: Typed fail-closed configuration, HTTPS/mTLS listeners, proxy trust, request limits, redacted logging, and truthful readiness for OpenVault.
> **Status**: Done — executed and verified
> **Created**: 2026-10-30 12:14
> **Preflight**: [00-preflight-report.md](00-preflight-report.md) — 24 findings resolved
> **Implements**: openvault-v0-1/RD-02
> **CodeOps Artifact Schema**: 1
> **Execution commit mode**: auto-commit (requested for the execution run)

## Overview

RD-02 turns the current WebAFX scaffold into a transport boundary that a secrets service can
trust. It validates every documented environment value before any database or socket work,
loads the keyring with restrictive permissions, starts an HTTPS admin listener and a separate
mTLS agent listener, rejects direct admin traffic outside the configured proxy CIDRs, applies
strict request limits and security headers, and exposes liveness and dependency readiness.

The plan reuses BlendSDK WebAFX for routing, controllers, dependency injection, plugins,
response envelopes, `/health`, request IDs, Helmet baseline, and graceful service disposal. It
uses the existing BlendSDK PostgreSQL adapter for readiness and the existing core envelope
encryption/keyring package. It adds one small secure-listener adapter because WebAFX 5.68.1
does not expose HTTPS or mTLS in `WebApplication.start()`.

## Minimum-Sufficient Baseline

**Original goal:** fail-closed configuration and a trustworthy browser/admin plus agent transport
boundary, with truthful readiness.

**Smallest viable design:** one WebAFX application; a small `SecureWebApplication` adapter that
calls the protected `initialize()` once and owns two Node HTTPS servers; a Zod config loader; a
keyring provider over the existing core `Keyring`; and middleware for proxy trust, listener
scope, headers, limits, and no-store. No new production dependency.

**Excluded machinery:** a new web framework, a separate proxy application, two duplicated
WebAFX apps, a custom logger, a certificate-generation library, age encryption in this plan,
and a policy engine.

**Approved complexity:** None. The secure-listener adapter is the smallest direct control for
RD-02's required TLS/mTLS boundary; the design challenger returned **Simplify** and the plan
implements one small adapter with one owned lifecycle, not a parallel framework lifecycle.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and delegated provenance |
| PF | [Preflight Report](00-preflight-report.md) | Audit findings, resolutions, and delegated provenance |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Delta view of RD-02 |
| 02 | [Current State](02-current-state.md) | Existing implementation and gaps |
| 03-01 | [Configuration and Keyring](03-01-configuration-keyring.md) | Config loader, key custody, file permissions |
| 03-02 | [Transport and Listeners](03-02-transport-listeners.md) | Secure WebAFX adapter, TLS/mTLS, proxy trust, headers, limits |
| 03-03 | [Readiness and Observability](03-03-readiness-observability.md) | `/health`, `/ready`, logging, redaction, errors |
| 03-04 | [Deployment and Documentation](03-04-deployment-docs.md) | Compose networks, Caddy, configuration docs |
| 05 | [Findings Ledger](05-findings.md) | Execution-phase review rulings |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases ST-1…ST-39 (ST-35 reclassified as PL-1/PL-2) and plan-local harness tests |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Usage Examples

```bash
# Validate and start with the documented environment
OPENVAULT_BASE_URL=https://vault.example.com \
OPENVAULT_DB_URL=postgres://openvault:...@postgres:5432/openvault \
OPENVAULT_KEYRING=/var/lib/openvault/keyring.json \
OPENVAULT_TLS_CERT=/etc/openvault/tls/server.crt \
OPENVAULT_TLS_KEY=/etc/openvault/tls/server.key \
OPENVAULT_INTERNAL_CA=/etc/openvault/tls/ca.pem \
pnpm --filter @openvault/server start

# Local transport tests generate ephemeral certificates and use ephemeral ports
pnpm --filter @openvault/server test
TEST_DATABASE_URL=postgres://openvault:test-password@localhost:5433/openvault_test \
OPENVAULT_TEST_DB=1 pnpm --filter @openvault/server test:integration
```

### Key Decisions

| Decision | Outcome |
|---|---|
| Config ownership | Zod `loadConfig`; WebAFX receives only standard settings |
| WebAFX file overrides | Disabled in the secure application |
| TLS runtime | Small `SecureWebApplication` adapter over WebAFX `initialize()` |
| Admin listener | HTTPS, proxy-CIDR guard, no plaintext listener |
| Agent listener | HTTPS with required client certificate from the internal CA |
| Proxy trust | Explicit CIDR function; never WebAFX's hop-count `TRUST_PROXY` |
| Keyring | Core API hardened; server provider checks mode `0600`; age deferred to RD-13 |
| Body limits | Custom pre-parser ceiling and fixed 64/128 KiB path guardrails; 413 mapping; product max-byte settings documented as RD-08/RD-09 limits |
| Readiness | WebAFX `/health` plus root `/ready` dependency probe |
| Logging | BlendSDK pino plugin with the documented path-based redaction and a no-nested-object handler rule |
| Deployment | Dedicated `admin_net`, pinned proxy CIDR, Caddy HSTS/timeouts |

## PR Summary

**Branch:** `feat/rd-02-transport-config-readiness` (base `main` at `e4b21f1`)

**What changed**

- Typed Zod configuration with fail-closed file, mode, CIDR, URL, duration, and port checks.
- Hardened core keyring (scoped callback access, redacted serialization/inspection, `#private`
  storage, idempotent destroy) plus a server provider with exact `0600` loading.
- A `SecureWebApplication` adapter that owns admin HTTPS and agent mTLS listeners over one
  WebAFX application, with one shutdown and no plaintext `start()`.
- TLS material validation, CIDR proxy trust, default-deny listener scope, request
  correlation, strict headers/no-store, media-type rejection, and 64/128 KiB body limits.
- Root `/ready` with bounded PostgreSQL, keyring, TLS, and audit probes; `/health` remains
  liveness only.
- Shared pino logging with the documented redaction paths and a 30-second clock-skew helper.
- Reference Compose `admin_net`, pinned proxy CIDR, CA-only proxy mount, healthcheck, and
  Caddy HSTS/timeouts; documentation aligned with the implemented contract.

**Acceptance mapping**

| RD-02 AC | Evidence |
|---|---|
| 1 | `loadConfig` + `main.ts` fail-closed ordering; ST-33 startup spec |
| 2 | ST-2/ST-5/ST-39 config and TLS-material tests; startup spec |
| 3 | ST-4 keyring permission case; server provider tests |
| 4 | ST-16 direct admin rejection; source guard |
| 5 | ST-18 missing/unknown-CA client certificate cases |
| 6 | ST-20 matcher/trust tests; agent forwarded-header stripping test |
| 7 | ST-28/ST-29 readiness success/failure matrix; ST-30 timeout |
| 8 | ST-22 64/128 KiB boundary cases |
| 9 | ST-21 headers/no-store/no-CORS assertions |
| 10 | ST-24 envelope and production-error tests; WebAFX terminal handler |
| 11 | ST-19 scope matrix; ST-24 envelope assertions |
| 12 | ST-21 cross-origin assertion |
| 13 | ST-38 clock-skew boundaries; enforcement deferred to RD-03/RD-05 |
| 14 | ST-12/ST-13 redaction and destroy tests; code-review zeroization gate |
| 15 | Transport/readiness/security suites, audits, and Phase 1–4 reviews |

**Deferred owners**

- Age keyring and export/provisioning: RD-13; `OPENVAULT_KEYRING_PASSPHRASE_FILE` fails closed.
- Agent fingerprint, expiry, and revocation: RD-05.
- OIDC, browser sessions, and CSRF: RD-03/RD-06.
- Secret and certificate product routes: RD-08/RD-09.
- Static UI and CSP expansion: RD-12.
- Non-root/read-only release image: RD-14.
- `ov init` keyring/TLS provisioning: RD-11/RD-13; the reference stack is not bootable until then.

**Verification**

`pnpm verify`, `pnpm audit:prod`, `pnpm audit:full`, `pnpm db:types:check`, PostgreSQL 16/17
integration (63 tests each), transport (24), readiness (9), and `caddy validate` against
`caddy:2.10-alpine` all pass. Preflight and execution review rulings are recorded in
[00-preflight-report.md](00-preflight-report.md) and [05-findings.md](05-findings.md).

## Specialist Agents

**None** — the capability-gap check found no project-specific specialist beyond the catalog
`security-auditor` and `correctness-reviewer` roles plus dynamic review packets.

_Detection evidence: the work is security-sensitive but follows documented BlendSDK WebAFX,
Node HTTPS, and existing core patterns. There is no recurring project-specific protocol,
regulatory invariant, or migration convention that a standing specialist would own. The
BlendSDK WebAFX transport gap is bounded by AR-4 and can be reviewed with a dynamic packet._

## Related Files

| Path | Purpose |
|---|---|
| `apps/server/src/config/` | Typed environment loader and redacted dump |
| `apps/server/src/security/keyring.ts` | Keyring file loader/provider |
| `packages/core/src/keyring.ts` | Hardened key custody API |
| `packages/core/src/crypto.ts` | Crypto primitive adapted to callback access |
| `apps/server/src/transport/` | Secure WebAFX adapter, TLS material, listeners, middleware |
| `apps/server/src/readiness/` | PostgreSQL/keyring/TLS/CA/audit probes |
| `apps/server/src/observability/logger.ts` | Shared pino provider, redaction paths, and pre-stack logger |
| `apps/server/src/types/express.d.ts` | `Express.Request.log` augmentation for the pino request logger |
| `apps/server/src/app.ts` | Application factory and service registration |
| `apps/server/src/main.ts` | Validate → load material → migrate → bind |
| `apps/server/src/controllers/ready.ts` | Root `/ready` controller |
| `apps/server/tests/` | Config, keyring, transport, readiness, logging, startup, clock, and plan-local harness tests |
| `apps/server/tests/test-app.impl.test.ts` + `ready.impl.test.ts` | PL-1/PL-2 plan-local harness evidence |
| `apps/server/tests/integration/helpers/tls.ts` | Ephemeral OpenSSL certificate fixture |
| `deploy/compose/compose.yaml` | `admin_net`, CA, ports, proxy CIDR, healthcheck |
| `deploy/compose/Caddyfile` | HSTS, upstream TLS, proxy timeouts |
| `docs/reference/configuration.md` | Runtime configuration reference |

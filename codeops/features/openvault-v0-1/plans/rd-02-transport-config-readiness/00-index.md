# RD-02 Transport, Configuration, and Readiness Implementation Plan

> **Feature**: Typed fail-closed configuration, HTTPS/mTLS listeners, proxy trust, request limits, redacted logging, and truthful readiness for OpenVault.
> **Status**: Planning Complete — preflight pending
> **Created**: 2026-10-30 12:14
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
implements only the one-method adapter, not a parallel lifecycle.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and delegated provenance |
| 00 | [Index](00-index.md) | This document |
| 01 | [Requirements](01-requirements.md) | Delta view of RD-02 |
| 02 | [Current State](02-current-state.md) | Existing implementation and gaps |
| 03-01 | [Configuration and Keyring](03-01-configuration-keyring.md) | Config loader, key custody, file permissions |
| 03-02 | [Transport and Listeners](03-02-transport-listeners.md) | Secure WebAFX adapter, TLS/mTLS, proxy trust, headers, limits |
| 03-03 | [Readiness and Observability](03-03-readiness-observability.md) | `/health`, `/ready`, logging, redaction, errors |
| 03-04 | [Deployment and Documentation](03-04-deployment-docs.md) | Compose networks, Caddy, configuration docs |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification test cases ST-1…ST-37 |
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
| Body limits | Custom pre-parser ceiling and 64/128 KiB path limits; 413 mapping |
| Readiness | WebAFX `/health` plus root `/ready` dependency probe |
| Logging | BlendSDK pino plugin with full sensitive-field redaction |
| Deployment | Dedicated `admin_net`, pinned proxy CIDR, Caddy HSTS/timeouts |

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
| `apps/server/src/app.ts` | Application factory and service registration |
| `apps/server/src/main.ts` | Validate → load material → migrate → bind |
| `apps/server/src/controllers/ready.ts` | Root `/ready` controller |
| `apps/server/tests/` | Config, keyring, transport, readiness, logging, startup tests |
| `apps/server/tests/integration/helpers/tls.ts` | Ephemeral OpenSSL certificate fixture |
| `deploy/compose/compose.yaml` | `admin_net`, CA, ports, proxy CIDR, healthcheck |
| `deploy/compose/Caddyfile` | HSTS, upstream TLS, proxy timeouts |
| `docs/reference/configuration.md` | Runtime configuration reference |

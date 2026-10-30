# Requirements: RD-02 Transport, Configuration, and Readiness

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-02](../../requirements/RD-02-transport-config-readiness.md) — the owning requirements document.
> **CodeOps Artifact Schema**: 1

## Scope of this plan (delta view)

### In this plan

- RD-02 config: typed Zod validation, required file checks, redacted support dump, fail-closed
  startup, and `OPENVAULT_ADMIN_PORT`/`PORT` precedence.
- RD-02 key custody: keyring file mode `0600`, load/validate, redacted serialization and
  inspection, best-effort zeroization, and no raw key buffers in the server-facing API.
- RD-02 listeners: HTTPS admin listener restricted to proxy CIDRs and an mTLS agent listener
  that requires a certificate chaining to the internal CA.
- RD-02 transport hardening: no plaintext listener, strict CSP, Helmet baseline, no-store,
  CORS disabled, no `X-Powered-By`, request/header timeouts, and 64/128 KiB body limits.
- RD-02 readiness: WebAFX `/health` liveness plus root `/ready` checks for PostgreSQL, keyring,
  TLS/CA material, and the audit table.
- RD-02 observability: BlendSDK pino logging with sensitive-field redaction, generic error
  envelopes, and the shared 30-second clock-skew helper (enforcement in RD-03/RD-05).
- RD-02 deployment: reference Compose `admin_net`, pinned proxy CIDR, CA/port environment,
  Caddy HSTS and timeouts, and configuration documentation.
- Security and transport tests, including ephemeral TLS/mTLS certificates.

### Deferred / out of this plan

- Age-encrypted keyring and passphrase-file decryption — RD-13; if set, RD-02 fails closed with
  an unsupported-feature error (AR-2).
- Actual token and agent-certificate clock-skew enforcement — RD-03/RD-05; RD-02 provides the
  shared 30 s policy and boundary-tested helper (AR-26).
- `ov config show --redacted` command surface — RD-11; RD-02 provides and tests the redacted
  config function (AR-27).
- Initial keyring-file provisioning (`ov init`) — RD-11/RD-13. RD-02's `Keyring.toJSON()` is
  redacted and no longer writes key bytes; the reference stack is not bootable until the CLI
  provisioner lands. RD-02 uses temporary fixtures (PF-021).
- Transport body-limit precedence — RD-02 keeps the fixed 64/128 KiB guardrails; the
  `OPENVAULT_SECRET_MAX_BYTES`/`OPENVAULT_CERT_MAX_BYTES` product limits are enforced in
  RD-08/RD-09 (PF-008).
- Agent certificate fingerprint, expiry, and revocation enforcement — RD-05 (AR-3).
- Browser authentication, sessions, OIDC flow, CSRF, and route authorization — RD-03/RD-06.
- Secret/certificate product routes (the body-limit paths are transport guardrails only) —
  RD-08/RD-09.
- Agent join/renew/fetch routes and certificate issuance — RD-05/RD-10.
- Static UI serving and UI CSP expansion — RD-12.
- Metrics endpoint, multi-region routing, automatic certificate reload, and multi-admin
  listeners — RD-02 Won't Have.

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| Secure listener adapter | `SecureWebApplication` reuses WebAFX `initialize()` once; owns two HTTPS servers and one shutdown | AR-4 |
| Listener isolation | One app + normalised default-deny listener scope table | AR-5 |
| Proxy trust | Explicit CIDR trust function; WebAFX `TRUST_PROXY: false` | AR-6 |
| Reference network | Dedicated `admin_net` with pinned proxy address; broad default warns in production | AR-7, AR-25 |
| Key custody | Core `Keyring` callback access + redacted serialization/inspection + `destroy`; server provider loads mode `0600` | AR-9, AR-10 |
| Config bridge | Zod loader; only standard fields passed to WebAFX; `.env.js` loading disabled | AR-11, AR-12 |
| Request limits | Pre-parser JSON ceiling, path byte limits, 413 mapper, 415 form rejection | AR-13, AR-14 |
| Headers | Strict API CSP, Helmet baseline, proxy HSTS, `/v1` no-store, CORS off | AR-15 |
| Readiness | WebAFX `/health`; root `/ready` dependency probe; 2 s DB timeout | AR-17, AR-18 |
| Tests | Ephemeral OpenSSL CA/server/client fixtures; no committed private keys | AR-24 |

## Acceptance Criteria

RD-02 owns the product acceptance criteria. This plan adds only the following plan-local gates:

1. [x] `pnpm verify` passes, including the root policy tests and docs build.
2. [x] PostgreSQL 16 and 17 integration suites pass, including the transport and readiness
   suites.
3. [x] No new production dependency is introduced; the runtime uses BlendSDK WebAFX,
   `blendsdk/postgresql`, the BlendSDK pino plugin, Node HTTPS/OpenSSL, and existing core code.
4. [x] `db:types:check` remains clean; RD-02 does not change the database schema.
5. [x] The in-process test factory remains usable through `app.express` without binding a
   plaintext listener; the plan-local harness tests (`PL-1`/`PL-2`) prove it.
6. [x] `apps/server` starts only after config, keyring, TLS, and CA validation; a bad value
   never binds a port and never reaches migrations with an invalid config.
7. [x] The reference `deploy/compose/Caddyfile` passes `caddy validate` (when Caddy or Docker
   is available), and ST-34 asserts the corrected global/transport timeout blocks.

# OIDC Endpoint Trust: Security Findings Remediation

> **Document**: 03-04-oidc-endpoint-trust.md
> **Parent**: [Index](00-index.md)

## Overview

Constrain every OIDC endpoint that OpenVault will call. The issuer check remains; authorization, token, JWKS, and UserInfo endpoints must be HTTPS and belong to an explicit origin allowlist.

## Configuration

Add `OPENVAULT_OIDC_ENDPOINT_ORIGINS`, a comma-separated list of origins.

- Optional. Default: the configured issuer origin.
- If set, the issuer origin is always included; the operator adds extra origins.
- Each value must be an `https:` origin with no path, query, fragment, username, or password.
- Wildcards, `*`, `..`, and non-HTTPS schemes are rejected.
- Canonicalize with `new URL(value).origin`, dedupe, and store the canonical strings.
- Setting origins without an issuer is a ConfigError, not a silently ignored value.

Add `OidcConfig.endpointOrigins: readonly string[]` and include it in `RedactedOpenVaultConfig` and `toRedactedConfig` (it is not a secret, but support output should show the trust policy).

## Endpoint Validation

After discovery and the issuer equality check, validate **each** endpoint present in `configuration.serverMetadata()`:

- `authorization_endpoint`
- `token_endpoint`
- `jwks_uri`
- `userinfo_endpoint`

Rules: `https:`, no username/password, origin in the allowlist. Reject with `OidcUnavailableError` before caching the configuration. A missing required endpoint remains a discovery failure; do not invent one.

## Redirects

Set `redirect: "error"` in `#timedFetch`. This rejects same-origin and cross-origin redirects. Document that providers must expose final endpoints directly; a redirecting provider needs the final URL in its discovery document. This is stricter than “no cross-origin redirect,” and it is the selected behavior because it is simple and auditable.

## Tests

`apps/server/tests/auth/oidc.impl.test.ts`:

- Parameterize ST-15/ST-16/ST-17 over all four endpoint fields.
- ST-15: cross-origin endpoint without allowlist → `OidcUnavailableError`; no fetch to the disallowed origin.
- ST-16: same endpoint with the origin allowlisted → discovery succeeds and the request is made.
- ST-17: `http:` endpoint → `OidcUnavailableError`.
- ST-18: redirect-aware stub: when a response has `Location` and `init.redirect === "error"`, the stub rejects with a `TypeError` as native fetch would; assert `init.redirect === "error"` and no second request.
- Config tests: default issuer origin, explicit list, wildcard rejection, path/credentials rejection, origins without issuer, redaction output.
- ST-19: full login/exchange with the same-origin fixture stays in `apps/server/tests/integration/auth.oidc.test.ts`, not the unit suite.

Label compatibility tests (ST-16 success, ST-19) separately from regression tests; they do not need to fail on the old code.

## Failure Behavior

- Cross-origin endpoint not listed: `OidcUnavailableError` (503), no request to that endpoint.
- HTTP endpoint: same.
- Listed cross-origin endpoint: accepted.
- Redirect: `OidcUnavailableError`; no credential or token leaves the allowed origin.
- Invalid config: startup ConfigError.

## Compatibility

Same-origin providers need no configuration. Multi-origin providers add their exact origins. The fixture provider is same-origin and must keep working.

## Acceptance

See `07-testing-strategy.md` ST-15…ST-19 and `01-requirements.md` R4.

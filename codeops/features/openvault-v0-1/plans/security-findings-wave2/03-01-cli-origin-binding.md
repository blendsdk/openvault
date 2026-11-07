# CLI Origin Binding: Security Findings Wave 2

> **Document**: 03-01-cli-origin-binding.md
> **Parent**: [Index](00-index.md)

## Overview

`ov doctor` must never attach a stored bearer to an origin other than the origin in the credential document. The existing authenticated client already enforces this rule; extract it and use it in doctor.

## Architecture

### Current Behavior

`doctor.ts:144-159` selects the transport from `--url`, `OPENVAULT_URL`, or the stored `baseUrl`. `doctor.ts:202-214` loads the credential and sends its access token to `/v1/auth/cli/me` on the selected transport. `authenticated.ts:53-67` compares the credential's origin before refresh and token use.

### Proposed Changes

1. Add a shared helper in `apps/cli/src/client/authenticated.ts`:

   ```ts
   /**
    * Returns true when two URLs have the same scheme, host, and port.
    * Invalid or non-HTTPS URLs return false.
    */
   export function sameCredentialOrigin(left: string, right: string): boolean;
   ```

   It parses both URLs and compares `origin`. The existing `requireSameServer` uses the helper.

2. In `doctor.ts`, load the credential document once before selecting the transport. Keep the existing precedence for the probe URL.

3. When an explicit probe URL differs from the credential origin:
   - Run TLS, readiness, and clock checks against the probe origin without an `Authorization` header.
   - Do not call `/v1/auth/cli/me` with the stored token.
   - Report the credentials check as `ok: false` with `detail: "stored credential belongs to a different server; run ov login for this origin"`.

4. When the origins match, keep the existing authenticated check.

5. When no explicit URL is supplied, use the credential `baseUrl` exactly as today.

## Failure Behavior

- Invalid stored credential URL: the credential check fails with a safe message; no request with a bearer is made. A malformed credential document is treated as an invalid credential, not as “no server URL”.
- Mismatched scheme, host, or port: no bearer is sent; TLS/readiness still probe the override.
- Same origin with different spelling (`https://vault.example` vs `https://vault.example:443`): parsed origins compare equal.
- No credential: the existing `run ov login` message remains.

## Tests

- `apps/cli/tests/doctor.impl.test.ts`: unit-test `sameCredentialOrigin` for scheme, host, port, default port, and invalid URLs.
- `apps/cli/tests/commands.spec.test.ts`: log in against `https://localhost:<port>`, record `const start = vault.requests.length`, run `doctor --url https://127.0.0.1:<port>`, and assert `vault.requests.slice(start)` contains no `/v1/auth/cli/me` request with an `Authorization` header. The certificate contains an IP SAN, so TLS still succeeds and the test proves the origin check rather than a TLS failure.
- Same file: set `OPENVAULT_URL=https://127.0.0.1:<port>` (no `--url`) and assert the same no-bearer behavior. This covers the environment override path named in the finding.
- Same file: run doctor against the exact stored origin and assert the authenticated check succeeds, using `vault.requests.slice(start)`.
- Same file: write a malformed credential document with mode `0600` and assert doctor reports a safe credential failure without sending a bearer.

## Acceptance

See `07-testing-strategy.md` ST-1…ST-4 and `01-requirements.md` R1.

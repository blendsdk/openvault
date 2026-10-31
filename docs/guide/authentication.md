# Authentication

OpenVault has three credential types:

| Caller | Credential | Lifetime |
|---|---|---|
| Browser | Opaque BFF session cookie | 8 hours by default |
| CLI | Ed25519 JWT + rotating refresh token | 15 minutes / 12 hours |
| Agent | mTLS client certificate | 30 days, renewed |

## Browser sessions

The browser never sees an OIDC access token or a refresh token. The server performs the
OIDC authorization-code flow with PKCE, fetches UserInfo, creates a session, and sets an
opaque cookie.

- Cookie: `__Host-ov_session`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
- Session id: 32 random bytes, stored only as a SHA-256 hash.
- Lifetime: `OPENVAULT_SESSION_TTL_HOURS` (default 8, range 1–24), measured from creation.
- CSRF: a per-session token returned by `/v1/auth/me`; mutating requests send
  `X-CSRF-Token`. The server also requires a same-origin `Origin` or
  `Sec-Fetch-Site: same-origin` for cookie-authenticated mutations.
- Rotation: `POST /v1/auth/refresh` rotates the session secret and CSRF token and preserves
  the absolute expiry. The old secret no longer authenticates. A concurrent or retried
  refresh within ten seconds receives the same new secret, so two tabs do not clobber each
  other.
- Listing: `GET /v1/auth/sessions` returns public session ids, timestamps, auth method, and a
  current flag. `DELETE /v1/auth/sessions/:id` revokes an owned session.
- OIDC tokens are discarded after the login. They are not stored in the cache or database.
- Sessions live in memory in v0.1; a server restart signs users out. Disabling a principal
  invalidates its sessions on the next request.

If a principal is disabled, the session middleware revokes the session and clears the cookie.
Forced password changes allow only `/v1/auth/me`, `/v1/auth/password`, `/v1/auth/logout`, and
`GET /v1/meta/*` until the change succeeds.

## Local login

`POST /v1/auth/local/login` verifies an Argon2id password with the Node.js 24.7+ built-in
`crypto.argon2` (64 MiB memory, 3 passes, 1 lane) and creates the same opaque session.

- The identifier is trimmed and lowercased; a mixed-case email and surrounding whitespace are
  accepted.
- Unknown users, wrong passwords, disabled principals, and locked accounts all return
  `401 invalid_credentials` with the same body. Each rejected path spends one Argon2
  derivation, so the response time does not reveal whether the account exists.
- Five failures in a rolling 15-minute window lock the account for 15 minutes. While locked,
  the server does not verify the real password and does not extend the lock.
- Login is limited to 5/min per IP and 10/hour per account.
- `POST /v1/auth/password` requires the current password and a 12–1024 character new
  password. It revokes every other session and rotates the current session.

The bootstrap administrator is created by `ov init`. The bootstrap password is written once
to a file with mode `0600`; it is never printed to stdout, stderr, or container logs. The
administrator must change it before any other authenticated route succeeds. `ov init`
provisioning is owned by the CLI and operations releases; this release enforces the forced
change and the password-change endpoint.

## OIDC

Set `OPENVAULT_OIDC_ISSUER`, `OPENVAULT_OIDC_CLIENT_ID`,
`OPENVAULT_OIDC_CLIENT_SECRET`, and optionally `OPENVAULT_OIDC_REDIRECT_URL` and
`OPENVAULT_OIDC_ALLOWED_DOMAINS`. The default callback is
`${OPENVAULT_BASE_URL}/v1/auth/callback`.

The flow uses PKCE `S256`, state, and nonce. Discovery, token exchange, and UserInfo requests
use a 5-second timeout. Login sets a short-lived `__Host-ov_oidc` binding cookie; the callback
requires the cookie and compares its hash with the state record, so a flow started in another
browser cannot be completed in yours.

Identity is linked by `(issuer, subject)`. JIT provisioning is disabled unless
`OPENVAULT_OIDC_ALLOWED_DOMAINS` is set, and then it requires `email_verified: true`, an exact
allowed-domain match, and an unused normalized email. A verified email that already belongs to
another principal is rejected and must be linked by an administrator; it is never auto-linked.
JIT users receive no roles until an administrator grants them.

`GET /v1/meta/auth` tells the UI which methods are enabled. The SSO button is hidden when
OIDC is not configured. A provider outage returns `503 oidc_unavailable`; a bad callback
returns `400 oidc_callback_failed`; a denied identity returns `403 access_denied`.

## CLI tokens

`POST /v1/auth/cli/login` returns a short-lived Ed25519 JWT and an opaque refresh token.
Refresh tokens rotate on use and are stored hashed. Reuse revokes the family.

The CLI stores credentials in `~/.config/openvault/credentials.json`, mode `0600`.

## Agent certificates

1. An administrator creates a service identity and a single-use join token.
2. The agent generates an EC P-256 key and CSR.
3. `POST /v1/agent/join` validates the token, signs the certificate, and stores the
   fingerprint.
4. The agent connects with mTLS.
5. Renewal is allowed after two thirds of the 30-day lifetime.

Revocation is checked on every connection. A revoked agent removes its files and exits.

## Next

- [RBAC](/guide/rbac)
- [Threat model](/security/threat-model)

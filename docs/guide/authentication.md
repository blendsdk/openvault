# Authentication

OpenVault has three credential types:

| Caller | Credential | Lifetime |
|---|---|---|
| Browser | Opaque BFF session cookie | 8 hours by default |
| CLI | Ed25519 JWT + rotating refresh token | 15 minutes / 12 hours |
| Agent | One-time join token, then mTLS | `OPENVAULT_CERT_TTL_DAYS`, default 30, renewed |

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
Refresh tokens rotate on use and are stored hashed. A family has an absolute 12-hour lifetime
from login; rotation does not extend it. Reuse, logout, password change, or principal disable
revokes the family. Every access-token request checks the principal status and a live family
row.

- `POST /v1/auth/cli/refresh` rotates both tokens. The old refresh token fails, and a reused
  token revokes the whole family.
- `POST /v1/auth/cli/logout` revokes the family and returns `204` for any well-formed token,
  including one that was already used or cleaned up.
- `GET /v1/auth/cli/me` returns the public user and the forced-change flag.
- `GET /v1/auth/cli/sessions` lists only the caller's live families, newest first, with the
  original login time and a `current` flag. It never returns a hash or row id.
- `DELETE /v1/auth/cli/sessions/:familyId` revokes an owned live family and returns
  `404 session_not_found` for an unknown, foreign, expired, or already-revoked family.
- Refresh is limited to 60/minute per IP and 30/minute per family. The family bucket is keyed
  by the family id, so rotation does not reset it.
- While a password change is required, a CLI caller may use only `GET /v1/auth/cli/me` and
  logout. Other CLI data routes return `403 password_change_required`.

CLI routes authorize on a bearer or refresh token, never on the browser cookie. A valid bearer
takes precedence over a cookie; an invalid bearer does not fall back to one. CLI refresh and
logout never set a cookie.

The CLI stores credentials in an OS-specific config directory with a `0700` directory and
`0600` file on POSIX, or a current-user ACL on Windows. Writes are atomic, symlinks are
rejected, and concurrent processes are serialized. Tokens never appear in argv or logs.

## Agent certificates

1. An administrator creates a service identity owned by a project and issues a single-use
   join token. The token is shown once, stored only as a SHA-256 hash, and expires after 15
   minutes by default (maximum 24 hours).
2. The agent generates an EC P-256 key and PKCS#10 CSR with consumer metadata.
3. `POST /v1/agent/join` is the only agent route that does not require a client certificate.
   It validates the CSR, claims the token atomically, derives the certificate identity from
   the token, signs the certificate, and stores the principal id, serial, SHA-256
   fingerprint, validity window, and revocation state.
4. The certificate has CN = principal id, exactly one SAN URI
   `openvault://identity/<id>`, `CA:FALSE`, `digitalSignature`, and `clientAuth`. Its lifetime
   is `OPENVAULT_CERT_TTL_DAYS` (default 30, range 1–90).
5. The agent connects with mTLS. Every other agent request checks the chain, fingerprint,
   expiry, revocation, principal status, and project status, with a cache bounded to 5
   seconds.
6. Renewal is allowed after two thirds of the certificate's actual lifetime and requires a
   fresh P-256 key and CSR. Only the newest certificate may renew; the old certificate stays
   valid for data until expiry. An expired certificate requires a new join token.

Join is limited to 10/minute per source IP; renew is limited to 10/minute per principal and
60/minute per source IP. A revoked identity's certificates and unused join tokens are
revoked in one transaction. No request succeeds more than 5 seconds after revocation; a
revoked agent removes its files and exits. Service identities cannot have a password, OIDC
identity, browser session, or CLI family.

## Next

- [RBAC](/guide/rbac)
- [Threat model](/security/threat-model)

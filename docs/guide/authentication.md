# Authentication

OpenVault has three credential types:

| Caller | Credential | Lifetime |
|---|---|---|
| Browser | Opaque BFF session cookie | 8 hours |
| CLI | Ed25519 JWT + rotating refresh token | 15 minutes / 12 hours |
| Agent | mTLS client certificate | 30 days, renewed |

## Browser sessions

The browser never sees an OIDC access token or a refresh token. The server performs the
OIDC authorization-code flow with PKCE, fetches UserInfo, creates a session, and sets an
opaque cookie.

- Cookie: `__Host-ov_session`, HttpOnly, Secure, SameSite=Lax, Path=/.
- Session id: 32 random bytes, hashed before storage.
- CSRF: a per-session token returned by `/v1/auth/me`; mutating requests send
  `X-CSRF-Token`.
- Rotation: refresh rotates the session id and cookie.
- OIDC tokens are discarded after the login. They are not stored.
- Sessions live in memory in v0.1; a server restart signs users out.

## Local login

`POST /v1/auth/local/login` verifies an Argon2id password and creates the same session.
The bootstrap administrator is created by `ov init` and must change the password on first
login.

## OIDC

Set `OPENVAULT_OIDC_ISSUER`, `OPENVAULT_OIDC_CLIENT_ID`, and
`OPENVAULT_OIDC_CLIENT_SECRET`. The callback is
`${OPENVAULT_BASE_URL}/v1/auth/callback`.

Identity is linked by `(issuer, subject)`. Just-in-time provisioning is disabled unless
`OPENVAULT_OIDC_ALLOWED_DOMAINS` is set.

`GET /v1/meta/auth` tells the UI which methods are enabled. The SSO button is hidden when
OIDC is not configured.

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

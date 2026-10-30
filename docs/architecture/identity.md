# Identity

OpenVault has one identity model with different proofs for browsers, the CLI, and agents.

## Browser: BFF session

The server performs the OIDC authorization-code flow with PKCE and creates an opaque
session. The browser never sees an OIDC token.

- Cookie `__Host-ov_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
- Session id is 32 random bytes, stored only as a SHA-256 hash.
- Absolute lifetime is `OPENVAULT_SESSION_TTL_HOURS` (default 8, range 1–24), measured from
  creation.
- Refresh rotates the secret and the per-session CSRF token; the public ULID stays stable so
  the session list does not duplicate.
- CSRF token returned by `/v1/auth/me`; unsafe browser requests also pass an Origin or
  `Sec-Fetch-Site` check.
- OIDC access, refresh, and ID tokens are discarded after login.
- Local password login creates the same session.

OIDC login sets a `__Host-ov_oidc` binding cookie. The state record stores only its SHA-256
hash; the callback compares the cookie in constant time. This binds the authorization flow
to the browser that started it.

JIT provisioning is a system action, not an admin `identity.create` call. It requires
`email_verified: true`, an exact allowed-domain match, and an unused normalized email. A
verified email that belongs to another principal is a collision that an administrator must
link; JIT users receive no roles until RBAC grants them.

Sessions live in memory in v0.1. A server restart signs users out.

## CLI: JWT

- Ed25519 JWT, 15 minutes, issuer `openvault`, audience `openvault-cli`.
- Refresh token 12 hours, stored hashed, rotates on use.
- Reuse revokes the family.
- Credentials in `~/.config/openvault/credentials.json`, mode `0600`.

## Agent: mTLS

1. Administrator creates a service identity owned by a project.
2. Administrator issues a single-use join token.
3. Agent generates an EC P-256 key and CSR with consumer metadata.
4. Server signs a 30-day certificate with the internal CA.
5. Agent connects over mTLS; the server checks fingerprint, expiry, and revocation.

Revocation takes effect within 5 seconds. A revoked agent removes its files and exits.

## WebAFX providers

| Principal service | Provider | Credential |
|---|---|---|
| `user` | Composite | Browser session, CLI bearer, or agent mTLS |
| `browser` | Session | `__Host-ov_session` cookie |
| `cli` | JWT | Ed25519 bearer |
| `agent` | mTLS | Client certificate fingerprint |

Data routes use `user` so browsers and CLI share handlers. Browser-only routes use
`browser`; agent routes use `agent`.

## Claims

```json
{
  "sub": "01J...",
  "kind": "user",
  "authMethod": "local",
  "name": "Alice",
  "email": "alice@example.com",
  "roles": ["project.admin"],
  "permissions": ["secret.read", "secret.write"],
  "projects": ["01J..."]
}
```

Claims are a UI convenience. The server re-evaluates policy from the database on every
request.

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

Sessions live in memory in v1.0. A server restart signs users out.

## CLI: JWT

- Ed25519 JWT, 15 minutes, issuer `openvault`, audience `openvault-cli`.
- Claims: `sub`, `sid`, `jti`, `iat`, `exp`, and `kind`. `sid` is the CLI session family id.
- Refresh token 12 hours absolute per family, stored hashed, rotates on use.
- Reuse, logout, or password change revokes the family.
- Every access-token request checks the principal status and a live family row.
- Credentials in `~/.config/openvault/credentials.json`, mode `0600`; the `ov` CLI owns the
  file, atomic write, OS-specific paths, and concurrent-process locking.

## Agent: mTLS

1. An administrator creates a service identity owned by a project and issues a single-use
   join token. The token is 32 random bytes, shown once, stored as a SHA-256 hash, and expires
   after 15 minutes by default (maximum 24 hours).
2. The agent generates an EC P-256 key and a PKCS#10 CSR with consumer metadata.
3. `POST /v1/agent/join` is the only agent route reachable without a client certificate. It
   validates the CSR, claims the token atomically, derives the certificate identity from the
   token, and signs a certificate with the internal CA.
4. The certificate has CN = principal id, exactly one SAN URI
   `openvault://identity/<id>`, `CA:FALSE`, `digitalSignature`, and `clientAuth`. Its lifetime
   is `OPENVAULT_CERT_TTL_DAYS` (default 30, range 1–90).
5. The agent connects over mTLS. Every other agent request checks the chain, fingerprint,
   expiry, revocation, principal status, and project status. The check runs per request with
   a cache bounded to 5 seconds, so an existing keep-alive connection cannot outlive a
   revocation.
6. The agent renews after two thirds of the certificate's actual lifetime with a fresh key and
   CSR. Only the newest certificate may renew; older certificates remain valid for data until
   expiry. An expired certificate requires a new join token.
7. An identity revoke disables the principal and revokes every certificate and unused join
   token in one transaction. No request succeeds more than 5 seconds after revocation.

A service identity cannot have a local password, OIDC identity, browser session, or CLI
family. It cannot hold a control-plane action. A revoked agent removes its files and exits;
the secrets already delivered to the application cannot be retracted, so rotate them.

## WebAFX providers

| Principal service | Provider | Credential |
|---|---|---|
| `user` | Composite | Browser session, CLI bearer, or agent mTLS |
| `browser` | Session | `__Host-ov_session` cookie |
| `cli` | JWT | Ed25519 bearer |
| `agent` | mTLS | Client certificate fingerprint; join uses a one-time token |

Data routes use `user` so browsers and CLI share handlers. Browser-only routes use
`browser`; agent routes use `agent`.

## Claims

CLI access tokens carry only:

```json
{
  "iss": "openvault",
  "aud": "openvault-cli",
  "sub": "01J...",
  "sid": "01J...",
  "jti": "01J...",
  "iat": 1760000000,
  "exp": 1760000900,
  "kind": "user"
}
```

Roles, permissions, and project scope are not token claims. The server re-evaluates them from
the database on every request, so role changes and revocations take effect immediately. A
browser session returns a public user object with name, email, and auth method; that object is
not copied into the JWT.

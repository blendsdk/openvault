# RD-04: CLI Authentication

> **Document**: RD-04-cli-auth.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-03
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines how the `ov` CLI authenticates a human without a browser session. It
issues a short-lived Ed25519 JWT and a rotating opaque refresh token, stores them with mode
`0600`, and supports logout and family revocation.

## Functional Requirements

### Must Have

- [ ] `POST /v1/auth/cli/login` accepts identifier and password and returns an access token
  and refresh token.
- [ ] Access token is an Ed25519 JWT with 15-minute lifetime, issuer `openvault`, audience
  `openvault-cli`, and claims `sub`, `sid`, `jti`, `iat`, `exp`, `kind`.
- [ ] Refresh token is 32 random bytes, stored as SHA-256 in `cli_sessions`, with a 12-hour
  lifetime.
- [ ] Refresh tokens rotate on every use.
- [ ] Reuse of an already-rotated refresh token revokes the whole family.
- [ ] `POST /v1/auth/cli/refresh` returns a new pair; `POST /v1/auth/cli/logout` revokes the
  family.
- [ ] The CLI stores credentials in `~/.config/openvault/credentials.json` with mode `0600`.
- [ ] Login is rate limited with the same per-IP and per-account limits as RD-03.
- [ ] Disabling a principal revokes its CLI sessions within 5 seconds.
- [ ] The JWT signing key is Ed25519, generated at init, wrapped by the KEK, and identified by
  `kid`; rotation supports two active keys.

### Should Have

- [ ] `ov sessions` lists and revokes CLI sessions.
- [ ] Credential file uses an OS-specific config directory on macOS and Windows.

### Won't Have (Out of Scope)

- OIDC login for the CLI (v0.2).
- Device authorization flow.
- Long-lived API keys.

## Technical Requirements

### Token model

| Token | Format | Lifetime | Storage |
|---|---|---|---|
| Access | Ed25519 JWT | 15 minutes | CLI memory / credentials file |
| Refresh | 32 random bytes | 12 hours | SHA-256 in `cli_sessions` |
| Signing key | Ed25519 private key | Rotatable | Wrapped by KEK |

Claims:

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

### Rotation and reuse

- Each refresh creates a new row and marks the old row rotated.
- Presenting a rotated token revokes every row in the family and returns 401.
- Logout revokes the family.
- Disabling a principal revokes every family for that principal.

### Storage

- The CLI writes the file atomically with mode `0600`.
- The file is never logged and never included in diagnostics.
- `ov logout` removes the file.
- The CLI never passes tokens in command-line arguments.

## Integration Points

- RD-03 supplies the local credential verifier and lockout state.
- RD-06 uses the JWT principal for policy.
- RD-07 audits login, refresh, reuse detection, and logout.
- RD-11 implements the CLI commands.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| CLI auth | API key / JWT + refresh / OIDC | JWT + rotating refresh | Short-lived, revocable | AR-6 |
| Access lifetime | 5 / 15 / 60 minutes | 15 minutes | Limits stolen-token window | AR-14 |
| Refresh lifetime | 1 / 12 / 24 hours | 12 hours | Usable but bounded | AR-12 |
| OIDC CLI | v0.1 / v0.2 | v0.2 | Scope control | AR-30 |
| Credential storage | Plain file / 0600 file / keychain | 0600 file | Cross-platform baseline | AR-29 |

## Security Considerations

- **Data sensitivity:** access and refresh tokens are bearer credentials.
- **Input validation:** identifier, password, refresh token length and format.
- **Authentication & authorization:** login is public and rate limited; refresh requires a
  valid token; logout is idempotent.
- **Injection risks:** no SQL from token fields; parameterized queries.
- **Encryption needs:** TLS; signing key wrapped by KEK; refresh hashes only.
- **Rate limiting:** login and refresh limits.
- **Infrastructure:** token files mode `0600`, no tokens in logs or argv.

## Acceptance Criteria

1. [ ] A valid CLI login returns a JWT with the exact issuer, audience, and 15-minute
   lifetime; the refresh token is not a JWT and is 32 bytes.
2. [ ] `cli_sessions` stores only a SHA-256 hash, never the raw refresh token.
3. [ ] Refresh returns a new access and refresh token; the old refresh token fails.
4. [ ] Reusing an old refresh token revokes the family; the current refresh token also fails.
5. [ ] Logout revokes the family; a subsequent refresh returns 401.
6. [ ] Disabling the principal makes the next refresh and access-token request fail within
   5 seconds.
7. [ ] The credentials file is created with mode `0600` and removed by `ov logout`.
8. [ ] Tokens never appear in argv, logs, or error bodies.
9. [ ] Security requirements verified: token lifetimes, rotation, reuse detection, storage
   permissions.

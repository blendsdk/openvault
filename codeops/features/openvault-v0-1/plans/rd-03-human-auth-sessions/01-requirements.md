# Requirements: RD-03 Human Authentication and Sessions

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-03](../../requirements/RD-03-human-auth-sessions.md) — the owning requirements document
> **Preflight**: [00-preflight-report-RD-03.md](../../requirements/00-preflight-report-RD-03.md)

## Scope of this plan (delta view)

### In this plan
- Local password login with Argon2id, lockout, and per-IP/per-account rate limits — RD-03 lines 24–36, 66–80.
- OIDC authorization-code flow with PKCE, state, nonce, UserInfo, and JIT rules — RD-03 lines 25–28, 38–41, 82–92.
- Opaque sessions, cookie attributes, absolute TTL, rotation, CSRF, and origin checks — RD-03 lines 42–50, 94–113.
- Password change and the forced-change gate — RD-03 lines 37, 79–80; preflight PF-006.
- Session list/revoke and last-login data — RD-03 lines 54–56; preflight PF-005/PF-015.
- `GET /v1/meta/auth` — RD-03 line 48.
- Shared API schemas, log sanitization, Node 24.7+ baseline, and documentation — preflight PF-004/PF-011/PF-016.

### Deferred / out of this plan
- `ov init` and the one-time `0600` bootstrap password file — RD-11/RD-13 (preflight PF-007).
- OIDC admin linking UI and RBAC role assignment — RD-06/RD-12.
- Audit event persistence and last-login history — RD-07.
- CLI and agent authentication — RD-04/RD-05.
- Multi-instance session/rate-limit storage — v0.2 (preflight PF-017).

## Plan-local decisions

| Decision | Chosen | AR Ref |
|---|---|---|
| OIDC library and direct client use | `openid-client` 6.8.8 with a timed fetch; no WebAFX controller | AR-2 |
| Password hash format | PHC `$argon2id$v=19$m=65536,t=3,p=1$…` | AR-4 |
| Public session and principal IDs | ULID via `newUlid()` in `@openvault/core` | AR-5 |
| Session expiry and rotation | Absolute TTL; rotate secret + CSRF; stable public ID | AR-6 |
| Lockout window | `updated_at` anchor; atomic update | AR-7 |
| Rate-limit order and keys | Per-IP first; per-account hash | AR-8 |
| CSRF wiring | Session-scoped WebAFX middleware + origin guard | AR-9 |
| OIDC state and returnTo | Memory cache, 600s, atomic take, strict returnTo | AR-10 |
| API contracts | Shared Zod schemas | AR-12 |
| Log sanitizer | Pino hook + redaction paths | AR-13 |
| Error codes | Stable auth codes | AR-14 |
| OIDC test harness | Fake HTTPS IdP with trusted fetch | AR-15 |
| Node baseline | 24.21.0 runtime, `>=24.7.0` engine | AR-18 |
| OIDC client authentication | `client_secret_basic`, three scopes | AR-19 |
| Session TTL config | `OPENVAULT_SESSION_TTL_HOURS`, default 8 | AR-20 |
| Last login | Current session `createdAt` | AR-21 |

## Acceptance Criteria

The RD's 14 acceptance criteria are the oracle. This plan adds no new product acceptance criteria;
it adds only the following verification obligations that trace to the preflight:

1. [ ] The Node 24.21.0 baseline is used in `.nvmrc`, CI, and the documented requirements; `pnpm verify` passes under it.
2. [ ] `openid-client` is an exact production dependency and `pnpm audit:prod` is clean.
3. [ ] No request log contains OIDC `code`/`state`, tokens, passwords, hashes, or CSRF values.
4. [ ] No database migration is introduced; `pnpm db:types:check` remains clean.
5. [ ] The API reference and authentication guide list every new route and the bootstrap-file behavior.

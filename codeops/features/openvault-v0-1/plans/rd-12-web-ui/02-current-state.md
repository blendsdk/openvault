# Current State: RD-12 Web UI

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## What exists

| Area | State | Evidence |
|---|---|---|
| Web package | React 19, Vite 8, Fluent UI 9.75, custom component package 0.6.0, BlendSDK 5.68.1, React Router 7.18, React Hook Form 7.91 | `apps/web/package.json` |
| Web app | One proof-of-concept card that links to `/v1/ready` | `apps/web/src/App.tsx` |
| Web tests | One render assertion | `apps/web/tests/App.test.tsx` |
| Browser auth | Local login, `/me`, refresh, logout, password change, sessions, OIDC redirect/callback | `apps/server/src/controllers/auth.ts`, `oidc.ts` |
| CSRF | Session-scoped `X-CSRF-Token` guard and same-origin guard | `apps/server/src/auth/csrf.ts` |
| Session response | `{ user, expiresAt, csrfToken, mustChangePassword, lastLoginAt }` | `packages/api-contract/src/auth.ts` |
| Projects | List/create/read/update/delete by ULID; list includes certificate count | `apps/server/src/controllers/projects.ts` |
| Secrets | List, create, read value, versions, consumers, write, metadata, delete, recover, purge | `apps/server/src/controllers/secrets.ts` |
| Identities | List/create/detail/revoke/join token; detail embeds consumer metadata | `apps/server/src/controllers/identity.ts` |
| RBAC | Role catalog, assignments, access explain | `apps/server/src/controllers/assignments.ts`, `meta.ts` |
| Audit | Query, verify, export | `apps/server/src/controllers/audit.ts` |
| Generated client | CLI bearer client and OpenAPI document | `apps/cli/src/generated`, `packages/api-contract/openapi.json` |
| Static serving | None | `apps/server/src/app.ts` has no static plugin |
| CSP | Deny-by-default | `apps/server/src/transport/pre-stack.ts` |

## Gaps that block RD-12

| Gap | Why it blocks | Resolution |
|---|---|---|
| No browser client | Hand-writing every call would drift; the CLI client excludes browser auth | Generate a web client and check it |
| No `sub` in the auth user | The SDK auth provider treats the session as unauthenticated | Add the additive alias |
| CSP blocks scripts/styles | The SPA cannot load | Conditional UI CSP |
| No static serving | The production build is unreachable | WebAFX static plugin with SPA fallback |
| No project consumers route | The consumers view has no direct source | Derive from identity detail |
| No secret metadata route | Detail must not read a value on load | List with an exact-name query |
| Broken dev proxy | HTTPS and origin guard reject dev mutations | Rewrite the proxy origin |

## Reusable server behavior

- **Capability flags:** secret metadata and value responses already include `canRead`,
  `canWrite`, `canDelete`, `canPurge`, and `canManage`.
- **Audit on reveal:** `SecretService.read` writes a `secret.read` event before returning.
- **Stable envelopes:** errors carry `{ code, message, requestId? }`; the generated client
  turns them into `ApiError`.
- **Role catalog:** `GET /v1/meta/roles` publishes roles, actions, and the policy version.
- **Session refresh:** `POST /v1/auth/refresh` rotates the cookie and the CSRF token.
- **Forced change:** `passwordChangeGate` limits a flagged session to the password/me/logout
  routes, so the UI must implement that flow.

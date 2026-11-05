# Web UI

The web UI is the day-to-day surface for projects, secrets, identities, permissions, audit, and
consumer visibility. The CLI remains the automation and incident surface.

## Sign in

The login page supports a local administrator account and, when configured, a single sign-on
button. The SSO button appears only when `GET /v1/meta/auth` reports `oidc: true`.

Local login posts the password once, receives the HttpOnly `__Host-ov_session` cookie and the
per-session CSRF token, and reloads into the project list. The reload is deliberate: the
BlendSDK auth provider learns a session from `GET /v1/auth/me`, so the new document performs
one session check with the cookie already set. The password is never stored. When the account
is flagged for a password change, the reload lands on the password-change screen; the server
allows only the UI assets and the password/me/logout routes until the change succeeds.

## Daily flows

| Screen | What it does |
|---|---|
| Projects | List, create, rename, and delete projects; deletion is not recoverable in the browser in v0.1 |
| Project overview | Ids, dates, certificate count, secret/identity/assignment counts, recent audit |
| Secrets | Search, tag filter, cursor pagination, create, and a masked value |
| Secret detail | Metadata, versions, consumers, audited reveal, and capability-gated actions; after a page reload a deleted secret is recovered with the CLI |
| Identities | Create, revoke, and issue one-time join tokens |
| Permissions | Explain effective access and grant or revoke scoped roles |
| Audit | Filter by time, actor, action, object, result, and request id; verify the chain |
| Consumers | Compose project/service, state, and last seen derived from identity metadata |

## Reveal and clipboard

The value is masked until **Reveal**. Reveal performs a server read with `secret.read`; the
server writes a `secret.read` audit event before returning. Focus moves to the revealed value,
so clicking elsewhere triggers the blur clear. The value lives only in component state and
clears when:

- the revealed region loses focus,
- the browser window loses focus,
- the route changes or the page unmounts,
- the session logs out, or
- 60 seconds pass.

Copy writes the value to the clipboard and, after 30 seconds, attempts to replace it with an
empty string while the document is focused. Hiding or navigating away does not cancel that
timer. If the page is not focused, or the browser blocks the replacement, the UI says so
instead of claiming a guaranteed clear.

No secret value is written to `localStorage`, `sessionStorage`, IndexedDB, a JavaScript
cookie, the URL, or logs. The only local-storage key is `openvault.theme` for the light/dark
preference.

## Permissions and capabilities

The browser never computes effective permissions. Secret metadata and value responses carry
`capabilities` (`canRead`, `canWrite`, `canDelete`, `canPurge`, `canManage`), and the UI hides
actions accordingly. A direct request is still authorized by the server.

The permissions screen calls `GET /v1/admin/access-explain` with the same project or secret
object scope that `ov access explain` uses. The assignment list includes both project-scope and
secret-object grants for the project. The editor filters roles to those valid for the chosen
scope, rejects a missing object target, a missing principal, a missing role, and a past expiry
before sending the request, and shows any server escalation error as-is.

## Development

```bash
pnpm --filter @openvault/server dev
pnpm --filter @openvault/web dev
```

The UI runs at `http://localhost:5173`. Vite proxies `/v1` to `https://localhost:8443` with
certificate verification disabled for the local development certificate, and rewrites
`Origin`/`Referer` to `OPENVAULT_BASE_URL` so the server's origin guard and CSRF checks behave
as they do in production. Override the target with `OPENVAULT_DEV_URL` and the public origin
with `OPENVAULT_BASE_URL`.

## Production serving

`pnpm --filter @openvault/web build` writes `apps/web/dist`. When that directory contains
`index.html` and `assets`, the server installs the WebAFX static plugins:

- `/assets/*` is hashed and cached immutably for one year,
- `index.html` is not cached,
- unknown `GET` HTML routes fall back to `index.html`,
- unknown API routes remain JSON 404s.

Set `OPENVAULT_WEB_ROOT` to serve a build from another directory or from a container path. If
the directory is absent the API starts normally and serves no UI.

The UI-enabled Content-Security-Policy allows same-origin scripts, connections, images,
fonts, and inline style elements (Fluent UI's Griffel runtime). Scripts remain `'self'` only
and there is no `unsafe-eval`. API-only deployments keep the deny-by-default policy.

## Accessibility

Every input has a label and an associated error. Page errors use `role="alert"`; loading
regions use `aria-busy`; tables have captions and header scope; status uses text and icons,
not color alone. Keyboard operation covers login, reveal, navigation, dialogs, and logout.
The layout has a persistent sidebar at desktop widths and a menu-driven top bar below
1024 px; tables scroll horizontally at 768 px.

Axe runs in the Vitest/jsdom suite on login, secret detail, and audit. Browser automation
across real engines belongs to the release assurance work.

## Out of scope in v0.1

Certificate screens, rotation wizards, settings, user self-registration, password reset,
rich secret editing, file upload, and additional locales. Use the `ov` CLI for certificates,
backup/restore, and KEK rotation.

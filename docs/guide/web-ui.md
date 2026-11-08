# Web UI

The web UI is the day-to-day surface for projects, secrets, certificates, identities, permissions,
audit, and consumer visibility. The CLI remains the automation and incident surface.

## Sign in

The login page supports a local administrator account and, when configured, a single sign-on
button. The SSO button appears only when `GET /v1/meta/auth` reports `oidc: true`.

Local login posts the password once, receives the HttpOnly `__Host-ov_session` cookie and the
per-session CSRF token, and reloads into the project list. The reload is deliberate: the
auth provider learns a session from `GET /v1/auth/me`, so the new document performs
one session check with the cookie already set. The password is never stored. When the account
is flagged for a password change, the reload lands on the password-change screen; the server
allows only the UI assets and the password/me/logout routes until the change succeeds.

## Navigation

The top bar uses the application launcher at every viewport width. It lists **Projects**
everywhere and adds the current project's sections when the route is inside a project. The
launcher search filters destinations by name and by a few related words, for example `roles`
for Permissions or `events` for Audit. Choosing an item closes the panel and clears the query.

The top bar also has a **Docs** link that opens the published guide in a new tab. The target
follows the current screen: the project list opens the project guide, the secret list opens
the secrets guide, secret detail opens the reveal section, the certificate list opens the
certificate guide, certificate detail opens its read-and-renew section, and identities,
permissions, audit, and consumers open their matching guides. Unknown routes fall back to the
documentation home.

The desktop sidebar remains a shortcut to Projects, and the account menu keeps the signed-in
address and sign-out action. The theme toggle is unchanged.

## Daily flows

| Screen | What it does |
|---|---|
| Projects | List, create, rename, and delete projects; deletion is not recoverable in the browser in v1.0 |
| Project overview | Ids, dates, certificate count, secret/identity/assignment counts, recent audit |
| Secrets | Search, tag filter, cursor pagination, create, and a masked value |
| Secret detail | Metadata, versions, consumers, audited reveal, and capability-gated actions; after a page reload a deleted secret is recovered with the CLI |
| Certificates | Search by name or subject, filter by SAN, expiry, and status, paginate, import, and generate |
| Certificate detail | Metadata, public leaf and chain, version-by-id read, tags, purge protection, delete, recover, purge, and audited private-key reveal and download |
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

The browser never computes effective permissions. Secret and certificate metadata and value
responses carry `capabilities` (`canRead`, `canWrite`, `canDelete`, `canRecover`, `canPurge`,
`canManage`, `canReadPrivate`), and the UI hides actions accordingly. A direct request is still
authorized by the server.

The permissions screen calls `GET /v1/admin/access-explain` with the same project or secret
object scope that `ov access explain` uses. The assignment list includes both project-scope and
secret-object grants for the project. The editor filters roles to those valid for the chosen
scope, rejects a missing object target, a missing principal, a missing role, and a past expiry
before sending the request, and shows any server escalation error as-is.

## Serving

The web UI is served from the same origin as the API. Hashed assets are cached for one year,
`index.html` is not cached, and unknown HTML routes fall back to the application shell. Unknown
API routes remain JSON 404s. If the UI is not installed, the API starts normally and serves no
UI.

The UI Content-Security-Policy allows same-origin scripts, connections, images, fonts, and
inline style elements. Scripts remain `'self'` only and there is no `unsafe-eval`. API-only
deployments keep the deny-by-default policy.

## Accessibility

Every input has a label and an associated error. Page errors use `role="alert"`; loading
regions use `aria-busy`; tables have captions and header scope; status uses text and icons,
not color alone. Keyboard operation covers login, reveal, navigation, dialogs, and logout.
The layout has a persistent sidebar at desktop widths, a launcher-driven top bar at every
width, and tables that scroll horizontally at 768 px.

Automated accessibility checks cover login, secret detail, the certificate list and detail,
audit, and the application shell.

## Out of scope

Rotation wizards, settings, user self-registration, password reset, rich secret editing, file
upload, and additional locales. Backup/restore and key-encryption-key rotation remain CLI tasks.

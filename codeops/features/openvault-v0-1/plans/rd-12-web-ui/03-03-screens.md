# Screens: RD-12

> **Document**: 03-03-screens.md
> **Parent**: [Index](00-index.md)

## Login (`/login`)

| Element | Behavior |
|---|---|
| Local form | Identifier and password; submit posts `/v1/auth/local/login`; generic error alert on 401; disables the button while pending |
| Password visibility | Show/hide toggle; the value is never logged |
| SSO | Button rendered only when `/v1/meta/auth` returns `oidc: true`; calls SDK `login(returnTo)` |
| Redirect | An already-authenticated user is sent to `/`; `returnTo` from router state is sanitized to a same-origin path |
| Forced change | If `mustChangePassword`, route to `/change-password` after login |
| Accessibility | `form` with labelled inputs, error `role="alert"`, focus moves to the error summary |

## Forced password change (`/change-password`)

Current password, new password, confirm. Client checks length ≥ 12 and equality; server errors
are shown inline. Success calls `refresh()` and returns to the target route.

## Projects (`/`)

| Element | Behavior |
|---|---|
| Header | Product mark, account menu, theme toggle, sign out |
| Table | Name, certificates, updated, actions; caption; keyboard rows |
| Create | Dialog with `FormTextField`, validates the project-name pattern |
| Rename | Dialog prefilled; PATCH; refreshes the list |
| Delete | `ConfirmDialog`; DELETE; refreshes the list |
| Empty | "No projects yet" plus `ov project create <name>` copy button |
| Error | Alert with retry; a 403 shows an access message, not a generic crash |

## Project layout

A header shows the project name, id, and quick navigation. Sections are routes:

| Section | Content |
|---|---|
| Overview | Counts for secrets/identities/assignments, recent audit summary, links |
| Secrets | List and create |
| Identities | List, create, revoke, join token |
| Permissions | Access explanation and assignments |
| Audit | Search and verify |
| Consumers | Compose project/service and last seen |

## Secret list (`/projects/:project/secrets`)

- Search box (`q`), tag key/value inputs, and a clear-filters button.
- Table: name, status, current version, tags, updated; no value column.
- `nextCursor` renders a "Load more" button.
- Loading skeleton/`Loading` with `aria-busy`; empty state includes
  `ov secret set <name> --project <project> --stdin`; error state has retry.
- Create dialog: name, value (password input), content type, tags; the value is sent once and
  cleared from form state on close.

## Secret detail (`/projects/:project/secrets/:name`)

| Area | Behavior |
|---|---|
| Header | Name, status, content type, current version, tags |
| Value | Masked `••••••••`; Reveal only if `capabilities.canRead`; Cancel/clear control |
| Reveal lifecycle | Server read, audit event, countdown, blur/window blur/route/unmount/60 s clear; copy button with best-effort 30 s clipboard clear |
| Versions | `listSecretVersions`; current marker; created/expiry |
| Consumers | `listSecretConsumers`; Compose project/service and last seen |
| Actions | New version (`canWrite`), delete (`canDelete`), recover when deleted, purge (`canPurge`); each has a confirmation |
| Not found | Shows a not-found panel; no value request |
| Accessibility | Reveal is a button; the revealed region is focusable and labelled; the countdown is text |

## Identities

- Table: name, status, created, actions.
- Create dialog: name (project id is resolved).
- Revoke uses confirmation and updates the list.
- Join token: dialog shows the token once, warns it cannot be retrieved, and offers copy; the
  token is never placed in the URL or storage.
- Empty state includes `ov identity create <name> --project <project>`.

## Permissions

Two panels:

1. **Explain access** — target selector (project or secret), action selector (`project.read`
   or `secret.read`), and a result table of principals, role, assignment id, scope, and
   consumer if present. The table matches `ov access explain`/`GET /v1/admin/access-explain`.
2. **Assignments** — list filtered to the project; create form with principal, role, scope
   type, object target, and optional expiry. Client blocks missing object targets and org
   scope ids other than `org`; the server's escalation error is shown in an alert. Revoke uses
   confirmation.

The role catalog (`GET /v1/meta/roles`) supplies role names and actions; the UI never derives
permissions from them.

## Audit

- Filters: from/to (`datetime-local`), actor id, action (`AUDIT_ACTIONS`), object type, object
  id, result, request id. Project is fixed to the current project.
- Verify card: "Verify chain" button, status text, reason, first broken event id, checked
  range.
- Event table: time, actor, action, result, object, request id; details in an expandable row
  or dialog. Caption and `aria-sort` where sortable.
- Pagination via `nextCursor`; empty state says no events match; 403 shows an access message.

## Consumers (`/projects/:project/consumers`)

- Load identities, then each identity detail in parallel; show the embedded consumer.
- Table: service identity, Compose project, Compose service, state, last seen. No hostname,
  path, manifest hash, or certificate value.
- Empty state explains that consumers appear after an agent joins with a join token and
  includes `ov identity join-token <name> --project <project>`.

## Shared components

| Component | Responsibility |
|---|---|
| `PageHeader` | Title, description, actions; moves focus to the title on route change |
| `AsyncPanel` | Loading, error, empty, and content states with retry |
| `DataTable` | Semantic table wrapper with caption, busy state, and horizontal scroll |
| `StatusBadge` | Text + icon status |
| `CopyButton` | Clipboard copy with a transient confirmation |
| `EmptyState` | Guidance plus a CLI command and copy button |
| `ConfirmProvider` | Destructive confirmation from the custom package |
| `FormTextField` | Label, hint, and error from the custom package |
| `DescriptionList` | Metadata blocks from the custom package |
| `CollapsibleSection` | Audit details and longer summaries from the custom package |

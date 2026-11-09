# Web UI: Secret Rotation Workflow

> **Document**: 03-04-web-ui.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the browser surface: the project Rotation page, the secret-detail rotation
card, the rotate and policy dialogs, the secrets-list badge, the project-overview counts, and the
generated-value lifecycle. It reuses the existing project shell, filter bar, table, dialog, feedback,
and capability patterns.

## Architecture

### Current architecture

- `App.tsx` mounts project pages under `ProjectRoute`.
- `project-route.tsx` owns the project section navigation.
- `app-shell.tsx` owns the launcher entries.
- `SecretDetailPage` already has a "New version" inline panel and a consumers table.
- `SecretsPage` owns the secret list and filters.
- `ProjectOverviewPage` owns the summary cards.
- `docs.ts` maps a route to the published guide.

### Proposed routes

```text
/projects/:project/rotation          RotationPage
/projects/:project/secrets/:name     rotation card + dialogs
/projects/:project/secrets           status badge and "Needs rotation" link
/projects/:project                   due/overdue counts
```

Add the **Rotation** section between Secrets and Identities. Add the launcher entry and docs mapping
to `/guide/rotation`. [AR-18, PAR-09]

## Implementation Details

### `RotationPage`

**State and query**

```ts
interface Filters {
  q: string;
  status: "policy" | "due" | "overdue";
}
```

The page calls `listSecrets({ project, limit: 25, rotation: filters.status, ...(q ? { q } : {}) })`.
`policy` lists every secret with a policy; `due` lists due-soon or overdue; `overdue` lists overdue.
[AR-19, PAR-03]

**Table**

| Column | Render |
|---|---|
| Name | link to secret detail |
| Status | `ok`, `due_soon`, `overdue` badge |
| Due | `formatTime(rotationDueAt)` plus `in N days` / `N days overdue` |
| Interval | `every N days` |
| Last rotated | `formatTime(currentVersion.createdAt)` |
| Consumers | count from `secret.consumers.length` |
| Action | **Rotate** button, visible when `capabilities.canWrite` |

The table has a caption and header scope; it scrolls horizontally at 768 px. [AR-18, PAR-15]

**Filters**

Search by name; Status select (All policies / Needs attention / Overdue); Apply; Clear. The default
is All policies. Load more uses the existing cursor pattern. [AR-19]

**Empty states**

| Condition | Title | Action |
|---|---|---|
| No policies | No rotation policies yet | Set a policy from a secret |
| No matches | No secrets match | Clear filters |
| No overdue | Nothing is overdue | Back to all policies |

### Secret detail rotation card

Place the card above or beside the existing version history. It shows:

- Interval (`every N days` or `No policy`)
- Due date and status
- Last rotated (`currentVersion.createdAt`)
- Consumers: Compose project/service, state, last seen (reuse the existing summary)
- **Set policy** (when `canWrite`)
- **Rotate now** (when `canWrite`)
- A note: “The agent fetches the new version on its next refresh. Restart or reload the application
  to use it.” [AR-20, AR-28]

### `RotationPolicyDialog`

Fields:

| Field | Validation |
|---|---|
| Interval days | Integer 1–3650 |
| Remove policy | Checkbox or secondary action that sends `null` |

The dialog calls `updateSecretMetadata({ rotationIntervalDays })`. It pre-fills the current interval.
The success state reloads the detail metadata. [AR-9, PAR-09]

### `RotationDialog`

Props: `open`, `project`, `secret`, `onClose`, `onSaved`.

Fields:

| Field | Validation |
|---|---|
| New value | Required unless generated; existing secret value limits |
| Generate value | Button that fills the value with 32 random bytes base64url |
| Copy value | Copies the current value; only for public/manual use |
| Regenerate | Replaces a generated value |
| Expires at | Optional future ISO timestamp |

Behavior:

- If the operator generates a value, show a one-time notice: “Copy this value now if the consumer
  needs it outside OpenVault. It will not be shown again.”
- The value exists only in component state. It is cleared on close, route change, and unmount.
- Submit calls `writeSecretValue` with the value, encoding, optional expiry, and no old-version
  deletion.
- Success shows the new version id and next due date; the dialog closes.
- Do not auto-close while a request is in flight. [AR-5, AR-17, AR-6, PAR-10]

### Secrets list badge

The secrets list adds a Rotation column or a small badge next to the status:

- `due_soon` / `overdue` badge when a policy exists;
- `No policy` or an em dash when none;
- a **Needs rotation** link/filter that navigates to `/rotation?status=due`. [AR-18, AR-19]

### Project overview

Add a summary card with due-soon and overdue counts and an **Open rotation** link. The count comes
from one list request with `rotation=due` and `limit=100`. The card shows “N need attention”; when
`nextCursor` is not null, it shows “100+” because the page is capped. This avoids a new count API for
a small deployment. [AR-18, PAR-03]

### Generated value

Use:

```ts
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
const value = base64Url(bytes);
```

The helper lives in `validation.ts` or a small `generated-value.ts`. The value is shown in a
read-only input, copied through the existing credential copy helper, and never written to local
storage, session storage, IndexedDB, cookies, the URL, or the console. [AR-17, PAR-10]

### Error handling

| Case | Handling | Ref |
|---|---|---|
| Interval invalid | Field error; no request | AR-9 |
| Write denied | “You do not have permission for this action.” | AR-11 |
| Version conflict or validation | Server message in `ErrorAlert`; keep the dialog open | AR-12 |
| No policy | Rotate card shows “No policy” and Set policy | AR-9 |
| No consumers | Consumers table shows an empty state | AR-20 |
| Generated value lost by closing | Regenerate before submitting; no persistence | AR-17 |

### Accessibility

- Labels and errors for every field; dialog focus trap and restore.
- Table caption and header scope.
- Status uses text and an icon.
- Add the Rotation page and rotate dialog to the axe suite. [PAR-15]

## Testing Requirements

- `rotation-page.test.tsx`: rendering, filters, pagination, empty states, capability gating.
- `rotation-policy.test.tsx`: set/clear, validation, reload.
- `rotation-dialog.test.tsx`: manual value, generate, regenerate, copy, expiry, success, no storage.
- `secret-detail` rotation card and `secrets-list` badge tests.
- `project-overview` counts.
- Navigation/docs mapping.
- Axe coverage. [AR-25, PAR-11, PAR-15]

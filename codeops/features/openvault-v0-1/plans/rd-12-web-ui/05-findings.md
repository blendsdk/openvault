# Findings Ledger: RD-12 Web UI

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)
> **Status**: Closed — no open critical or major finding
> **Last Updated**: 2026-11-06 15:00
> **CodeOps Artifact Schema**: 1

## Purpose

This ledger records the independent post-execution correctness and security/accessibility
reviews, their rulings, and the accepted residuals. Planning-stage findings are in
[00-preflight-report.md](00-preflight-report.md).

## Correctness Findings

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| C-01 | Major | After delete, the detail page kept showing active metadata, so Recover and Purge never appeared. | The deleted override now takes precedence in-session; versions/consumers stop loading for a deleted secret. A reload uses the CLI for recovery, documented as a residual. | Resolved |
| C-02 | Major | The assignment list filtered to project scope only, hiding secret-object grants created by the same form. | The page lists visible assignments and filters them to the project plus the project's secret ids; object rows show the secret name. | Resolved |
| C-03 | Major | The project-delete confirmation claimed secrets stay recoverable. | The confirmation now says the project and its secrets become hidden and v0.1 has no project recovery. | Resolved |
| C-04 | Major | Reveal did not focus the value, so clicking elsewhere did not fire the blur clear. | The revealed textarea receives focus; the native capture blur listener clears when focus leaves the region. | Resolved |
| C-05 | Minor | The create-secret form kept plaintext in form state after Cancel or dialog dismissal. | Every close path resets the form; the new-version panel resets on Cancel. | Resolved |
| C-06 | Minor | Clearing the reveal cancelled the 30-second clipboard-clear timer. | The clipboard timer is independent of reveal lifetime, warns when the page is not focused, and reports blocked clearing. | Resolved |
| C-07 | Minor | The role selector offered roles invalid for the chosen scope. | Roles are filtered by the catalog's `scopes` for the selected project/object scope. | Resolved |
| C-08 | Minor | Supporting loaders had no error or loading surface. | The permissions page shows a combined alert with retry and disables Grant until the catalog is ready. | Resolved |
| C-09 | Minor | Project pages rendered two `<h1 id="page-title">` elements. | The project context header is no longer a heading; child pages own the single h1; `PageHeader` uses `useId`. | Resolved |
| C-10 | Minor | Expired versions rendered as `deleted`, and audit results were relabeled as `failed`/`degraded`. | Status badges accept an explicit label; audit shows the raw result and versions show `expired`. | Resolved |
| C-11 | Minor | The overview's secrets count was the first page size. | The card is labelled "Recent secrets" and shows the current page with the existing "more available" note. | Resolved |
| C-12 | Minor | The docs claimed JSON 404s for unknown API routes, but the SPA fallback could return HTML. | A terminal `/v1` JSON 404 plugin runs before the SPA fallback; the integration test covers `Accept: text/html`. | Resolved |
| C-13 | Minor | `/change-password` was outside `AuthGuard`. | The route now sits under `AuthGuard`; unauthenticated visitors go to login. | Resolved |
| C-14 | Minor | Project delete/rename tests used a fake with no PATCH/DELETE handler; object-scope permissions were untested. | The fake handles both mutations, a rename success test exists, and the permissions test asserts an object-scope row. | Resolved |
| C-15 | Minor | A stale CSRF token after another tab refreshed caused permanent 403s; logout could leave the server session alive. | The client owns the refresh schedule, recovers a 403 `csrf_invalid` by re-reading `/me`, and calls the generated logout route before clearing local state. | Resolved |

## Security and Accessibility Findings

| ID | Severity | Finding | Ruling | Status |
|---|---|---|---|---|
| S-01 | Major | The forced-password-change gate blocked `/change-password` and `/assets/*`, so the screen could not load. | Browser GETs outside `/v1` pass the gate; a unit test covers the screen and an asset. | Resolved |
| S-02 | Major | Copying a value did not reliably clear the clipboard after 30 seconds. | The timer survives reveal clearing and navigation; the UI reports unfocused or blocked clearing. | Resolved |
| S-03 | Major | The SDK treated ISO `expiresAt` as Unix seconds, refreshing immediately and rotating tokens unexpectedly. | The SDK auto-refresh is disabled; the client owns a schedule based on the ISO expiry and the current token. | Resolved |
| S-09 | Major | Disabling SDK auto-refresh removed the path that cleared auth state when a session expired. | The app scheduler now runs `/refresh`; on failure it recovers once, checks `/me`, and clears the SDK state with `logout()` only when the server confirms 401. A fake-timer test covers the expiry path. | Resolved |
| S-04 | Minor | The SPA fallback shadowed unknown API 404s for HTML clients. | The `/v1` terminal 404 plugin resolves both Accept variants. | Resolved |
| S-05 | Minor | The table scroll container was documented as focusable but had no tab stop. | The scroll region has `tabIndex={0}` with a targeted lint exception and a visible focus ring. | Resolved |
| S-06 | Minor | Duplicate h1 ids on project pages. | Single page h1; unique id from `useId`. | Resolved |
| S-07 | Minor | Reveal did not move focus or announce the new value. | The read-only textarea receives focus and carries the "Revealed secret value" accessible name; the countdown is a live region. | Resolved |
| S-08 | Minor | Secret forms retained plaintext after Cancel. | All close paths reset the form. | Resolved |

## Accepted Residuals

| ID | Residual | Reason | Documentation |
|---|---|---|---|
| RR-01 | Deleted-secret recovery after a page reload is CLI-only | The list API returns active secrets only; adding a deleted-metadata route is outside the RD-12 minimum. The in-session delete/recover/purge flow works. | `docs/guide/web-ui.md` |
| RR-02 | Project deletion has no browser recovery | The project service has no restore route in v0.1. | `docs/security/limitations.md` |
| RR-03 | Clipboard clearing is best effort | Browsers can deny writes or skip the delayed clear while unfocused. | `docs/security/limitations.md` |
| RR-04 | Inline styles in the UI CSP | Fluent UI Griffel injects style elements; scripts remain `'self'` only. | `docs/security/limitations.md` |
| RR-05 | Axe is jsdom-only in this release | Real-browser Playwright checks belong to release assurance. | `docs/security/limitations.md` |
| RR-06 | Consumers are derived from identity detail | The v0.1 API has no project consumer list route. | `docs/security/limitations.md` |
| RR-07 | No certificate screens | v0.1 keeps certificate lifecycle in the CLI. | `docs/guide/web-ui.md` |

## Verification Evidence

| Gate | Result | Date |
|---|---|---|
| Planning preflight | Passed | 2026-11-06 |
| `pnpm verify` | Passed | 2026-11-06 |
| `pnpm api:check` | `CLEAN` | 2026-11-06 |
| `pnpm lint` | Passed with baseline warnings only | 2026-11-06 |
| Web component tests | 31/31 | 2026-11-06 |
| Axe (login, secret detail, audit) | No serious/critical | 2026-11-06 |
| PostgreSQL 16 integration | 696/696 | 2026-11-06 |
| PostgreSQL 17 integration | 696/696 | 2026-11-06 |
| Independent correctness review | Resolved; no open major after fixes | 2026-11-06 |
| Independent security/accessibility review | Resolved; no open major after fixes | 2026-11-06 |

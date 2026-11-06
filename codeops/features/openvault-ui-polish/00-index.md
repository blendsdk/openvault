# OpenVault UI polish: issues #34, #35, #36

> **Feature**: Navigation launcher, brand identity, and vertical rhythm for the web UI.
> **Status**: Done
> **Created**: 2026-11-06 12:55
> **Completed**: 2026-11-06 13:24
> **Issues**: [#34](https://github.com/blendsdk/openvault/issues/34), [#35](https://github.com/blendsdk/openvault/issues/35), [#36](https://github.com/blendsdk/openvault/issues/36), [#37](https://github.com/blendsdk/openvault/issues/37)
> **Preflight**: [00-preflight-report.md](00-preflight-report.md)
> **Execution**: [99-execution-plan.md](99-execution-plan.md)
> **CodeOps Artifact Schema**: 1

## Overview

Three small UI issues affect the same surface, the application shell and its typography:

| Issue | Request | Product interpretation |
|---|---|---|
| #34 | “Replace the menu with `@blendsdk/fluentui-react-components` AppLauncher” | Replace the mobile-only navigation `Menu` with the BlendSDK `AppLauncher`. The launcher becomes the global navigation control at every viewport width. The account menu stays an account menu. |
| #35 | “Design a proper logo and favicon for OpenVault” | Add a vault-dial mark as SVG, use it in the shell and login page, and serve it as the browser favicon and touch icon. |
| #36 | “Headers, title, and descriptions are too cramped vertically” | Give page headers, project headers, and description text a consistent vertical rhythm with measurable gaps instead of zero-margin stacking. |
| #37 | “We need a link on the top bar to open a new tab to the docs, preferably to the page of section with the correct context.” | Add a top-bar **Docs** link that opens the published guide in a new tab and maps the current screen to its guide section. |

## Scope

### In scope

- `AppLauncher`, `AppLauncherSearch`, `AppLauncherSection`, `AppLauncherGrid`, `AppLauncherList`, and `AppLauncherItem` from `@blendsdk/fluentui-react-components` 0.6.0.
- Global navigation entries for Projects and, inside a project, every project section.
- Search filtering, empty search state, controlled open state, and close-on-navigate.
- A single SVG brand mark used by the shell, login page, favicon, and touch icon.
- A top-bar **Docs** link that opens the matching guide in a new tab.
- CSS spacing for page headers, project headers, page descriptions, and auth cards.
- Component tests and an axe check for the shell.

### Out of scope

- Server, API contract, database, deployment, or authentication changes.
- A new navigation destination or permission surface.
- A custom icon library, theme system, or second component library.
- Changing the account menu, theme toggle, or sidebar behavior.

## Design decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | Keep the desktop sidebar and add the launcher at all widths. | The issue replaces the menu, not the sidebar. The launcher also gives one consistent control on narrow screens. |
| D2 | Derive the current project from the URL in the shell. | `AppShell` renders above `ProjectRoute`, so `useProject` is unavailable. A regex on the path avoids a second project fetch. |
| D3 | Use buttons and `useNavigate` for launcher items. | `AppLauncherItem` renders a button, not an anchor. Navigation must close the panel and reset the query. |
| D4 | Use one vault-dial mark for logo and favicon. | A single source keeps the identity consistent and avoids a bespoke illustration that disappears at 16 px. |
| D5 | Express spacing with flex `gap`, not margins. | The existing zero margins collide; gaps survive wrapping and responsive changes. |
| D6 | Use the published absolute docs base, not a relative URL. | The docs are a separate GitHub Pages deployment; a relative link would resolve against the vault host, which does not serve them. |
| D7 | Map the route to a guide section, with the docs home for unknown routes. | The issue asks for the page of the current section, but guessing for an unknown route would be worse than the documentation home. |
| D8 | Open the link with `noopener noreferrer`. | A new tab must not receive a window handle or referrer back to the vault. |

## Minimum-sufficient baseline

The smallest change is one shell component, one small brand component, one SVG, one PNG touch
icon, one CSS block, and tests. No new dependency is needed because the component package is
already installed and used.

## Key invariants

- The app never stores secret values or session tokens in browser storage, URLs, or logs.
- The launcher is keyboard operable and every item has a visible text label.
- The account menu and theme toggle keep their current behavior.
- The production CSP stays unchanged; a same-origin image is already allowed.
- The favicon and logo ship in the existing `apps/web/dist` build.

# Preflight Report: UI polish issues #34, #35, #36

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Status**: ✅ PREFLIGHT PASSED — no open critical or major planning finding
> **Last Updated**: 2026-11-06 12:55

## Method

The audit checked the installed component package, the real shell and route structure, the
current stylesheet, the production asset pipeline, and the running review stack. Every finding
was reproduced before planning a change.

## Findings

| ID | Severity | Finding | Evidence | Resolution |
|---|---|---|---|---|
| PF-01 | Info | `AppLauncher` and its companion components exist in the installed package; no dependency upgrade is needed. | `node_modules/.pnpm/@blendsdk+fluentui-react-components@0.6.0.../dist/index.d.ts:11-24` exports `AppLauncher`, `AppLauncherGrid`, `AppLauncherItem`, `AppLauncherList`, `AppLauncherSearch`, `AppLauncherSection`, and `AppLauncherTrigger`. | Use the installed 0.6.0 API. |
| PF-02 | Major | The navigation menu is mobile-only, but the issue names the component, not a viewport. Showing the launcher only below 1023 px would leave desktop users with no replacement. | `apps/web/src/layout/app-shell.tsx:55-71` wraps the trigger in `mobile-only`; `.mobile-only` is `display: none` above 1023 px (`styles.css:634-642`). | Render the launcher at every width and keep the sidebar as a secondary shortcut. |
| PF-03 | Major | The shell cannot read the project context. | `AppShell` is rendered by `App.tsx` above `ProjectRoute`; `useProject()` throws outside the provider (`project-route.tsx:28-34`). | Parse `/projects/:project` from `useLocation().pathname` with a guarded `decodeURIComponent`. |
| PF-04 | Major | The launcher item is a button, while existing navigation is a link. Tests and assistive technology see different roles. | `AppLauncherItem.types.d.ts`: props extend `ComponentPropsWithoutRef<'button'>`; the item renders a button. | Test the launcher by button role; keep the sidebar link test unchanged. |
| PF-05 | Major | The brand is text (`OV`), not an image, and the document has no favicon link. | `app-shell.tsx:74-79` and `login-page.tsx:66-71`; `apps/web/index.html` has no `<link rel="icon">`. | Add one SVG mark, one touch icon, a BrandMark component, and the document links. |
| PF-06 | Info | A same-origin SVG is allowed by the production CSP. | `deploy/docker/web-nginx.conf:9`: `img-src 'self' data:`. | Serve the logo from `public/`; no CSP change. |
| PF-07 | Major | Page titles and descriptions have zero vertical separation. | Live metrics: `Projects` title `top:80 bottom:113.6`, description `top:113.6`; `Secrets` title `top:187 bottom:220.6`, description `top:220.6`. | Add a flex column gap to `.page-header-text` and a description line-height. |
| PF-08 | Major | The project name and its metadata touch. | Live metrics: project name `top:106 bottom:126`, metadata `top:126`; `.project-context-row p` sets `margin: 0` with no parent gap (`styles.css:198-206`). | Add a `.project-context-details` flex column with a gap. |
| PF-09 | Major | The project section tabs and the page header have no controlled separation. | `project-route.tsx` returns the header, the nav, and `<Outlet />` as bare siblings; the app adds no gap between them. | Wrap the three regions in `.project-shell` with a flex gap. |
| PF-10 | Minor | Auth-card paragraphs keep user-agent margins inside a flex gap, producing uneven rhythm. | `login-page.tsx:76` uses a bare `<p className="muted">`; `.login-card` is a flex column with `gap: 16px` but no paragraph reset. | Reset direct paragraphs in `.login-card` and the empty state. |
| PF-11 | Minor | The launcher surface is portaled. A test cannot query it before clicking the trigger. | `renderAppLauncher.js` renders `PopoverSurface`; Fluent portals the surface to the document body. | Open the launcher first, then query the search box and items. |
| PF-12 | Minor | The account menu is a separate control with account-specific actions. | `app-shell.tsx:94-117` contains the avatar, email, and sign-out menu. | Keep it; replace only the navigation menu. |
| PF-13 | Minor | The built-in trigger's `label` is both the accessible name and the tooltip. | `AppLauncherTrigger.types.d.ts` `label` documentation. | Pass `label="Open navigation"` so the replacement keeps the old control's purpose. |
| PF-14 | Minor | A controlled launcher can stay open across a route change and keep a stale query. | `AppLauncher` supports controlled `open` and `onOpenChange`; no internal route awareness. | Close and clear the query on navigation. |
| PF-15 | Minor | The mark must remain recognizable at 16 px. | Favicons render at 16×16 and 32×32. | Use a high-contrast rounded tile, one ring, and one keyhole; avoid fine detail and text. |
| PF-16 | Info | The running review stack serves built images, not the Vite dev server. | `review.sh` builds `openvault-web:review` and the proxy serves it at `https://localhost:8443`; no OpenVault Vite process is running. | Rebuild the web image, recreate the `web` container, and capture the running app for preview. |
| PF-17 | Info | The favicon and logo need no Dockerfile change. | `deploy/docker/web.Dockerfile` copies `apps/web/dist`; Vite copies `public/` into `dist/`. | Keep the asset pipeline unchanged. |
| PF-18 | Major | The documentation is a separate GitHub Pages deployment, not a path on the vault host. | `docs/.vitepress/config.ts` sets `base: "/openvault/"` and `sitemap.hostname: "https://blendsdk.github.io/openvault/"`. | Use the absolute `https://blendsdk.github.io/openvault` base for the link. |
| PF-19 | Major | The shell has no screen-to-guide mapping. | The app routes are in `apps/web/src/App.tsx`; the docs guide pages are listed in `docs/.vitepress/config.ts`. | Add `docsPathForRoute` with one case per project section and exact anchors from the guide headings. |
| PF-20 | Minor | A new-tab link without `noopener` gives the docs page a `window.opener` handle. | Standard browser behavior for `target="_blank"`. | Render the Fluent button as an anchor with `target="_blank"` and `rel="noopener noreferrer"`. |
| PF-21 | Minor | The docs label must stay readable on narrow top bars. | The current top bar already hides the theme label and account name below 1023 px; the docs button sits in the same row. | Render the book icon at every width and hide only the visible "Docs" text on narrow layouts; keep `aria-label="Docs"` on the anchor. |

## Resolutions before implementation

- Keep the account menu; remove only the navigation `Menu`.
- Use a shared `BrandMark` component so the shell and login page cannot drift.
- Use one SVG for both the in-app mark and the favicon; generate a 180×180 PNG for iOS.
- Replace margins around the page header, project details, and auth copy with flex gaps.
- Map each UI section to its guide page and anchor; fall back to the docs home for unknown routes.
- Open the docs link in a new tab with `noopener noreferrer`; keep the visible label accessible when
  the text is hidden on narrow layouts.
- Do not change API, server, CSP, or Compose contracts.

## Verification plan

| Gate | Command | Expected |
|---|---|---|
| Web typecheck | `pnpm --filter @openvault/web typecheck` | No errors |
| Web tests | `pnpm --filter @openvault/web test` | Every suite passes |
| Full verify | `pnpm verify` | All gates pass |
| Visual | Rebuild `openvault-web:review`, capture computed metrics and screenshots | Gaps are greater than zero; launcher and logo render |
| Docs link | Component test and live CDP check | The href matches the current section, opens a new tab, and closes nothing |
| Accessibility | axe on the shell and existing pages | No serious or critical violations |

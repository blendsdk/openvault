# Execution Plan: UI polish issues #34, #35, #36

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Status**: Done
> **Last Updated**: 2026-11-06 13:24
> **Progress**: 20/20 tasks (100%)
>
> **Rule:** one task at a time. Mark `[x]` only after the task verifies.

**Total: 20 tasks across 4 phases**

---

## Phase 1: Brand and navigation shell

> **Reasoning**: medium — the shell is the common surface for every page, but the changes are
> presentational and route-local.

### Step 1.1: Brand assets

- [x] 1.1.1 Add the vault-dial SVG mark and favicon in `apps/web/public/`
- [x] 1.1.2 Generate the 180×180 touch icon and link the mark, favicon, and theme color in `index.html`
- [x] 1.1.3 Add a shared `BrandMark` component and use it in the app shell and login page

**Verify**: `pnpm --filter @openvault/web build` copies the assets into `dist/`

### Step 1.2: AppLauncher navigation

- [x] 1.2.1 Replace the mobile navigation `Menu` with `AppLauncher`, `AppLauncherSearch`, sections, grid, and list
- [x] 1.2.2 Derive Projects and project-section entries from the current path; close and reset on navigate
- [x] 1.2.3 Keep the account menu, theme toggle, skip link, and sidebar behavior unchanged

**Verify**: `pnpm --filter @openvault/web typecheck`

### Step 1.3: Component tests

- [x] 1.3.1 Cover the launcher trigger, project entries, search filtering, and navigation
- [x] 1.3.2 Cover the brand home link and keep the existing shell assertions
- [x] 1.3.3 Add the shell to the axe accessibility suite

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 2: Vertical rhythm

> **Reasoning**: low — CSS-only, but it touches every page header.

### Step 2.1: Header rhythm

- [x] 2.1.1 Add a flex column gap to `.page-header-text`; reset description margins and line-height
- [x] 2.1.2 Add `.project-context-details` and `.project-shell` gaps for project headers and tabs
- [x] 2.1.3 Reset auth-card and empty-state paragraph margins; set heading line-height

**Verify**: computed metrics in the running app show a non-zero gap between title and description

### Step 2.2: Responsive check

- [x] 2.2.1 Check the shell and project pages at 1440 px and at 390/320 px; confirm the launcher, logo, and spacing

**Verify**: screenshots at both widths

---

## Phase 3: Verification and preview

- [x] 3.1 Run the full `pnpm verify` gate
- [x] 3.2 Rebuild `openvault-web:review`, recreate the `web` container, and capture the running app
- [x] 3.3 Record the preview URL, credentials, and evidence for the user

**Verify**: `pnpm verify` passes; the running review stack serves the new bundle

---

## Phase 4: Context-aware documentation link (#37)

> **Reasoning**: low — one pure resolver and one top-bar anchor, but the link must not
> mislead operators or leak a window handle to another origin.

### Step 4.1: Documentation resolver

- [x] 4.1.1 Add `docs.ts` with the absolute docs base and a route-to-guide mapping
- [x] 4.1.2 Add unit tests for every project section, the project list, trailing slashes, and unknown routes

**Verify**: `pnpm --filter @openvault/web test -- docs`

### Step 4.2: Top-bar link

- [x] 4.2.1 Add the book-icon Docs anchor to the app bar with `target="_blank"` and `rel="noopener noreferrer"`
- [x] 4.2.2 Keep the docs label accessible on narrow layouts; verify the link updates after navigation

**Verify**: shell layout tests and a live CDP check of the href and target

---

## Rollback

The change is limited to `apps/web` source, public assets, tests, and the changelog. Reverting the
commit restores the previous shell and styles; no data migration is involved.

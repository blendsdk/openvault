# Execution Plan: RD-12 Web UI

> **Document**: 99-execution-plan.md
> **Parent**: [Index](00-index.md)
> **Status**: Done
> **Last Updated**: 2026-11-06 15:00
> **Progress**: 44/44 tasks (100%)

> **Rule:** one task at a time. Mark `[x]` only after the task verifies, update the Progress
> header after every task, and record a finding in [05-findings.md](05-findings.md) when
> reality diverges from the plan.

**Total: 44 tasks across 4 phases**

---

## Phase 1: Server and Contract Groundwork

> **Reasoning**: high — auth compatibility, CSP, and generated artifacts affect every user.

### Step 1.1: Auth and session compatibility

- [x] 1.1.1 Add optional `sub` to `authUserSchema` and populate it on login and `/me`
- [x] 1.1.2 Add contract tests for the additive field and keep unknown-field rejection

**Verify**: `pnpm --filter @openvault/api-contract test && pnpm --filter @openvault/server test -- auth.sessions`

### Step 1.2: Browser contract generation

- [x] 1.2.1 Add `WEB_CONTRACT_CONTROLLERS` and `WEB_ROUTE_DOCS` for the browser auth, meta, project, secret, identity, assignment, access, and audit controllers
- [x] 1.2.2 Extend `api-contract.ts` with a web output target and include it in generate/check
- [x] 1.2.3 Add the generated directory to the Biome ignore list and regenerate both clients
- [x] 1.2.4 Add a contract test that every browser route is documented and the web client is drift-free

**Verify**: `pnpm api:check` prints `CLEAN`

### Step 1.3: Static serving and CSP

- [x] 1.3.1 Add a `webRoot` resolver and install hashed-asset/root SPA plugins only when the build exists
- [x] 1.3.2 Thread `webUiEnabled` into `installPreStack` and apply the UI CSP only when enabled
- [x] 1.3.3 Add integration tests for `/`, SPA fallback, API 404 JSON, and both CSP modes

**Verify**: `pnpm --filter @openvault/server test:integration -- static-web`

### Step 1.4: Web package dependencies

- [x] 1.4.1 Add `@openvault/api-contract` and `axe-core`; keep one React instance
- [x] 1.4.2 Fix the Vite dev proxy for HTTPS and origin rewrite; add vendor chunk splitting

**Verify**: `pnpm --filter @openvault/web typecheck`

---

## Phase 2: UI Foundation

> **Reasoning**: high — auth, CSRF, and secret lifetime are security boundaries.

### Step 2.1: Providers and client

- [x] 2.1.1 Add `CsrfCookieAuth` and the session mirror
- [x] 2.1.2 Add `SessionApiProvider` that creates the generated web client
- [x] 2.1.3 Add theme provider with light/dark and the non-sensitive preference
- [x] 2.1.4 Wire Fluent/GlobalLoader/I18n/Auth/Confirm/SystemError providers in `main.tsx`

**Verify**: `pnpm --filter @openvault/web test -- providers`

### Step 2.2: Routing and layout

- [x] 2.2.1 Add `AppRoutes`, `AuthGuard`, login redirect, not-found route
- [x] 2.2.2 Add responsive `AppShell` with sidebar, mobile menu, skip link, account menu
- [x] 2.2.3 Add `PageHeader`, `AsyncPanel`, `DataTable`, `StatusBadge`, `CopyButton`, `EmptyState`
- [x] 2.2.4 Add `useAsync` with abort-on-unmount and reload semantics
- [x] 2.2.5 Add `ProjectProvider` that resolves the route name to `{id,name}` and reloads

**Verify**: `pnpm --filter @openvault/web test -- layout`

### Step 2.3: Login and password change

- [x] 2.3.1 Login page with local form, generic error, OIDC button gating
- [x] 2.3.2 Forced password-change page
- [x] 2.3.3 Logout and returnTo handling

**Verify**: `pnpm --filter @openvault/web test -- login`

---

## Phase 3: Screens

> **Reasoning**: high — reveal lifetime, capability gating, and CSRF behavior.

### Step 3.1: Projects

- [x] 3.1.1 Project list with create/rename/delete and empty/error states
- [x] 3.1.2 Project layout and overview summaries
- [x] 3.1.3 Project provider error/not-found behavior

**Verify**: `pnpm --filter @openvault/web test -- projects`

### Step 3.2: Secrets

- [x] 3.2.1 Secret list with search, tags, cursor, loading/empty/error
- [x] 3.2.2 Secret create dialog
- [x] 3.2.3 Secret detail metadata/versions/consumers
- [x] 3.2.4 Reveal with 60 s/blur/route clear, copy clear, capability gating
- [x] 3.2.5 New version, delete, recover, purge actions

**Verify**: `pnpm --filter @openvault/web test -- secrets`

### Step 3.3: Identities and consumers

- [x] 3.3.1 Identity list/create/revoke
- [x] 3.3.2 Join-token dialog with one-time display and warning
- [x] 3.3.3 Consumers view from identity detail; no host paths

**Verify**: `pnpm --filter @openvault/web test -- identities consumers`

### Step 3.4: Permissions

- [x] 3.4.1 Access explanation target/action controls and table
- [x] 3.4.2 Assignment list/editor with local validation and server error display
- [x] 3.4.3 Revoke assignment

**Verify**: `pnpm --filter @openvault/web test -- permissions`

### Step 3.5: Audit

- [x] 3.5.1 Audit filters and cursor pagination
- [x] 3.5.2 Verify card and event details
- [x] 3.5.3 Loading/empty/error/403 states

**Verify**: `pnpm --filter @openvault/web test -- audit`

### Step 3.6: Styling and accessibility polish

- [x] 3.6.1 Tokens-based responsive CSS, dark theme, focus visibility, reduced motion
- [x] 3.6.2 Table captions, labels, error announcements, status text+icon
- [x] 3.6.3 Axe tests for login, secret detail, and audit
- [x] 3.6.4 Storage/URL/console secret-leak tests

**Verify**: `pnpm --filter @openvault/web test`

---

## Phase 4: Verification and Delivery

> **Reasoning**: high — release gate.

- [x] 4.1.1 Update CLI/configuration/architecture/security/changelog docs and changeset
- [x] 4.2.1 Run `pnpm verify`, `pnpm api:check`, `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, docs build
- [x] 4.3.1 Run PostgreSQL 16 and 17 integration suites
- [x] 4.4.1 Independent correctness and security/accessibility review; resolve blocking findings
- [x] 4.4.2 Update the plan, findings ledger, and roadmap to Done
- [x] 4.4.3 Commit, open a PR, wait for CI, squash-merge, delete the branch, clean temporary artifacts

**Verify**: full release gate

---

## Execution Notes

- **Browser contract.** The web client is generated from the actual
  `AuthController`, `MetaController`, `ProjectsController`, `SecretsController`,
  `IdentityController`, `AssignmentsController`, `AccessExplainController`, and
  `AuditController`. `pnpm api:check` checks both the CLI and web clients.
- **Session composition.** The BlendSDK provider owns the session check and login redirect.
  The app owns a small session bridge, a CSRF strategy, the refresh schedule (because the
  server contract uses ISO timestamps), and a 403 `csrf_invalid` recovery path that re-reads
  `/me` before one retry.
- **Local login.** A successful local login reloads the document once so the SDK can read the
  cookie through `/me`. Password change follows the same pattern.
- **Static serving.** The admin listener allows GET paths outside `/v1`; the agent listener
  keeps its strict table. A terminal `/v1` JSON 404 plugin prevents the SPA fallback from
  returning index.html to API clients.
- **Reveal.** The value is a read-only textarea that receives focus; a native capture blur
  listener clears on click-away. The clipboard timer is independent of reveal lifetime.
- **Residuals.** Deleted-secret recovery after reload, project recovery, clipboard guarantees,
  consumers derivation, certificate screens, and jsdom-only axe are documented in
  [05-findings.md](05-findings.md) and the security limitations.
- **Verification evidence.** `pnpm verify`, `pnpm api:check`, `pnpm lint`, `pnpm docs:build`,
  31/31 web tests, and 696/696 integration tests on PostgreSQL 16 and 17.

---

## Dependencies

- Phase 2 needs Phase 1's generated client and auth `sub`.
- Phase 3 needs Phase 2's provider/layout primitives.
- Phase 4 needs every screen and both review passes.

## Verification commands

```bash
pnpm build
pnpm typecheck
pnpm api:check
pnpm lint
pnpm test
pnpm db:types:check
pnpm changeset status
pnpm audit:prod
pnpm docs:build
TEST_DATABASE_URL=... pnpm test:integration
```

# Preflight Report: RD-12 Web UI

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Status**: ✅ PREFLIGHT PASSED — no open critical or major planning finding
> **Last Updated**: 2026-11-06 15:00

## Method

The audit checked each RD-12 Must Have against the real repository: controllers, contracts,
auth middleware, CSP, static serving, the current web app, and the generated-client toolchain.
Every finding below cites the file or command that produced it. Planning-stage findings are
resolved in the design; execution findings go to [05-findings.md](05-findings.md).

## Findings

| ID | Severity | Finding | Evidence | Resolution |
|---|---|---|---|---|
| PF-01 | Critical | The BlendSDK `AuthProvider` rejects the server's `/v1/auth/me` user because it requires a non-empty `sub`; the server returns `id`, `name`, `email`, and `authMethod` only. | `blendsdk/dist/react/auth/auth-provider.js` `checkSession`; `packages/api-contract/src/auth.ts` `authUserSchema` | Added AR-21: an optional additive `sub` field populated with the principal id. The web auth provider then works as documented. |
| PF-02 | Critical | The current CSP is `default-src 'none'` with no script/style/connect allowance, so any SPA asset or API call would be blocked. | `apps/server/src/transport/pre-stack.ts` `helmet` block | Added AR-20: a UI-enabled CSP that allows only same-origin scripts, styles, fonts, images, and connections; API-only mode keeps the deny-by-default policy. |
| PF-03 | Major | There is no generated browser client. The only generated client is the CLI’s bearer client and it excludes local login, `/me`, refresh, and logout. | `apps/server/scripts/api-contract.ts` `CONTRACT_CONTROLLERS`; `apps/cli/src/generated` | Added AR-4 and a second generated target for `apps/web/src/generated`, covered by `api:check`. |
| PF-04 | Major | The Vite dev proxy targets `http://localhost:8443`, but the admin listener is HTTPS; mutation requests also fail the server origin guard because the browser Origin is the Vite origin. | `apps/web/vite.config.ts`; `apps/server/src/auth/csrf.ts` `originGuard` | Added AR-27: HTTPS target, `secure: false`, and a `proxyReq` hook that rewrites `Origin`/`Referer` to `OPENVAULT_BASE_URL`. |
| PF-05 | Major | There is no project-level consumers route. Only identity detail embeds consumer metadata. | `apps/server/src/controllers/identity.ts`; `packages/api-contract/src/identities.ts` | Added AR-11: derive the consumers view from identity detail; do not add a new route just for the minimum UI. |
| PF-06 | Major | There is no secret metadata route. The value route is the only per-secret read, and calling it would create an audit read on page load. | `apps/server/src/controllers/secrets.ts`; `packages/api-contract/src/secrets.ts` | Added AR-8: list with an exact-name query for metadata, and call the value route only on explicit reveal. |
| PF-07 | Major | CSRF tokens rotate on refresh, so a header captured once at login goes stale and later mutations receive 403. | `apps/server/src/auth/sessions.ts` rotation; SDK `performRefresh` updates the token | Added AR-5/6: the auth strategy reads the live in-memory token on every request. |
| PF-08 | Major | A forced password change blocks every route except `/v1/auth/me`, password, logout, and meta; a UI without that flow would dead-end. | `apps/server/src/auth/middleware.ts` `passwordChangeGate` | Added AR-22: a minimal forced-change screen using the existing password route. |
| PF-09 | Major | The current web test only asserts that the product name renders; there is no screen, accessibility, or security coverage. | `apps/web/tests/App.test.tsx` | The testing strategy replaces it with behavior, security, and axe suites. |
| PF-10 | Major | The server’s static plugin root must exist at install time; a missing `apps/web/dist` would make the API fail to start. | `blendsdk/dist/webafx/application/static-files-plugin.js` factory | Added AR-19: install the plugin only when the build directory exists. |
| PF-11 | Minor | Project routes use names, but identity/assignment routes use ULIDs; a page must resolve the project id, not pass the name. | `apps/server/src/controllers/identity.ts` `identityListQuerySchema.projectId`; `apps/server/src/controllers/secrets.ts` project name | The project provider exposes `{id,name}` and pages use `project.id` where the contract requires a ULID. |
| PF-12 | Minor | The audit action select cannot come from the role catalog; audit actions and RBAC actions are separate sets. | `packages/api-contract/src/audit.ts` `AUDIT_ACTIONS`; `rbac.ts` `RBAC_ACTIONS` | Use `AUDIT_ACTIONS` directly (AR-14). |
| PF-13 | Minor | A single 460 kB bundle is already the current build output; Fluent UI and BlendSDK should be split. | `apps/web/dist/assets/index-CR_ZOPp6.js` | Added AR-28: manual vendor chunks. |
| PF-14 | Minor | The existing `App` imports `Card` and `Button` but not the custom component package’s richer primitives; the new screens must actually use the package, not only the Fluent primitives. | `apps/web/src/App.tsx` | The screen design uses `ConfirmProvider`, `DescriptionList`, `CollapsibleSection`, `FormTextField`, and `Loading` from the custom package. |
| PF-15 | Minor | The server `AuthController` includes session list/revoke and password routes; a browser contract must document all of them or the generator fails. | `apps/server/src/controllers/auth.ts` `routes()` | The web route table documents every browser auth route, including sessions and password. |

## Post-Execution Update

The independent reviews found four blocking issues that planning had not fully resolved: the
forced-change gate blocked the SPA assets, the client refreshed with a mismatched timestamp
unit, the SPA fallback could shadow API 404s, and the assignment list hid object-scope grants.
All were fixed and re-verified. See [05-findings.md](05-findings.md).

## Verification Plan

| Gate | Command | Expected |
|---|---|---|
| Build | `pnpm build` | All packages, including the SPA, compile. |
| Typecheck | `pnpm typecheck` | No type errors. |
| Contract drift | `pnpm api:check` | `CLEAN`, including the web client. |
| Lint/format | `pnpm lint` | No errors. |
| Unit/component | `pnpm test` | Existing suites plus the new web suites pass. |
| Accessibility | included in `pnpm test` | Axe reports no serious/critical on login, secret detail, audit. |
| Integration | `TEST_DATABASE_URL=... pnpm test:integration` | PostgreSQL 16 and 17 suites pass. |
| Docs | `pnpm docs:build` | Reference and guide pages build. |
| Production artifacts | `pnpm verify` | Full sequence passes. |

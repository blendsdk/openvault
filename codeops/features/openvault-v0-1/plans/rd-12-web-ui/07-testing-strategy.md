# Testing Strategy: RD-12 Web UI

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Unit and component tests

| # | Input / Scenario | Expected output | Source |
|---|---|---|---|
| ST-1 | Render login with `meta.auth.oidc=false` | Local form present; no SSO button | RD-12 acceptance 1 |
| ST-2 | Render login with `meta.auth.oidc=true` | SSO button present; click calls `login` | Acceptance 1 |
| ST-3 | Submit local login 401 | Generic alert; no identifier/password in the message; button re-enabled | Security |
| ST-4 | Submit local login success | `refresh()` called; navigate to returnTo or `/` | Acceptance 1 |
| ST-5 | Logout | POST logout, then `/login` | Acceptance 1 |
| ST-6 | Project list empty | Empty guidance contains `ov project create` | Should Have |
| ST-7 | Create/rename/delete project | Generated client called; list reloads; delete asks confirmation | Acceptance 2 |
| ST-8 | Project name not found | Not-found panel; no secret request | AR-30 |
| ST-9 | Secret list search/tag/cursor | Query parameters correct; "Load more" appends; no value shown | Acceptance 4 |
| ST-10 | Secret list loading/empty/error | `aria-busy`, guidance, retry | Acceptance 4 |
| ST-11 | Secret detail masked | No value request on mount; masked text; reveal button only with `canRead` | Acceptance 2, 5 |
| ST-12 | Reveal with `canRead` | One value request, value shown, countdown, audit is server-side | Acceptance 3 |
| ST-13 | Reveal without `canRead` | No reveal button; direct `getSecret` is never called | Acceptance 3 |
| ST-14 | Blur clears reveal | Value gone after blur | Acceptance 5 |
| ST-15 | 60-second timeout clears reveal | Fake timers advance 60 s; value gone | Acceptance 5 |
| ST-16 | Route change clears reveal | Navigate away; returned value is gone | Acceptance 5 |
| ST-17 | Storage scan | No secret value in local/session storage, URL, or console | Acceptance 4 |
| ST-18 | Permissions explanation | Target/action query matches; table rows match response | Acceptance 6 |
| ST-19 | Assignment invalid shape | Client blocks object scope without object and org scope without `org` | AR-13 |
| ST-20 | Assignment server escalation | Error code/message shown in `role="alert"` | Acceptance 7 |
| ST-21 | Audit filters | From/to converted to ISO; actor/action/result/request id sent | Acceptance 7 |
| ST-22 | Audit verify | Ok/reason/first broken rendered | Acceptance 7 |
| ST-23 | Consumers from identity details | Compose project/service/last seen shown; hostname/path absent | Acceptance 9 |
| ST-24 | CSRF strategy | Unsafe requests get `x-csrf-token`; GET does not | Acceptance 8 |
| ST-25 | CSRF refresh | 401 triggers one refresh and one retry; second 401 surfaces | Acceptance 8 |
| ST-26 | Forced password change | Gate redirects; success refreshes and returns | AR-22 |
| ST-27 | Keyboard-only login/reveal/logout | Focus order reaches controls; Enter/Space activate | Acceptance 10 |
| ST-28 | Axe login | No serious/critical | Acceptance 9 |
| ST-29 | Axe secret detail | No serious/critical | Acceptance 9 |
| ST-30 | Axe audit | No serious/critical | Acceptance 9 |
| ST-31 | 768 px layout styles | Sidebar collapses; no fixed-width overflow class | Acceptance 11 |
| ST-32 | Theme toggle | Dark theme applied; only `openvault.theme` stored | Should Have |

## Server tests

| # | Scenario | Expected | Source |
|---|---|---|---|
| ST-33 | Static serving with a build directory | `/` returns `index.html`; `/assets/<file>` returns the asset | Must Have |
| ST-34 | SPA fallback | `GET /projects/x` with `Accept: text/html` returns `index.html` | Must Have |
| ST-35 | API 404 | `GET /v1/nope` with `Accept: application/json` returns JSON 404, not HTML | Must Have |
| ST-36 | CSP with UI enabled | `default-src 'self'`, `script-src 'self'`, no `unsafe-eval` | Security |
| ST-37 | CSP with UI disabled | `default-src 'none'` | Regression |
| ST-38 | `/v1/auth/me` includes `sub` | `sub === id`; existing fields unchanged | AR-21 |
| ST-39 | Contract drift | Generated web client and OpenAPI are current | Verification |
| ST-40 | Browser client route coverage | Every browser controller route is documented | Contract |

## Integration tests

| # | Scenario | Expected |
|---|---|---|
| ST-41 | Local login through the real HTTPS server | Session cookie set; `me` returns user+csrf+sub |
| ST-42 | Mutation without CSRF | 403 `csrf_invalid` |
| ST-43 | Mutation with CSRF | Success |
| ST-44 | Reveal with `secret.read` | Value returned; `secret.read` audit event exists |
| ST-45 | Reveal without `secret.read` | 403; no value |
| ST-46 | Static asset and SPA fallback | Served by the real app |

## Accessibility

- `axe-core` runs in jsdom against the login, secret detail, and audit pages with representative
  data.
- Rule failures at `serious` or `critical` fail the test; moderate/minor findings are printed
  for review.
- The tests also assert: each input has an accessible name, each page has one `<h1>`, tables
  have captions, and errors are in `role="alert"`.

## Actual Test Files

| File | Coverage |
|---|---|
| `apps/web/tests/login.test.tsx` | Local form, generic error, OIDC gating, reload |
| `apps/web/tests/projects.test.tsx` | List, create, validation, rename, confirmed delete |
| `apps/web/tests/secrets-list.test.tsx` | Search, empty guidance, create payload, no value on list |
| `apps/web/tests/secret-detail.test.tsx` | Masked load, audited reveal request, blur, 60 s, capability gating, denial |
| `apps/web/tests/permissions.test.tsx` | Access explanation, assignment rows including object scope, validation, revoke |
| `apps/web/tests/audit.test.tsx` | Filters, verify ok/broken, details |
| `apps/web/tests/identities-consumers.test.tsx` | Join token, revoke, consumers without host paths |
| `apps/web/tests/layout.test.tsx` | Skip link, navigation, theme toggle and storage, account |
| `apps/web/tests/session.test.tsx` | CSRF strategy and refresh |
| `apps/web/tests/session-expiry.test.tsx` | Expired-session logout path |
| `apps/web/tests/accessibility.test.tsx` | Axe on login, secret detail, audit |
| `apps/server/tests/integration/web-ui.spec.test.ts` | SPA, assets, API 404 with HTML Accept, both CSP modes |
| `apps/server/tests/api-contract.spec.test.ts` | Browser route coverage and web client drift |
| `apps/server/tests/auth/middleware.impl.test.ts` | Forced-change gate allows UI assets |
| `apps/server/tests/integration/auth.sessions.test.ts` | `sub` alias and session response |

The final counts are 31 web tests, 243 server unit tests, and 696 integration tests on each of
PostgreSQL 16 and 17.

## Verification commands

```bash
pnpm build
pnpm typecheck
pnpm api:check
pnpm lint
pnpm test
pnpm docs:build
TEST_DATABASE_URL=... pnpm test:integration
```

The final gate is `pnpm verify` plus PostgreSQL 16 and 17 integration.

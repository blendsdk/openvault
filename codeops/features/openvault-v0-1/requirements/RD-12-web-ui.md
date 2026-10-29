# RD-12: Web UI

> **Document**: RD-12-web-ui.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-03, RD-06, RD-08, RD-10
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the minimal v0.1 web UI: local and OIDC login, projects, secrets with
masked reveal, consumers, permissions, and audit search. The UI uses React 19, Fluent UI v9,
`@blendsdk/fluentui-react-components`, and `blendsdk/react`. It is served by WebAFX behind
the proxy, uses the BFF session, and never stores secret values.

## Functional Requirements

### Must Have

- [ ] Login page with local form and SSO button; SSO hidden when `/v1/meta/auth` reports OIDC
  disabled.
- [ ] Logout clears the session and returns to the login page.
- [ ] Projects list with create, rename, and delete.
- [ ] Project detail with secrets, identities, assignments, and audit summary.
- [ ] Secret list with search, tags, pagination, loading, empty, and error states.
- [ ] Secret detail with metadata, version history, masked value, audited reveal, consumers,
  and capability-based actions.
- [ ] Reveal requires `canRead`, triggers a server read, creates an audit event, and clears on
  blur, route change, or 60 seconds.
- [ ] Permissions view matches `ov access explain` and `GET /v1/admin/access-explain`.
- [ ] Assignment editor blocks invalid grants and shows escalation errors.
- [ ] Audit search with time, actor, action, object, result, and request id filters; verify
  status.
- [ ] Consumers view lists Compose project/service and last seen; no host paths.
- [ ] All screens use Fluent UI v9 and `@blendsdk/fluentui-react-components`; no second design
  system.
- [ ] No secret value in `localStorage`, `sessionStorage`, IndexedDB, cookies written by
  JavaScript, or the URL.
- [ ] CSRF token from `/v1/auth/me` is sent on every unsafe request.
- [ ] WCAG 2.1 AA: keyboard navigation, focus visibility, labels, error announcements,
  contrast.
- [ ] Responsive at 1280 px and 768 px.
- [ ] Production build served by WebAFX `staticFilesPlugin` with SPA fallback.

### Should Have

- [ ] Dark mode via Fluent UI theme.
- [ ] Copy-to-clipboard with a 30-second clear where the browser permits.
- [ ] Empty-state guidance with the relevant CLI command.

### Won't Have (Out of Scope)

- Certificate screens (v0.2).
- Rotation wizard, settings, or KEK UI.
- User self-registration or password reset.
- Secret editing with rich text or file upload.
- Additional UI locales in v0.1; the i18n provider is present but only English ships.

## Technical Requirements

### Stack

| Concern | Choice |
|---|---|
| Build | Vite 8 |
| Framework | React 19, TypeScript 7 |
| Components | Fluent UI v9 + `@blendsdk/fluentui-react-components` 0.6.0 |
| Auth, loader, i18n | `blendsdk/react` |
| Routing | React Router 7 |
| Forms | React Hook Form + field wrappers |
| HTTP | Generated `blendsdk/api-client` with `CookieSessionAuth` |

### Providers

```tsx
<FluentProvider theme={webLightTheme}>
  <GlobalLoaderProvider>
    <I18nProvider loader={loadTranslations} defaultLocale="en">
      <AuthProvider config={{ basePath: "/v1/auth" }}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  </GlobalLoaderProvider>
</FluentProvider>
```

### Pages

| Route | Purpose |
|---|---|
| `/login` | Local form, SSO, errors |
| `/` | Project list |
| `/projects/:project` | Project summary |
| `/projects/:project/secrets` | Secret list |
| `/projects/:project/secrets/:name` | Secret detail |
| `/projects/:project/identities` | Service identities |
| `/projects/:project/permissions` | Access explain and assignments |
| `/projects/:project/audit` | Audit search |
| `/projects/:project/consumers` | Consumer list |

### Secret reveal

- Mask by default.
- Reveal is a server read with `secret.read`; the server audits before returning.
- Value lives in component state only; clear on blur, route change, or 60 seconds.
- Never write values to browser storage, URLs, or analytics.

### Accessibility

- Every input has a label and error association.
- Tables have captions and `aria-sort`.
- Status uses text and icons, not color alone.
- Axe checks in Vitest/jsdom and Playwright; no serious findings.

## Integration Points

- RD-03 supplies auth and CSRF.
- RD-06 supplies actions and capabilities.
- RD-08 supplies secret data and consumers.
- RD-10 supplies consumer metadata.
- RD-14 runs UI security and accessibility tests.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| UI scope | Minimal / full / none | Minimal | Value without delaying backend | AR-24 |
| Component system | Fluent UI + custom / other | Fluent UI + `@blendsdk/fluentui-react-components` | User requirement and consistency | AR-24 |
| Authorization | Client math / server flags | Server capability flags | Client is not the authority | AR-24 |
| Reveal | Inline / modal / new page | Inline with timeout | Lower exposure | AR-24 |
| Certificates | UI / CLI only | CLI only in v0.1 | Scope control | AR-25 |

## Security Considerations

- **Data sensitivity:** secret values, private metadata, audit events.
- **Input validation:** forms validate client-side for UX; the server remains authoritative.
- **Authentication & authorization:** BFF session; capability flags; no client-side policy.
- **Injection risks:** React escapes by default; no `dangerouslySetInnerHTML`; CSP.
- **Encryption needs:** TLS; HttpOnly cookie; no tokens in JS.
- **Rate limiting:** server-side; UI backs off on 429.
- **Infrastructure:** static assets hashed, CSP, no source maps, no secrets in build output.

## Acceptance Criteria

1. [ ] Local login and OIDC login both reach the project list; SSO is hidden when OIDC is
   disabled.
2. [ ] A secret list shows no value; opening a secret shows a masked value.
3. [ ] Reveal for a principal with `canRead` shows the value and creates an audit event;
   without `canRead` the action is absent and a direct request returns 403.
4. [ ] The revealed value is not present in local/session storage, IndexedDB, the URL, or
   console logs.
5. [ ] The value clears on blur, route change, and after 60 seconds.
6. [ ] The permissions view matches `access-explain` output.
7. [ ] The audit view filters by actor, action, result, and time.
8. [ ] Every unsafe request sends `X-CSRF-Token`; a missing token receives 403.
9. [ ] Axe reports no serious or critical issues on login, secret detail, and audit pages.
10. [ ] Keyboard-only login, reveal, and logout work.
11. [ ] Core flows work at 1280 px and 768 px.
12. [ ] Security requirements verified: no value storage, CSP, CSRF, capability enforcement.

# UI Architecture: RD-12

> **Document**: 03-01-ui-architecture.md
> **Parent**: [Index](00-index.md)

## Provider tree

```tsx
<FluentProvider theme={theme}>
  <GlobalLoaderProvider>
    <I18nProvider loader={loadTranslations} defaultLocale="en">
      <AuthProvider config={{ basePath: "/v1/auth" }}>
        <SessionApiProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </SessionApiProvider>
      </AuthProvider>
    </I18nProvider>
  </GlobalLoaderProvider>
</FluentProvider>
```

`ConfirmProvider` and `SystemErrorProvider` from the custom component package sit inside
`FluentProvider` so destructive confirmations and unexpected failures share one accessible
dialog. `ThemeProvider` owns the light/dark choice and persists only the non-sensitive theme
key.

## Generated browser client

`apps/server/scripts/api-contract.ts` grows a second target:

| Artifact | Path |
|---|---|
| Browser client | `apps/web/src/generated/` |
| OpenAPI document | `packages/api-contract/openapi.json` (shared) |
| Drift gate | `pnpm api:check` checks CLI and web clients |

The browser controller set is the real `AuthController` (all browser session routes),
`MetaController`, `ProjectsController`, `SecretsController`, `IdentityController`,
`AssignmentsController`, `AccessExplainController`, and `AuditController`. OIDC redirect and
callback are browser navigations, not client calls, so `OidcController` stays out. Agent,
certificate, scaffold, and readiness routes stay out.

The generated `createOpenVaultWebClient` takes `ApiClientOptions`; the app supplies:

```ts
const client = createOpenVaultWebClient({
  baseUrl: "",
  auth: new CsrfCookieAuth(sessionRef),
  headers: { "User-Agent": "openvault-web/0.1.0" },
});
```

`baseUrl: ""` keeps requests same-origin. `FetchAdapter` is the default runtime adapter.

## CSRF and refresh strategy

```ts
class CsrfCookieAuth implements AuthStrategy {
  scheme = "cookie";
  async apply(request) {
    const headers = { ...request.headers };
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const token = this.#session.current()?.csrfToken;
      if (token) headers["x-csrf-token"] = token;
    }
    return { ...request, headers, credentials: "include" };
  }
  async refreshOnUnauthorized() {
    return await this.#session.refresh();
  }
}
```

The token is a reference into a small mutable session mirror updated from
`useAuth().csrfToken`. It is never written to storage. On refresh the SDK rotates the token;
the mirror updates before the retried request.

## Session and project state

| Provider | Responsibility |
|---|---|
| `ThemeProvider` | Light/dark theme, `localStorage` key `openvault.theme` only |
| `SessionApiProvider` | Creates the generated client, mirrors the CSRF token, exposes `refresh` to the auth strategy |
| `ProjectProvider` | Loads the project list, resolves `:project` by name, exposes `{id,name}` and `reload()` |
| `ProjectDataProvider` | Per-page loaders for secrets, identities, assignments, audit; no global cache |

No Redux, React Query, or SWR. Each page owns its request state with a small `useAsync` hook
that returns `{ data, error, loading, reload }` and aborts on unmount. Mutations call the
generated client and then `reload()` the affected loader.

## Routing

| Route | Element |
|---|---|
| `/login` | Login page; redirects to `/` when already authenticated |
| `/change-password` | Forced password change; only reachable while the gate is active |
| `/` | Project list (protected) |
| `/projects/:project` | Project layout + overview |
| `/projects/:project/secrets` | Secret list |
| `/projects/:project/secrets/:name` | Secret detail |
| `/projects/:project/identities` | Identities |
| `/projects/:project/permissions` | Access explanation and assignments |
| `/projects/:project/audit` | Audit search |
| `/projects/:project/consumers` | Consumer list |
| `*` | Not-found page |

`AuthGuard` protects the project routes. The project layout resolves the project name; a
missing name renders a not-found panel, not a redirect loop.

## Layout and responsive rules

- **≥ 1024 px:** 264 px sidebar (brand, project switcher, section nav, account) and a content
  column with a page header.
- **768–1023 px:** sidebar becomes a top app bar with a menu button that opens a Fluent
  `Drawer`/overlay nav; the content uses the full width.
- **≤ 767 px:** same app bar; tables scroll horizontally inside a labelled region; action
  buttons wrap; dialogs use the full viewport width minus 32 px.
- Focus is always visible (`:focus-visible` ring), skip link is the first tab stop, and the
  main region is `aria-labelledby` the page title.

## Tables and lists

- Use a semantic `<table>` with `<caption class="sr-only">`, `aria-rowcount`, `aria-busy` on
  the surrounding region, and `aria-sort` on sortable headers.
- Long values wrap or truncate with a title; identifiers use a monospace token.
- Empty states use the custom `DescriptionList` or a simple panel with a CLI hint and copy
  button.
- Loading uses `Loading`/`LoadingOverlay` from the custom package and `aria-busy`.
- Errors use `role="alert"` and show the server code plus message.

## Secret value lifecycle

1. Detail loads metadata via `listSecrets({ project, q: name })`; no value read.
2. Reveal is disabled unless `capabilities.canRead`.
3. Reveal calls `getSecret({ project, name })`; the server audits the read.
4. The value is kept in component state, shown in a focusable region with a countdown.
5. Clear on region blur, `window` blur, route change/unmount, logout, or 60 seconds.
6. Copy writes to the clipboard; after 30 seconds the app attempts to replace the clipboard
   with an empty string while the document is focused, and reports that clearing is
   best-effort.
7. No value is passed to `console`, URL state, storage, or a global context.

## Accessibility contract

| Concern | Implementation |
|---|---|
| Labels | Every input has a visible `label` via Fluent `Field`/`FormTextField` |
| Errors | Field error text associated with the input; page errors `role="alert"` |
| Keyboard | All actions are native buttons/links; dialogs trap focus through Fluent |
| Focus | Visible `:focus-visible` outline; skip link; route changes move focus to the page heading |
| Status | Text + icon, never color alone |
| Tables | Caption, header scope, `aria-sort`, horizontal scroll region has a tab stop |
| Contrast | Fluent themes meet AA; no custom low-contrast text |
| Reduced motion | No essential animation; respect `prefers-reduced-motion` for transitions |

## Security contract

- CSP allows same-origin scripts, same-origin connections, and inline styles only for Griffel.
- The session cookie is HttpOnly/Secure/SameSite=Lax and is never read by JavaScript.
- CSRF is sent on every unsafe request.
- No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`.
- No source maps in production.
- Server capability flags gate actions; each request is still authorized server-side.
- The login error is generic and never distinguishes unknown user, wrong password, or lockout.

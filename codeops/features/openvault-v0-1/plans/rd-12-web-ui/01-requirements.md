# Requirements: RD-12 Web UI

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-12](../../requirements/RD-12-web-ui.md) — the owning requirements document

## Scope of this plan (delta view)

### In this plan

- A generated browser client under `apps/web/src/generated`, produced from the real browser
  controllers and checked by `pnpm api:check`.
- Local login, OIDC login when enabled, logout, and a forced password-change screen.
- Projects list with create, rename, and delete; project overview with summaries.
- Secret list with search, tags, cursor pagination, loading, empty, and error states.
- Secret detail with metadata, version history, masked reveal, consumers, and
  capability-based actions.
- Identities list with create, revoke, and one-time join-token issuance.
- Permissions view with access explanation and an assignment editor.
- Audit search with time, actor, action, object, result, and request-id filters; explicit chain
  verification.
- Consumers view derived from identity consumer metadata, with no host paths.
- Fluent UI v9 and `@blendsdk/fluentui-react-components` only.
- Responsive layout at 1280 px and 768 px, dark mode, keyboard operation, visible focus, and
  error announcements.
- WebAFX static serving with SPA fallback, hashed-asset caching, and a UI-enabled CSP.
- Axe checks for login, secret detail, and audit in Vitest/jsdom.

### Deferred / out of this plan

- Certificate screens (v0.2).
- Rotation wizard, settings, or KEK UI.
- User self-registration or password reset.
- Secret editing with rich text or file upload.
- Additional UI locales; English only.
- Playwright browser automation and cross-browser matrix; RD-14 owns them.
- The remaining RD-13 operations.

## Acceptance criteria (delta)

1. A local login reaches the project list; an OIDC button appears only when
   `GET /v1/meta/auth` reports `oidc: true`; logout returns to `/login`.
2. The project list supports create, rename, and delete with an explicit confirmation.
3. The project overview links to secrets, identities, permissions, audit, and consumers and
   shows a summary from the existing list APIs.
4. The secret list shows no value and supports search, tag filters, loading, empty, error, and
   cursor pagination.
5. Secret detail shows metadata, versions, masked value, consumers, and actions gated by
   `capabilities`.
6. Reveal calls the server, creates an audit event, and clears on blur, route change, or after
   60 seconds.
7. The permissions view matches `GET /v1/admin/access-explain`; the assignment editor rejects
   invalid shapes and shows server escalation errors.
8. Audit filters by time, actor, action, object, result, and request id; verify shows the
   server’s ok/reason/first-broken-result.
9. Every unsafe request sends `X-CSRF-Token`; a missing or stale token produces a visible
   error and is never silently retried without a refresh.
10. No secret value appears in local storage, session storage, IndexedDB, JavaScript cookies,
    the URL, or console logs.
11. Axe reports no serious or critical issues on login, secret detail, and audit.
12. Keyboard-only login, reveal, and logout work; the layout remains usable at 1280 px and
    768 px.
13. `pnpm build`, `pnpm typecheck`, `pnpm api:check`, `pnpm test`, `pnpm docs:build`, and both
    PostgreSQL integration suites pass.

## Non-goals

- The browser is not an authorization authority. It never computes effective permissions.
- The browser never holds a bearer token or the CLI credential file.
- The browser never renders a private key or certificate value.
- No new product route is introduced solely for a screen; the only server changes are
  serving/contract/compatibility.

## Delivery Note

All acceptance criteria above were implemented and verified. The residual limits are recorded
in [05-findings.md](05-findings.md): deleted-secret recovery after reload is CLI-only, project
deletion has no browser recovery, clipboard clearing is best effort, consumers are derived from
identity detail, certificate screens are CLI-only, and axe runs in jsdom in this release.

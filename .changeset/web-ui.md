---
"@openvault/web": minor
"@openvault/server": minor
"@openvault/api-contract": minor
---

Add the v0.1 web UI and the browser API client.

The UI provides local and OIDC login, projects, secrets with an audited masked reveal that
clears on blur/navigation/60 seconds, identities with one-time join tokens, access explanation
and assignments, audit search with chain verification, consumers, dark mode, and responsive
navigation. Secret values never enter web storage, the URL, or logs.

`apps/server/scripts/api-contract.ts` now also generates a cookie-session browser client in
`apps/web/src/generated`, checked by `pnpm api:check`. The server serves the built SPA with the
WebAFX static plugins, hashed-asset caching, SPA fallback, and a UI-enabled same-origin CSP.
The admin listener allows GET paths outside `/v1` for the UI while the agent listener keeps its
strict path table.

The browser session response includes an additive `sub` alias so the BlendSDK auth provider can
adopt the session. Local login and password change boot a fresh document once, after which the
provider reads `/v1/auth/me`.

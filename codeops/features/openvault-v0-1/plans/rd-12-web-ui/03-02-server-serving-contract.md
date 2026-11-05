# Server Serving and Contract: RD-12

> **Document**: 03-02-server-serving-contract.md
> **Parent**: [Index](00-index.md)

## Browser contract generation

### Controllers

| Base path | Controller | Why |
|---|---|---|
| `/v1/auth` | `AuthController` | Local login, password change, `/me`, refresh, logout, sessions |
| `/v1/meta` | `MetaController` | Auth capability and role catalog |
| `/v1/admin/projects` | `ProjectsController` | Project CRUD |
| `/v1/data` | `SecretsController` | Secret list/value/versions/consumers/mutations |
| `/v1/admin/identities` | `IdentityController` | Identity list/create/revoke/join token |
| `/v1/admin/assignments` | `AssignmentsController` | Assignment list/create/delete |
| `/v1/admin/access-explain` | `AccessExplainController` | Access explanation |
| `/v1/audit` | `AuditController` | Event query and verification |

`OidcController` is a browser navigation surface (`GET /v1/auth/login`, `/callback`), not a
JSON client surface. Certificates, scaffold, agent, and readiness stay out of the web client.

### Route metadata

The existing `ROUTE_DOCS` table stays the source for CLI routes. A separate
`WEB_ROUTE_DOCS` table documents the browser-only auth routes and reuses the project, secret,
identity, assignment, access, audit, and meta entries. A compile-time check fails if a real
browser controller route lacks metadata or a metadata entry lacks a route.

### Generation and drift

`pnpm api:generate` writes:

| Artifact | Path |
|---|---|
| OpenAPI 3.1 document | `packages/api-contract/openapi.json` |
| CLI client | `apps/cli/src/generated/` |
| Web client | `apps/web/src/generated/` |

`pnpm api:check` renders the same artifacts in memory and fails on any document or client
difference. The web client is added to the Biome ignore list because the generator owns its
formatting.

## Auth response compatibility

`authUserSchema` gains an optional `sub` field. The server always populates it with the
principal id on local login, OIDC callback, and `/me`. The field exists so the BlendSDK
`AuthProvider` can treat the session as authenticated; it is additive and does not change any
authorization decision.

## Static serving

`createApplication` installs the web UI only when a build directory is available:

```ts
const webRoot = resolveWebRoot(); // apps/web/dist from source or dist
if (existsSync(join(webRoot, "index.html"))) {
  app.use(staticFilesPlugin({ root: join(webRoot, "assets"), prefix: "/assets",
    maxAge: "1y", immutable: true, index: false }));
  app.use(staticFilesPlugin({ root: webRoot, spa: true, maxAge: 0 }));
}
```

- Hashed assets live under `/assets` and are immutable for one year.
- `index.html` is not cached.
- The SPA fallback is installed in the terminal phase, after controllers, and only handles
  `GET` requests that accept `text/html` and have no file extension. API 404s stay JSON.
- The plugin is not installed when the directory is absent, so the API can run alone.

## CSP

`installPreStack` accepts a `webUiEnabled` flag. When true, the helmet directives become:

| Directive | Value |
|---|---|
| `default-src` | `'self'` |
| `script-src` | `'self'` |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data:` |
| `font-src` | `'self'` |
| `connect-src` | `'self'` |
| `object-src` | `'none'` |
| `base-uri` | `'none'` |
| `frame-ancestors` | `'none'` |
| `form-action` | `'self'` |

When false, the current `default-src 'none'` policy is unchanged. There is no
`unsafe-eval`.

## Development proxy

```ts
server: {
  port: 5173,
  proxy: {
    "/v1": {
      target: process.env.OPENVAULT_DEV_URL ?? "https://localhost:8443",
      secure: false,
      changeOrigin: true,
      configure(proxy) {
        proxy.on("proxyReq", (request) => {
          request.setHeader("origin", process.env.OPENVAULT_BASE_URL ?? "https://localhost");
          request.setHeader("referer", `${origin}/`);
        });
      },
    },
  },
}
```

The browser talks to the Vite origin; the server sees the configured production origin, so
the same-origin guard and secure cookie work as in production.

## Failure behavior

| Condition | Behavior |
|---|---|
| Web build absent | API starts normally; no static routes |
| Index missing but assets present | No UI install; API starts normally |
| Hashed asset missing | 404, not `index.html` |
| Unknown client route (accept HTML) | `index.html` |
| Unknown API route (accept JSON) | JSON 404 |
| CSP violation | Browser blocks the resource; server logs the request normally |

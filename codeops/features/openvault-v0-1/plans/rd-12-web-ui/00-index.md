# RD-12 Web UI Implementation Plan

> **Feature**: The minimal v0.1 web UI: local and OIDC login, projects, secrets with audited reveal, identities, permissions, audit search, and consumers.
> **Status**: Done
> **Created**: 2026-11-06 11:00
> **Completed**: 2026-11-06 15:00
> **Preflight**: [00-preflight-report.md](00-preflight-report.md)
> **Implements**: openvault-v0-1/RD-12
> **CodeOps Artifact Schema**: 1

## Overview

Every browser API RD-12 needs already exists: RD-03 issued the cookie session, CSRF token, local login, OIDC redirect, and password change; RD-06 issued the policy catalog, assignments, and access explanation; RD-07 issued audit query and verification; RD-08 issued projects and secrets; RD-10 issued consumer metadata and the scaffold endpoint. The web app is still a single proof-of-concept card that links to `/v1/ready`.

This plan replaces that card with the real minimal UI. It keeps the browser as a thin, strongly typed client over the existing API: no new authorization math, no second design system, no client-side secret storage. The server gains a generated browser contract, the `sub` compatibility field the BlendSDK auth provider expects, and production static serving with a restrictive CSP and SPA fallback.

The plan does not pull in certificates, rotation, settings, registration, or a second locale. Those remain out of scope for v0.1.

## Minimum-Sufficient Baseline

**Original goal:** Give an operator a usable browser surface for the common flows while keeping the CLI as the automation and incident surface.

**Smallest viable design:** One React 19 app inside the existing `apps/web` package, using Fluent UI v9, `@blendsdk/fluentui-react-components`, `blendsdk/react`, the generated `blendsdk/api-client`, and React Router 7. The server serves the built SPA with `staticFilesPlugin` and updates CSP only when the UI is enabled. No new data store, no new state library, no new server product routes.

**Excluded machinery:** A second component library, a global state library, a client-side policy engine, certificate screens, a rotation wizard, settings, registration, password reset, rich secret editing, file upload, and additional locales. Playwright browser automation belongs to RD-14; RD-12 proves WCAG behavior with Vitest/jsdom and axe.

**Approved complexity:** One generated browser client, one optional static-serving plugin, one optional `sub` alias field, and one new dev dependency for axe. Each is required by an RD-12 Must Have or by the stack the requirement names.

## Document Index

| # | Document | Description |
|---|---|---|
| AR | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions and provenance |
| PF | [Preflight Report](00-preflight-report.md) | Codebase-grounded audit and resolutions |
| 00 | [Index](00-index.md) | This document — overview and navigation |
| 01 | [Requirements](01-requirements.md) | Thin delta view of RD-12 |
| 02 | [Current State](02-current-state.md) | Existing API, auth, contracts, and gaps |
| 03-01 | [UI Architecture](03-01-ui-architecture.md) | Providers, client, routing, theming, layout, state |
| 03-02 | [Server Serving and Contract](03-02-server-serving-contract.md) | Static serving, CSP, browser contract generation |
| 03-03 | [Screens](03-03-screens.md) | Login, projects, secrets, identities, permissions, audit, consumers |
| 07 | [Testing Strategy](07-testing-strategy.md) | Specification cases, accessibility, and verification |
| 05 | [Findings Ledger](05-findings.md) | Post-phase review rulings |
| 99 | [Execution Plan](99-execution-plan.md) | Phases, sessions, and task checklist |

## Quick Reference

### Run the UI in development

```bash
pnpm --filter @openvault/web dev
# http://localhost:5173, proxied to https://localhost:8443
```

The proxy rewrites the browser `Origin` to the configured `OPENVAULT_BASE_URL` so the server's origin guard accepts local mutations.

### Run the production build

```bash
pnpm --filter @openvault/web build
pnpm --filter @openvault/server start
```

The server serves `apps/web/dist` at `/` with a terminal SPA fallback. API routes always win. The UI is served only when the build directory exists.

### Key invariants

- No secret value is written to `localStorage`, `sessionStorage`, IndexedDB, JavaScript cookies, the URL, or logs.
- Every unsafe request carries `X-CSRF-Token` from the live session.
- Capability flags come from the server; the UI hides actions but never decides access.
- The UI is fully keyboard operable and announces errors with `role="alert"`.
